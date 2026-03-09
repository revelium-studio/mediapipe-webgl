// ─── Configuration ──────────────────────────────────────────────────────────
const PINCH_THRESHOLD    = 0.08;
const COORD_SCALE_X      = 2.0;
const COORD_SCALE_Y      = 3.0;       // high Y scale = no arm raising needed
const PIXEL_SCALE        = 0.08;      // max pixelation cell size
const CA_MAX             = 5.0;
const CA_LERP            = 0.08;      // CA smoothing speed
const TRAIL_FADE         = 0.03;      // lower = longer-lasting trail
const TRAIL_RADIUS       = 50;        // brush size in trail-canvas pixels
const THREE_COOLDOWN     = 1200;      // ms between three-finger triggers
const THREE_HOLD_FRAMES  = 4;         // must hold 3 fingers for N frames
const IMAGE_PATH         = "images/test-1.jpg";

// ─── One Euro Filter ───────────────────────────────────────────────────────
class OneEuroFilter {
  constructor(freq = 30, minCutoff = 0.4, beta = 0.6, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.lastTime = null;
  }

  alpha(cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau * this.freq);
  }

  filter(value, timestamp) {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.lastTime = timestamp;
      return value;
    }
    const dt = Math.max((timestamp - this.lastTime) / 1000, 1e-6);
    this.lastTime = timestamp;
    this.freq = 1 / dt;

    const aDeriv = this.alpha(this.dCutoff);
    this.dx = aDeriv * ((value - this.x) * this.freq) + (1 - aDeriv) * this.dx;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const aVal = this.alpha(cutoff);
    this.x = aVal * value + (1 - aVal) * this.x;
    return this.x;
  }
}

// ─── DOM refs ───────────────────────────────────────────────────────────────
const canvas        = document.getElementById("webgl-canvas");
const video         = document.getElementById("webcam");
const debugCanvas   = document.getElementById("debug-canvas");
const debugCtx      = debugCanvas.getContext("2d");
const hamburger     = document.getElementById("hamburger");
const panel         = document.getElementById("panel");
const handCursor    = document.getElementById("hand-cursor");
const pinchEl       = document.getElementById("pinch-indicator");
const cameraOverlay = document.getElementById("camera-overlay");
const enableBtn     = document.getElementById("enable-camera-btn");

// ─── State ──────────────────────────────────────────────────────────────────
// Right hand — position + pixelation trail
const filterRX = new OneEuroFilter(30, 0.4, 0.6, 1.0);
const filterRY = new OneEuroFilter(30, 0.4, 0.6, 1.0);
let rightX = 0.5, rightY = 0.5;
let rightPinching = false;
let rightDetected = false;

// Left hand — CA control
const filterLY = new OneEuroFilter(30, 0.2, 0.1, 1.0);
let leftY = 0.5;
let leftDetected = false;
let targetCA = 0;
let currentCA = 0;

// Three-finger menu gesture (tracked on right hand)
let threeFingerFrames = 0;
let wasShowingThree = false;
let lastThreeTime = 0;

let panelOpen = false;

// ─── Trail canvas (offscreen — painted each frame, used as WebGL texture) ──
const trailCanvas = document.createElement("canvas");
trailCanvas.width = 512;
trailCanvas.height = 512;
const trailCtx = trailCanvas.getContext("2d");
trailCtx.fillStyle = "#000";
trailCtx.fillRect(0, 0, 512, 512);

// ─── WebGL Setup ────────────────────────────────────────────────────────────
const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
if (!gl) {
  document.body.innerHTML = "<p style='padding:2rem;color:#fff'>WebGL not supported.</p>";
  throw new Error("WebGL not available");
}

const vertSrc = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

