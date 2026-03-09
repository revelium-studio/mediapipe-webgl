// ─── Configuration ──────────────────────────────────────────────────────────
const COORD_SCALE_X       = 2.0;
const COORD_SCALE_Y       = 3.0;
const PIXEL_SCALE_BASE    = 0.025;    // base pixelation when right hand moves
const PIXEL_SCALE_RANGE   = 0.10;     // extra pixelation range from left hand
const CA_MAX              = 3.5;      // max chromatic aberration from left hand
const CA_LERP             = 0.07;
const TRAIL_FADE          = 0.025;
const TRAIL_RADIUS        = 48;
const MOVE_THRESHOLD      = 0.003;    // min velocity to paint trail
const PALM_FLIP_COOLDOWN  = 1200;
const PALM_HYSTERESIS     = 0.008;
const IMAGE_PATH          = "images/test-1.jpg";

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
const cameraOverlay = document.getElementById("camera-overlay");
const enableBtn     = document.getElementById("enable-camera-btn");

// ─── State ──────────────────────────────────────────────────────────────────
// Right hand (user's physical right) — pixelation trail + palm flip
const filterRX = new OneEuroFilter(30, 0.35, 0.7, 1.0);
const filterRY = new OneEuroFilter(30, 0.35, 0.7, 1.0);
let rightX = 0.5, rightY = 0.5;
let prevRightX = 0.5, prevRightY = 0.5;
let rightDetected = false;

// Left hand (user's physical left) — effect intensity control
const filterLY = new OneEuroFilter(30, 0.2, 0.1, 1.0);
let leftY = 0.5;
let leftDetected = false;

// Effect intensity driven by left hand (0 to 1)
let targetIntensity = 0;
let currentIntensity = 0;

// CA
let targetCA = 0;
let currentCA = 0;

// Palm flip state (for menu toggle)
let palmCrossSmooth = 0;
let palmState = "unknown";
let lastPalmFlipTime = 0;

let panelOpen = false;

// ─── Trail canvas ──────────────────────────────────────────────────────────
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

    // Trail controls where pixelation appears (0 = clean, >0 = pixelated)
    float trail = texture2D(u_trail, uv).r;

    vec2 sampleUV = uv;
    if (trail > 0.01 && u_pixelScale > 0.001) {
      float cellSize = trail * u_pixelScale + 0.001;
      vec2 grid = vec2(uv.x * ar, uv.y);
      vec2 modCoord = mod(grid, cellSize);
      sampleUV = vec2(
        uv.x - modCoord.x / ar + cellSize / (2.0 * ar),
        uv.y - modCoord.y + cellSize / 2.0
      );
    }

    // Chromatic aberration (radial from center, intensity from left hand)
    if (u_caIntensity > 0.01) {
      vec2 fromCenter = sampleUV - 0.5;
      float dist = length(fromCenter);
      vec2 caDir = dist > 0.001 ? normalize(fromCenter) : vec2(0.0);
      float caOff = u_caIntensity * 0.005 * dist * 2.0;

      vec2 uvR = coverUV(sampleUV + caDir * caOff, u_resolution, u_imageSize);
      vec2 uvG = coverUV(sampleUV,                  u_resolution, u_imageSize);
      vec2 uvB = coverUV(sampleUV - caDir * caOff, u_resolution, u_imageSize);

      gl_FragColor = vec4(
        texture2D(u_image, clamp(uvR, vec2(0.0), vec2(1.0))).r,
        texture2D(u_image, clamp(uvG, vec2(0.0), vec2(1.0))).g,
        texture2D(u_image, clamp(uvB, vec2(0.0), vec2(1.0))).b,
        1.0
      );
    } else {
      vec2 imgUV = coverUV(sampleUV, u_resolution, u_imageSize);
      gl_FragColor = texture2D(u_image, clamp(imgUV, vec2(0.0), vec2(1.0)));
    }
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
  // Smooth CA + intensity
  currentCA += (targetCA - currentCA) * CA_LERP;
  currentIntensity += (targetIntensity - currentIntensity) * CA_LERP;

  // Compute effective pixel scale
  const effectivePixelScale = PIXEL_SCALE_BASE + currentIntensity * PIXEL_SCALE_RANGE;

  // Fade trail
  trailCtx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
  trailCtx.fillRect(0, 0, 512, 512);

  // Paint trail at right hand position only when hand is moving
  if (rightDetected) {
    const vx = rightX - prevRightX;
    const vy = rightY - prevRightY;
    const speed = Math.sqrt(vx * vx + vy * vy);

    if (speed > MOVE_THRESHOLD) {
      const tx = rightX * 512;
      const ty = rightY * 512;
      const intensity = Math.min(speed * 15, 1.0);
      const grad = trailCtx.createRadialGradient(tx, ty, 0, tx, ty, TRAIL_RADIUS);
      grad.addColorStop(0, `rgba(255, 255, 255, ${0.5 * intensity})`);
      grad.addColorStop(0.6, `rgba(255, 255, 255, ${0.2 * intensity})`);
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      trailCtx.fillStyle = grad;
      trailCtx.beginPath();
      trailCtx.arc(tx, ty, TRAIL_RADIUS, 0, Math.PI * 2);
      trailCtx.fill();
    }
  }
  prevRightX = rightX;
  prevRightY = rightY;

  // Upload trail texture
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, trailTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, trailCanvas);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTex);

  gl.uniform1i(uImageLoc, 0);
  gl.uniform1i(uTrailLoc, 1);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uCAIntensity, currentCA);
  gl.uniform1f(uPixelScale, effectivePixelScale);

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

