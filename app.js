// ─── Configuration ──────────────────────────────────────────────────────────
const COORD_SCALE_X       = 2.0;
const COORD_SCALE_Y       = 3.0;
const CA_MAX              = 3.5;
const CA_LERP             = 0.07;
const PALM_FLIP_COOLDOWN  = 400;
const PALM_HYSTERESIS     = 0.005;
const HAND_LERP           = 0.15;
const IMAGE_PATH          = "images/test-1.jpg";

const PINCH_THRESHOLD      = 0.09;
const SPREAD_SENSITIVITY   = 1.8;

// Ghost hand config
const GHOST_SCALE = 0.5;
const GHOST_SEGMENTS = [
  [0, 1, 12], [1, 2, 11], [2, 3, 9], [3, 4, 7],
  [0, 5, 12], [5, 6, 10], [6, 7, 8], [7, 8, 6],
  [5, 9, 11], [9, 10, 10], [10, 11, 8], [11, 12, 6],
  [9, 13, 10], [13, 14, 9], [14, 15, 7], [15, 16, 5],
  [13, 17, 10], [0, 17, 12], [17, 18, 8], [18, 19, 6], [19, 20, 5],
];
const PALM_INDICES = [0, 1, 5, 9, 13, 17];

const EL_BASE_OFFSETS = [
  { x: -210, y: -140 },
  { x:  230, y:  -70 },
  { x: -170, y:  150 },
  { x:   50, y: -180 },
  { x:  190, y:  140 },
];

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

const ctrlRadius   = document.getElementById("ctrl-radius");
const ctrlStrength = document.getElementById("ctrl-strength");
const ctrlFalloff  = document.getElementById("ctrl-falloff");
const valRadius    = document.getElementById("val-radius");
const valStrength  = document.getElementById("val-strength");
const valFalloff   = document.getElementById("val-falloff");

const elDoms = document.querySelectorAll(".floating-el");

const ghostCanvas = document.getElementById("ghost-canvas");
const ghostCtx    = ghostCanvas.getContext("2d");
const ctrlGhost   = document.getElementById("ctrl-ghost");
let ghostHandsEnabled = true;

ctrlGhost.addEventListener("change", () => {
  ghostHandsEnabled = ctrlGhost.checked;
  if (!ghostHandsEnabled) ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
});

window.enableGhostHands  = () => { ghostHandsEnabled = true;  ctrlGhost.checked = true; };
window.disableGhostHands = () => {
  ghostHandsEnabled = false;
  ctrlGhost.checked = false;
  ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
};

// Bulge params from sliders
let bulgeRadius   = parseFloat(ctrlRadius.value);
let bulgeStrength = parseFloat(ctrlStrength.value);
let bulgeFalloff  = parseFloat(ctrlFalloff.value);

ctrlRadius.addEventListener("input", () => {
  bulgeRadius = parseFloat(ctrlRadius.value);
  valRadius.textContent = bulgeRadius.toFixed(2);
});
ctrlStrength.addEventListener("input", () => {
  bulgeStrength = parseFloat(ctrlStrength.value);
  valStrength.textContent = bulgeStrength.toFixed(2);
});
ctrlFalloff.addEventListener("input", () => {
  bulgeFalloff = parseFloat(ctrlFalloff.value);
  valFalloff.textContent = bulgeFalloff.toFixed(1);
});

// GSAP: set panel off-screen, position floating els at their default offsets
gsap.set(panel, { xPercent: 100 });
elDoms.forEach((el, i) => {
  const off = EL_BASE_OFFSETS[i];
  gsap.set(el, { xPercent: -50, yPercent: -50, x: off.x, y: off.y });
});

// ─── State ──────────────────────────────────────────────────────────────────
const filterRX = new OneEuroFilter(30, 0.35, 0.7, 1.0);
const filterRY = new OneEuroFilter(30, 0.35, 0.7, 1.0);
let rightX = 0.5, rightY = 0.5;
let smoothHandX = 0.5, smoothHandY = 0.5;
let rightDetected = false;

const filterLY = new OneEuroFilter(30, 0.2, 0.1, 1.0);
let leftY = 0.5;
let leftDetected = false;

let targetCA = 0;
let currentCA = 0;

let palmCrossSmooth = 0;
let palmState = "unknown";
let lastPalmFlipTime = 0;

let panelOpen = false;