const fragSrc = `
  precision highp float;
  varying vec2 v_texCoord;
  uniform sampler2D u_image;
  uniform sampler2D u_trail;
  uniform vec2  u_resolution;
  uniform vec2  u_imageSize;
  uniform float u_caIntensity;
  uniform float u_pixelScale;

  vec2 coverUV(vec2 uv, vec2 canvasRes, vec2 imgRes) {
    float canvasAspect = canvasRes.x / canvasRes.y;
    float imgAspect    = imgRes.x / imgRes.y;
    vec2 scale;
    if (canvasAspect > imgAspect) {
      scale = vec2(1.0, imgAspect / canvasAspect);
    } else {
      scale = vec2(canvasAspect / imgAspect, 1.0);
    }
    return (uv - 0.5) * scale + 0.5;
  }

  void main() {
    vec2 uv = v_texCoord;
    float ar = u_resolution.x / u_resolution.y;

    // Sample trail to get local pixelation intensity
    float trail = texture2D(u_trail, uv).r;

    // Pixelation (from trail)
    vec2 sampleUV = uv;
    if (trail > 0.01) {
      float cellSize = trail * u_pixelScale + 0.001;
      vec2 grid = vec2(uv.x * ar, uv.y);
      vec2 modCoord = mod(grid, cellSize);
      sampleUV = vec2(
        uv.x - modCoord.x / ar + cellSize / (2.0 * ar),
        uv.y - modCoord.y + cellSize / 2.0
      );
    }

    // Chromatic aberration (global, radial from center)
    vec2 fromCenter = sampleUV - 0.5;
    vec2 caDir = length(fromCenter) > 0.001 ? normalize(fromCenter) : vec2(0.0);
    float caOff = u_caIntensity * 0.006 * length(fromCenter) * 2.0;

    vec2 uvR = coverUV(sampleUV + caDir * caOff, u_resolution, u_imageSize);
    vec2 uvG = coverUV(sampleUV,                  u_resolution, u_imageSize);
    vec2 uvB = coverUV(sampleUV - caDir * caOff, u_resolution, u_imageSize);

    vec3 color = vec3(
      texture2D(u_image, clamp(uvR, vec2(0.0), vec2(1.0))).r,
      texture2D(u_image, clamp(uvG, vec2(0.0), vec2(1.0))).g,
      texture2D(u_image, clamp(uvB, vec2(0.0), vec2(1.0))).b
    );

    gl_FragColor = vec4(color, 1.0);
  }
`;

function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

const vertShader = compileShader(vertSrc, gl.VERTEX_SHADER);
const fragShader = compileShader(fragSrc, gl.FRAGMENT_SHADER);
const program    = gl.createProgram();
gl.attachShader(program, vertShader);
gl.attachShader(program, fragShader);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  console.error("Program link error:", gl.getProgramInfoLog(program));
}
gl.useProgram(program);

const quadVerts = new Float32Array([
  -1, -1,  0, 1,
   1, -1,  1, 1,
  -1,  1,  0, 0,
   1,  1,  1, 0,
]);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

const aPos = gl.getAttribLocation(program, "a_position");
const aTex = gl.getAttribLocation(program, "a_texCoord");
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
gl.enableVertexAttribArray(aTex);
gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

const uResolution  = gl.getUniformLocation(program, "u_resolution");
const uImageSize   = gl.getUniformLocation(program, "u_imageSize");
const uCAIntensity = gl.getUniformLocation(program, "u_caIntensity");
const uPixelScale  = gl.getUniformLocation(program, "u_pixelScale");
const uImageLoc    = gl.getUniformLocation(program, "u_image");
const uTrailLoc    = gl.getUniformLocation(program, "u_trail");

// ─── Textures ───────────────────────────────────────────────────────────────
function makeTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

const imageTex = makeTexture();
const trailTex = makeTexture();

// Upload 1x1 black pixel to trail so it's valid before first frame
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, trailTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
  new Uint8Array([0, 0, 0, 255]));

let imgW = 1, imgH = 1;
const img = new Image();
img.onload = () => {
  imgW = img.width;
  imgH = img.height;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
};
img.src = IMAGE_PATH;