// ─── Hand classification by screen position ─────────────────────────────────
// More reliable than MediaPipe's handedness labels in selfie mode
function classifyHands(landmarks) {
  const result = { right: null, left: null };
  if (!landmarks || landmarks.length === 0) return result;

  if (landmarks.length === 1) {
    const mirroredX = 1 - landmarks[0][0].x;
    if (mirroredX > 0.5) {
      result.right = landmarks[0];
    } else {
      result.left = landmarks[0];
    }
  } else {
    const x0 = 1 - landmarks[0][0].x;
    const x1 = 1 - landmarks[1][0].x;
    if (x0 > x1) {
      result.right = landmarks[0];
      result.left  = landmarks[1];
    } else {
      result.right = landmarks[1];
      result.left  = landmarks[0];
    }
  }
  return result;
}

// ─── Palm flip detection ────────────────────────────────────────────────────
function getPalmCross(lm) {
  const v1x = lm[5].x - lm[0].x;
  const v1y = lm[5].y - lm[0].y;
  const v2x = lm[17].x - lm[0].x;
  const v2y = lm[17].y - lm[0].y;
  return v1x * v2y - v1y * v2x;
}

function checkPalmFlip(lm, now) {
  const cross = getPalmCross(lm);
  palmCrossSmooth = palmCrossSmooth * 0.6 + cross * 0.4;

  let newState = palmState;
  if (palmCrossSmooth > PALM_HYSTERESIS) {
    newState = "positive";
  } else if (palmCrossSmooth < -PALM_HYSTERESIS) {
    newState = "negative";
  }

  if (
    palmState !== "unknown" &&
    newState !== palmState &&
    newState !== "unknown" &&
    now - lastPalmFlipTime > PALM_FLIP_COOLDOWN
  ) {
    lastPalmFlipTime = now;
    togglePanel();
  }

  palmState = newState;
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

  if (!landmarks || landmarks.length === 0) {
    rightDetected = false;
    leftDetected = false;
    handCursor.classList.remove("visible");
    targetCA *= 0.92;
    targetIntensity *= 0.92;
    return;
  }

  const hands = classifyHands(landmarks);
  const now = performance.now();

  // ── RIGHT HAND: pixelation trail + palm flip for menu ──────────────────
  if (hands.right) {
    rightDetected = true;
    const lm = hands.right;

    const rawX = remapX(1 - lm[8].x);
    const rawY = remapY(lm[8].y);
    rightX = filterRX.filter(rawX, now);
    rightY = filterRY.filter(rawY, now);

    handCursor.style.left = `${rightX * 100}%`;
    handCursor.style.top  = `${rightY * 100}%`;
    handCursor.classList.add("visible");

    checkPalmFlip(lm, now);

    // Debug landmarks
    debugCtx.fillStyle = "rgba(160,224,255,0.9)";
    for (const p of lm) {
      debugCtx.beginPath();
      debugCtx.arc((1 - p.x) * debugCanvas.width, p.y * debugCanvas.height, 2, 0, Math.PI * 2);
      debugCtx.fill();
    }
  } else {
    rightDetected = false;
    handCursor.classList.remove("visible");
  }

  // ── LEFT HAND: effect intensity (pixelation scale + CA) ────────────────
  if (hands.left) {
    leftDetected = true;
    const lm = hands.left;

    const rawY = remapY(lm[8].y);
    leftY = filterLY.filter(rawY, now);

    // Hand high = strong effect, hand low = no effect
    const intensity = Math.max(0, 1 - leftY);
    targetIntensity = intensity;
    targetCA = intensity * CA_MAX;

    // Debug landmarks
    debugCtx.fillStyle = "rgba(255,180,100,0.9)";
    for (const p of lm) {
      debugCtx.beginPath();
      debugCtx.arc((1 - p.x) * debugCanvas.width, p.y * debugCanvas.height, 2, 0, Math.PI * 2);
      debugCtx.fill();
    }
  } else {
    leftDetected = false;
    targetCA *= 0.92;
    targetIntensity *= 0.92;
  }

  // Debug HUD
  debugCtx.fillStyle = "rgba(0,0,0,0.55)";
  debugCtx.fillRect(0, 0, debugCanvas.width, 18);
  debugCtx.fillStyle = "#fff";
  debugCtx.font = "10px monospace";
  let hud = "";
  if (rightDetected) hud += "R ";
  if (leftDetected) hud += `L CA:${currentCA.toFixed(1)} PX:${(PIXEL_SCALE_BASE + currentIntensity * PIXEL_SCALE_RANGE).toFixed(3)} `;
  if (palmState !== "unknown") hud += `PALM:${palmState.charAt(0)} `;
  debugCtx.fillText(hud, 4, 12);
}

// ─── Panel toggle ───────────────────────────────────────────────────────────
function togglePanel() {
  panelOpen = !panelOpen;
  panel.classList.toggle("open", panelOpen);
  hamburger.classList.toggle("open", panelOpen);
}

hamburger.addEventListener("click", togglePanel);