// Bi-manual pinch state
let rightHandLm = null;
let leftHandLm  = null;
let bothPinching = false;
let pinchStartDist  = 0;
let pinchStartAngle = 0;
let lastSpread = 1.0;
let lastRotAngle = 0;

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
  uniform vec2  u_resolution;
  uniform vec2  u_imageSize;
  uniform float u_caIntensity;
  uniform vec2  u_hand;
  uniform float u_handActive;
  uniform float u_bulgeRadius;
  uniform float u_bulgeStrength;
  uniform float u_bulgeFalloff;

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

    if (u_handActive > 0.5) {
      vec2 diff = uv - u_hand;
      vec2 corrDiff = vec2(diff.x * ar, diff.y);
      float dist = length(corrDiff);

      if (dist < u_bulgeRadius) {
        float t = dist / u_bulgeRadius;
        float falloff = pow(1.0 - t, u_bulgeFalloff);
        uv -= diff * falloff * u_bulgeStrength;
      }
    }

    if (u_caIntensity > 0.01) {
      vec2 fromCenter = uv - 0.5;
      float dist = length(fromCenter);
      vec2 caDir = dist > 0.001 ? normalize(fromCenter) : vec2(0.0);
      float caOff = u_caIntensity * 0.005 * dist * 2.0;

      vec2 uvR = coverUV(uv + caDir * caOff, u_resolution, u_imageSize);
      vec2 uvG = coverUV(uv,                  u_resolution, u_imageSize);
      vec2 uvB = coverUV(uv - caDir * caOff, u_resolution, u_imageSize);

      gl_FragColor = vec4(
        texture2D(u_image, clamp(uvR, vec2(0.0), vec2(1.0))).r,
        texture2D(u_image, clamp(uvG, vec2(0.0), vec2(1.0))).g,
        texture2D(u_image, clamp(uvB, vec2(0.0), vec2(1.0))).b,
        1.0
      );
    } else {
      vec2 imgUV = coverUV(uv, u_resolution, u_imageSize);
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

const uResolution    = gl.getUniformLocation(program, "u_resolution");
const uImageSize     = gl.getUniformLocation(program, "u_imageSize");
const uCAIntensity   = gl.getUniformLocation(program, "u_caIntensity");
const uHand          = gl.getUniformLocation(program, "u_hand");
const uHandActive    = gl.getUniformLocation(program, "u_handActive");
const uBulgeRadius   = gl.getUniformLocation(program, "u_bulgeRadius");
const uBulgeStrength = gl.getUniformLocation(program, "u_bulgeStrength");
const uBulgeFalloff  = gl.getUniformLocation(program, "u_bulgeFalloff");
const uImageLoc      = gl.getUniformLocation(program, "u_image");

// ─── Texture ────────────────────────────────────────────────────────────────
const imageTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, imageTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

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

  ghostCanvas.width  = window.innerWidth;
  ghostCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

// ─── Render loop ────────────────────────────────────────────────────────────
function render() {
  currentCA += (targetCA - currentCA) * CA_LERP;

  smoothHandX += (rightX - smoothHandX) * HAND_LERP;
  smoothHandY += (rightY - smoothHandY) * HAND_LERP;

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTex);

  gl.uniform1i(uImageLoc, 0);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uCAIntensity, currentCA);
  gl.uniform2f(uHand, smoothHandX, smoothHandY);
  gl.uniform1f(uHandActive, rightDetected ? 1.0 : 0.0);
  gl.uniform1f(uBulgeRadius, bulgeRadius);
  gl.uniform1f(uBulgeStrength, bulgeStrength);
  gl.uniform1f(uBulgeFalloff, bulgeFalloff);

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
  palmCrossSmooth = palmCrossSmooth * 0.3 + cross * 0.7;

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