// ─── Resize ─────────────────────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = window.innerWidth  * dpr;
  canvas.height = window.innerHeight * dpr;
  gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener("resize", resize);
resize();

// ─── Render loop ────────────────────────────────────────────────────────────
function render() {
  // Smooth CA toward target
  currentCA += (targetCA - currentCA) * CA_LERP;

  // Update trail canvas
  trailCtx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
  trailCtx.fillRect(0, 0, 512, 512);

  if (rightPinching && rightDetected) {
    const tx = rightX * 512;
    const ty = rightY * 512;
    const grad = trailCtx.createRadialGradient(tx, ty, 0, tx, ty, TRAIL_RADIUS);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.6)");
    grad.addColorStop(0.5, "rgba(255, 255, 255, 0.3)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    trailCtx.fillStyle = grad;
    trailCtx.beginPath();
    trailCtx.arc(tx, ty, TRAIL_RADIUS, 0, Math.PI * 2);
    trailCtx.fill();
  }

  // Upload trail canvas as texture
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, trailTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, trailCanvas);

  // Bind image
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTex);

  // Set uniforms
  gl.uniform1i(uImageLoc, 0);
  gl.uniform1i(uTrailLoc, 1);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uCAIntensity, currentCA);
  gl.uniform1f(uPixelScale, PIXEL_SCALE);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(render);
}
render();

// ─── Coordinate remapping ───────────────────────────────────────────────────
function remapX(v) {
  return Math.max(0, Math.min(1, (v - 0.5) * COORD_SCALE_X + 0.5));
}
function remapY(v) {
  return Math.max(0, Math.min(1, (v - 0.5) * COORD_SCALE_Y + 0.5));
}

// ─── Finger extension detection ─────────────────────────────────────────────
function isThreeGesture(lm) {
  const indexExt  = lm[8].y  < lm[6].y;
  const middleExt = lm[12].y < lm[10].y;
  const ringExt   = lm[16].y < lm[14].y;
  const pinkyExt  = lm[20].y < lm[18].y;
  return indexExt && middleExt && ringExt && !pinkyExt;
}

// ─── Camera Permission Flow ────────────────────────────────────────────────
enableBtn.addEventListener("click", startCamera);

async function startCamera() {
  enableBtn.textContent = "Starting…";
  enableBtn.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
    });
    video.srcObject = stream;
    await video.play();
    cameraOverlay.classList.add("hidden");
    initMediaPipe();
  } catch (err) {
    console.error("Camera access denied:", err);
    enableBtn.textContent = "Camera Denied — Retry";
    enableBtn.disabled = false;
  }
}

// ─── MediaPipe Hands ────────────────────────────────────────────────────────
function initMediaPipe() {
  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onHandResults);

  debugCanvas.width  = 200;
  debugCanvas.height = 150;

  const camera = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width: 640,
    height: 480,
  });
  camera.start();
}

