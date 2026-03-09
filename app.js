// ─── Configuration ──────────────────────────────────────────────────────────
const PINCH_THRESHOLD    = 0.08;
const PINCH_COOLDOWN     = 500;
const BLUR_RADIUS        = 0.32;
const BLUR_STRENGTH      = 0.035;
const COORD_SCALE        = 1.7;       // expands small hand movements to full screen
const IMAGE_PATH         = "images/test-1.jpg";
const CA_ROTATION_GAIN   = 4.0;
const CA_MAX             = 6.0;
const CA_DECAY           = 0.97;

// ─── One Euro Filter ───────────────────────────────────────────────────────
// Adaptive low-pass: smooth when still, responsive when fast
class OneEuroFilter {
  constructor(freq = 30, minCutoff = 0.8, beta = 0.4, dCutoff = 1.0) {
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
const filterX = new OneEuroFilter();
const filterY = new OneEuroFilter();
let smoothX = 0.5, smoothY = 0.5;
let isPinching = false;
let lastPinchTime = 0;
let panelOpen = false;
let handDetected = false;
let hoveringHamburger = false;
let hoverFrames = 0;

// Two-hand rotation state
let globalCA = 0;
let prevRotAngle = null;
let twoHandsThisFrame = false;

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
  uniform vec2  u_hand;
  uniform float u_radius;
  uniform float u_strength;
  uniform float u_time;
  uniform vec2  u_resolution;
  uniform vec2  u_imageSize;
  uniform float u_handActive;
  uniform float u_globalCA;

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

    // Per-hand blur
    float blurAmt = 0.0;
    vec2 blurDir = vec2(1.0, 0.0);

    if (u_handActive > 0.5) {
      vec2 diff = uv - u_hand;
      vec2 corrDiff = vec2(diff.x * ar, diff.y);
      float dist = length(corrDiff);
      float normDist = dist / (u_radius * max(ar, 1.0));

      if (normDist < 1.0) {
        float falloff = 1.0 - normDist;
        falloff = falloff * falloff * falloff;
        blurAmt = falloff * u_strength;
        blurDir = length(diff) > 0.001 ? normalize(diff) : vec2(1.0, 0.0);
      }
    }

    // Chromatic aberration direction: radial from hand (local) or center (global)
    vec2 caDir;
    if (u_handActive > 0.5 && blurAmt > 0.001) {
      caDir = blurDir;
    } else {
      caDir = length(uv - 0.5) > 0.001 ? normalize(uv - 0.5) : vec2(1.0, 0.0);
    }

    float localCA = blurAmt * 2.0;
    float totalCA = localCA + u_globalCA * 0.012;

    // Directional blur + chromatic aberration (8-tap box blur)
    vec3 color = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float t = (float(i) / 7.0 - 0.5) * 2.0;
      vec2 offset = blurDir * t * blurAmt;

      vec2 caOff = caDir * totalCA;

      vec2 uvR = coverUV(uv + offset + caOff, u_resolution, u_imageSize);
      vec2 uvG = coverUV(uv + offset,          u_resolution, u_imageSize);
      vec2 uvB = coverUV(uv + offset - caOff, u_resolution, u_imageSize);

      color.r += texture2D(u_image, clamp(uvR, vec2(0.0), vec2(1.0))).r;
      color.g += texture2D(u_image, clamp(uvG, vec2(0.0), vec2(1.0))).g;
      color.b += texture2D(u_image, clamp(uvB, vec2(0.0), vec2(1.0))).b;
    }
    color /= 8.0;

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

const uHand       = gl.getUniformLocation(program, "u_hand");
const uRadius     = gl.getUniformLocation(program, "u_radius");
const uStrength   = gl.getUniformLocation(program, "u_strength");
const uTime       = gl.getUniformLocation(program, "u_time");
const uResolution = gl.getUniformLocation(program, "u_resolution");
const uImageSize  = gl.getUniformLocation(program, "u_imageSize");
const uHandActive = gl.getUniformLocation(program, "u_handActive");
const uGlobalCA   = gl.getUniformLocation(program, "u_globalCA");

// Texture
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

let imgW = 1, imgH = 1;
const img = new Image();
img.onload = () => {
  imgW = img.width;
  imgH = img.height;
  gl.bindTexture(gl.TEXTURE_2D, tex);
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
const t0 = performance.now();

function render() {
  // Decay global CA when two hands aren't actively rotating
  if (!twoHandsThisFrame) {
    globalCA *= CA_DECAY;
    if (globalCA < 0.001) globalCA = 0;
    prevRotAngle = null;
  }
  twoHandsThisFrame = false;

  gl.uniform2f(uHand, smoothX, smoothY);
  gl.uniform1f(uRadius, BLUR_RADIUS);
  gl.uniform1f(uStrength, BLUR_STRENGTH);
  gl.uniform1f(uTime, (performance.now() - t0) / 1000);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uHandActive, handDetected ? 1.0 : 0.0);
  gl.uniform1f(uGlobalCA, globalCA);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(render);
}
render();

// ─── Coordinate remapping ───────────────────────────────────────────────────
function remap(v) {
  return Math.max(0, Math.min(1, (v - 0.5) * COORD_SCALE + 0.5));
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
    minDetectionConfidence: 0.65,
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
    handDetected = false;
    handCursor.classList.remove("visible");
    hoveringHamburger = false;
    hoverFrames = 0;
    return;
  }