// ─── Pinch helpers ──────────────────────────────────────────────────────────
function getPinchDist(lm) {
  const dx = lm[4].x - lm[8].x;
  const dy = lm[4].y - lm[8].y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getPinchMid(lm) {
  return {
    x: (lm[4].x + lm[8].x) / 2,
    y: (lm[4].y + lm[8].y) / 2,
  };
}

// ─── Bi-manual pinch-spread gesture (GSAP-driven) ──────────────────────────
function processBimanualPinch() {
  if (!rightHandLm || !leftHandLm) {
    if (bothPinching) {
      bothPinching = false;
      bounceElementsBack();
    }
    return;
  }

  const rPinch = getPinchDist(rightHandLm) < PINCH_THRESHOLD;
  const lPinch = getPinchDist(leftHandLm)  < PINCH_THRESHOLD;

  if (rPinch && lPinch) {
    const rMid = getPinchMid(rightHandLm);
    const lMid = getPinchMid(leftHandLm);

    const dx = rMid.x - lMid.x;
    const dy = rMid.y - lMid.y;
    const dist  = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    if (!bothPinching) {
      bothPinching    = true;
      pinchStartDist  = Math.max(dist, 0.01);
      pinchStartAngle = angle;
      lastSpread   = 1.0;
      lastRotAngle = 0;
      elDoms.forEach(el => gsap.killTweensOf(el));
    }

    const rawRatio = dist / pinchStartDist;
    const spread   = Math.max(0.15, 1 + (rawRatio - 1) * SPREAD_SENSITIVITY);
    const rot      = angle - pinchStartAngle;

    if (Math.abs(spread - lastSpread) > 0.01 || Math.abs(rot - lastRotAngle) > 0.01) {
      lastSpread   = spread;
      lastRotAngle = rot;

      const cos = Math.cos(rot);
      const sin = Math.sin(rot);

      elDoms.forEach((el, i) => {
        const base = EL_BASE_OFFSETS[i];
        const sx = base.x * spread;
        const sy = base.y * spread;
        gsap.to(el, {
          x: sx * cos - sy * sin,
          y: sx * sin + sy * cos,
          duration: 0.25,
          ease: "power2.out",
          overwrite: true,
        });
      });
    }
  } else if (bothPinching) {
    bothPinching = false;
    bounceElementsBack();
  }
}

function bounceElementsBack() {
  lastSpread   = 1.0;
  lastRotAngle = 0;

  elDoms.forEach((el, i) => {
    const base = EL_BASE_OFFSETS[i];
    gsap.to(el, {
      x: base.x,
      y: base.y,
      duration: 0.9,
      ease: "elastic.out(1, 0.4)",
      overwrite: true,
    });
  });
}

// ─── Ghost Hand Drawing (compact, soft, 2-pass) ────────────────────────────
function drawGhostHand(ctx, landmarks, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const pts = landmarks.map(p => {
    const rawX = (1 - p.x) * w;
    const rawY = p.y * h;
    return {
      x: cx + (rawX - cx) * GHOST_SCALE,
      y: cy + (rawY - cy) * GHOST_SCALE,
    };
  });

  // === Pass 1: Soft glow halo ===
  ctx.save();
  ctx.shadowColor = "rgba(190, 220, 255, 0.35)";
  ctx.shadowBlur = 18;
  ctx.globalAlpha = 0.7;

  ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
  ctx.beginPath();
  ctx.moveTo(pts[PALM_INDICES[0]].x, pts[PALM_INDICES[0]].y);
  for (let i = 1; i < PALM_INDICES.length; i++) {
    ctx.lineTo(pts[PALM_INDICES[i]].x, pts[PALM_INDICES[i]].y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [a, b, baseW] of GHOST_SEGMENTS) {
    ctx.lineWidth = baseW + 8;
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }
  ctx.restore();

  // === Pass 2: Core shape ===
  ctx.save();
  ctx.shadowColor = "rgba(220, 235, 255, 0.25)";
  ctx.shadowBlur = 8;

  ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
  ctx.beginPath();
  ctx.moveTo(pts[PALM_INDICES[0]].x, pts[PALM_INDICES[0]].y);
  for (let i = 1; i < PALM_INDICES.length; i++) {
    ctx.lineTo(pts[PALM_INDICES[i]].x, pts[PALM_INDICES[i]].y);
  }
  ctx.closePath();
  ctx.fill();

  const palmTris = [[0,5,9],[0,9,13],[0,13,17],[0,1,5]];
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  for (const [a, b, c] of palmTris) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.lineTo(pts[c].x, pts[c].y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [a, b, baseW] of GHOST_SEGMENTS) {
    ctx.lineWidth = baseW;
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }
  ctx.restore();
}

function renderGhostHands(allLandmarks) {
  const w = ghostCanvas.width;
  const h = ghostCanvas.height;
  ghostCtx.clearRect(0, 0, w, h);

  if (!ghostHandsEnabled || !allLandmarks || allLandmarks.length === 0) return;

  for (const lm of allLandmarks) {
    drawGhostHand(ghostCtx, lm, w, h);
  }
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
    modelComplexity: 0,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.45,
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
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.save();
  debugCtx.translate(debugCanvas.width, 0);
  debugCtx.scale(-1, 1);
  debugCtx.drawImage(results.image, 0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.restore();

  const landmarks = results.multiHandLandmarks;
  const handedness = results.multiHandedness;

  rightHandLm = null;
  leftHandLm  = null;

  // Draw ghost hands (uses raw landmarks before any processing)
  renderGhostHands(landmarks);

  if (!landmarks || landmarks.length === 0) {
    rightDetected = false;
    leftDetected = false;
    handCursor.classList.remove("visible");
    targetCA *= 0.92;
    if (bothPinching) {
      bothPinching = false;
      bounceElementsBack();
    }
    return;
  }

  const now = performance.now();
  let foundRight = false;
  let foundLeft = false;

  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    const mpLabel = handedness[i]?.label;

    const isUserRight = mpLabel === "Left";
    const isUserLeft  = mpLabel === "Right";

    if (isUserRight && !foundRight) {
      foundRight = true;
      rightDetected = true;
      rightHandLm = lm;

      const rawX = remapX(1 - lm[8].x);
      const rawY = remapY(lm[8].y);
      rightX = filterRX.filter(rawX, now);
      rightY = filterRY.filter(rawY, now);

      handCursor.style.left = `${rightX * 100}%`;
      handCursor.style.top  = `${rightY * 100}%`;
      handCursor.classList.add("visible");

      checkPalmFlip(lm, now);

      debugCtx.fillStyle = "rgba(160,224,255,0.9)";
      for (const p of lm) {
        debugCtx.beginPath();
        debugCtx.arc((1 - p.x) * debugCanvas.width, p.y * debugCanvas.height, 2, 0, Math.PI * 2);
        debugCtx.fill();
      }
    }

    if (isUserLeft && !foundLeft) {
      foundLeft = true;
      leftDetected = true;
      leftHandLm = lm;

      const rawY = remapY(lm[8].y);
      leftY = filterLY.filter(rawY, now);

      targetCA = Math.max(0, 1 - leftY) * CA_MAX;

      debugCtx.fillStyle = "rgba(255,180,100,0.9)";
      for (const p of lm) {
        debugCtx.beginPath();
        debugCtx.arc((1 - p.x) * debugCanvas.width, p.y * debugCanvas.height, 2, 0, Math.PI * 2);
        debugCtx.fill();
      }
    }
  }

  if (!foundRight) {
    rightDetected = false;
    handCursor.classList.remove("visible");
  }
  if (!foundLeft) {
    leftDetected = false;
    targetCA *= 0.92;
  }

  // Process bi-manual pinch gesture
  processBimanualPinch();

  // Debug HUD
  debugCtx.fillStyle = "rgba(0,0,0,0.55)";
  debugCtx.fillRect(0, 0, debugCanvas.width, 18);
  debugCtx.fillStyle = "#fff";
  debugCtx.font = "10px monospace";
  let hud = "";
  if (rightDetected) hud += "R:bulge ";
  if (leftDetected) hud += `L:CA=${currentCA.toFixed(1)} `;
  if (bothPinching) hud += `spread:${lastSpread.toFixed(2)} `;
  if (palmState !== "unknown") hud += `palm:${palmState.charAt(0)}`;
  debugCtx.fillText(hud, 4, 12);
}

// ─── Panel toggle (GSAP — power4.out, 600ms) ───────────────────────────────
function togglePanel() {
  panelOpen = !panelOpen;

  if (panelOpen) {
    gsap.to(panel, { xPercent: 0, duration: 0.6, ease: "power4.out" });
    gsap.to(hamburger.children[0], { y: 17, rotation: 45, duration: 0.6, ease: "power4.out" });
    gsap.to(hamburger.children[1], { opacity: 0, duration: 0.25 });
    gsap.to(hamburger.children[2], { y: -17, rotation: -45, duration: 0.6, ease: "power4.out" });
  } else {
    gsap.to(panel, { xPercent: 100, duration: 0.6, ease: "power4.out" });
    gsap.to(hamburger.children[0], { y: 0, rotation: 0, duration: 0.6, ease: "power4.out" });
    gsap.to(hamburger.children[1], { opacity: 1, duration: 0.25, delay: 0.15 });
    gsap.to(hamburger.children[2], { y: 0, rotation: 0, duration: 0.6, ease: "power4.out" });
  }
}

hamburger.addEventListener("click", togglePanel);