// ─── Hand results callback ──────────────────────────────────────────────────
function onHandResults(results) {
  // Debug preview
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.save();
  debugCtx.translate(debugCanvas.width, 0);
  debugCtx.scale(-1, 1);
  debugCtx.drawImage(results.image, 0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.restore();

  const landmarks = results.multiHandLandmarks;
  const handedness = results.multiHandedness;

  if (!landmarks || landmarks.length === 0) {
    rightDetected = false;
    leftDetected = false;
    handCursor.classList.remove("visible");
    targetCA *= 0.95;
    return;
  }

  rightDetected = false;
  leftDetected = false;
  const now = performance.now();
  let anyShowingThree = false;

  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    const label = handedness[i]?.label;

    if (label === "Right") {
      // ── RIGHT HAND: pointer + pixelation trail ──────
      rightDetected = true;

      const rawX = remapX(1 - lm[8].x);
      const rawY = remapY(lm[8].y);
      rightX = filterRX.filter(rawX, now);
      rightY = filterRY.filter(rawY, now);

      // Cursor
      handCursor.style.left = `${rightX * 100}%`;
      handCursor.style.top  = `${rightY * 100}%`;
      handCursor.classList.add("visible");

      // Pinch detection
      const thumb = lm[4];
      const index = lm[8];
      const dx = thumb.x - index.x;
      const dy = thumb.y - index.y;
      const dz = (thumb.z || 0) - (index.z || 0);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      rightPinching = dist < PINCH_THRESHOLD;
      handCursor.classList.toggle("pinching", rightPinching);

      // Three-finger gesture
      if (isThreeGesture(lm)) {
        anyShowingThree = true;
      }
    }

    if (label === "Left") {
      // ── LEFT HAND: chromatic aberration control ─────
      leftDetected = true;

      const rawY = remapY(lm[8].y);
      const smoothedY = filterLY.filter(rawY, now);
      leftY = smoothedY;

      // Hand high → strong CA, hand low → no CA
      targetCA = (1 - leftY) * CA_MAX;
    }

    // Draw debug landmarks
    const color = label === "Right"
      ? "rgba(160,224,255,0.9)"
      : "rgba(255,180,100,0.9)";
    debugCtx.fillStyle = color;
    for (const p of lm) {
      const px = (1 - p.x) * debugCanvas.width;
      const py = p.y * debugCanvas.height;
      debugCtx.beginPath();
      debugCtx.arc(px, py, 2, 0, Math.PI * 2);
      debugCtx.fill();
    }
  }

  // Three-finger state machine (transition-triggered with hold requirement)
  if (anyShowingThree) {
    threeFingerFrames++;
    if (
      threeFingerFrames >= THREE_HOLD_FRAMES &&
      !wasShowingThree &&
      now - lastThreeTime > THREE_COOLDOWN
    ) {
      wasShowingThree = true;
      lastThreeTime = now;
      togglePanel();
    }
  } else {
    threeFingerFrames = 0;
    wasShowingThree = false;
  }

  // Decay CA when left hand absent
  if (!leftDetected) {
    targetCA *= 0.95;
  }

  // Hide cursor when no right hand
  if (!rightDetected) {
    handCursor.classList.remove("visible");
  }

  // Pinch line debug (right hand only)
  if (rightDetected) {
    const idx = landmarks.findIndex((_, j) => handedness[j]?.label === "Right");
    if (idx >= 0) {
      const lm = landmarks[idx];
      const thumb = lm[4];
      const index = lm[8];
      const thumbPx = (1 - thumb.x) * debugCanvas.width;
      const thumbPy = thumb.y * debugCanvas.height;
      const indexPx = (1 - index.x) * debugCanvas.width;
      const indexPy = index.y * debugCanvas.height;
      debugCtx.strokeStyle = rightPinching
        ? "rgba(255,180,100,0.9)"
        : "rgba(160,224,255,0.4)";
      debugCtx.lineWidth = rightPinching ? 2 : 1;
      debugCtx.beginPath();
      debugCtx.moveTo(thumbPx, thumbPy);
      debugCtx.lineTo(indexPx, indexPy);
      debugCtx.stroke();
    }
  }

  // Debug: show CA bar & gesture state
  debugCtx.fillStyle = "rgba(0,0,0,0.5)";
  debugCtx.fillRect(0, 0, debugCanvas.width, 18);
  debugCtx.fillStyle = "#fff";
  debugCtx.font = "10px monospace";
  let status = "";
  if (rightPinching) status += "PINCH ";
  if (anyShowingThree) status += "THREE ";
  if (leftDetected) status += `CA:${currentCA.toFixed(1)} `;
  debugCtx.fillText(status, 4, 12);
}

// ─── Panel toggle ───────────────────────────────────────────────────────────
function togglePanel() {
  panelOpen = !panelOpen;
  panel.classList.toggle("open", panelOpen);
  hamburger.classList.toggle("open", panelOpen);
}

hamburger.addEventListener("click", togglePanel);