  // ── Primary hand (first detected) ─────────────────
  handDetected = true;
  const lm = landmarks[0];
  const now = performance.now();

  const rawX = remap(1 - lm[8].x);
  const rawY = remap(lm[8].y);

  smoothX = filterX.filter(rawX, now);
  smoothY = filterY.filter(rawY, now);

  handCursor.style.left = `${smoothX * 100}%`;
  handCursor.style.top  = `${smoothY * 100}%`;
  handCursor.classList.add("visible");

  // Hamburger hover with generous hitbox
  const hRect = hamburger.getBoundingClientRect();
  const screenX = smoothX * window.innerWidth;
  const screenY = smoothY * window.innerHeight;
  const pad = 60;
  const isOverHamburger =
    screenX >= hRect.left - pad &&
    screenX <= hRect.right + pad &&
    screenY >= hRect.top - pad &&
    screenY <= hRect.bottom + pad;

  if (isOverHamburger) {
    hoverFrames++;
  } else {
    hoverFrames = 0;
  }
  hoveringHamburger = hoverFrames >= 2;
  hamburger.classList.toggle("hovered", hoveringHamburger);

  // Pinch detection
  const thumb = lm[4];
  const index = lm[8];
  const dx = thumb.x - index.x;
  const dy = thumb.y - index.y;
  const dz = (thumb.z || 0) - (index.z || 0);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const wasPinching = isPinching;
  isPinching = dist < PINCH_THRESHOLD;
  handCursor.classList.toggle("pinching", isPinching);

  if (isPinching && !wasPinching && now - lastPinchTime > PINCH_COOLDOWN) {
    lastPinchTime = now;
    onPinch(screenX, screenY);
  }

  // ── Two-hand rotation detection ───────────────────
  if (landmarks.length >= 2) {
    const lm2 = landmarks[1];
    const h1x = 1 - lm[8].x;
    const h1y = lm[8].y;
    const h2x = 1 - lm2[8].x;
    const h2y = lm2[8].y;

    const angle = Math.atan2(h2y - h1y, h2x - h1x);

    if (prevRotAngle !== null) {
      let delta = angle - prevRotAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;

      const speed = Math.abs(delta);
      if (speed > 0.005 && speed < 1.5) {
        globalCA += speed * CA_ROTATION_GAIN;
        if (globalCA > CA_MAX) globalCA = CA_MAX;
      }
    }

    prevRotAngle = angle;
    twoHandsThisFrame = true;
  }

  // ── Draw debug landmarks ──────────────────────────
  for (let h = 0; h < landmarks.length; h++) {
    const color = h === 0 ? "rgba(160,224,255,0.9)" : "rgba(255,180,100,0.9)";
    debugCtx.fillStyle = color;
    for (const p of landmarks[h]) {
      const px = (1 - p.x) * debugCanvas.width;
      const py = p.y * debugCanvas.height;
      debugCtx.beginPath();
      debugCtx.arc(px, py, 2, 0, Math.PI * 2);
      debugCtx.fill();
    }
  }

  // Pinch line on primary hand
  const thumbPx = (1 - thumb.x) * debugCanvas.width;
  const thumbPy = thumb.y * debugCanvas.height;
  const indexPx = (1 - index.x) * debugCanvas.width;
  const indexPy = index.y * debugCanvas.height;
  debugCtx.strokeStyle = isPinching
    ? "rgba(255,180,100,0.9)"
    : "rgba(160,224,255,0.4)";
  debugCtx.lineWidth = isPinching ? 2 : 1;
  debugCtx.beginPath();
  debugCtx.moveTo(thumbPx, thumbPy);
  debugCtx.lineTo(indexPx, indexPy);
  debugCtx.stroke();
}

// ─── Pinch action ───────────────────────────────────────────────────────────
function onPinch(x, y) {
  pinchEl.style.left = `${x}px`;
  pinchEl.style.top  = `${y}px`;
  pinchEl.classList.remove("visible");
  void pinchEl.offsetWidth;
  pinchEl.classList.add("visible");
  setTimeout(() => pinchEl.classList.remove("visible"), 600);

  if (hoveringHamburger) {
    togglePanel();
  }
}

// ─── Panel toggle ───────────────────────────────────────────────────────────
function togglePanel() {
  panelOpen = !panelOpen;
  panel.classList.toggle("open", panelOpen);
  hamburger.classList.toggle("open", panelOpen);
}

hamburger.addEventListener("click", togglePanel);
