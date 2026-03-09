// ─── Configuration ──────────────────────────────────────────────────────────
const PINCH_THRESHOLD   = 0.07;
const PINCH_COOLDOWN    = 600;
const DISTORTION_RADIUS = 0.28;
const DISTORTION_STRENGTH = 0.05;
const LERP_SPEED        = 0.12;
const IMAGE_PATH        = "images/test-1.jpg";

// ─── DOM refs ───────────────────────────────────────────────────────────────
const canvas       = document.getElementById("webgl-canvas");
const video        = document.getElementById("webcam");
const debugCanvas  = document.getElementById("debug-canvas");
const debugCtx     = debugCanvas.getContext("2d");
const hamburger    = document.getElementById("hamburger");
const panel        = document.getElementById("panel");
const handCursor   = document.getElementById("hand-cursor");
const pinchEl      = document.getElementById("pinch-indicator");
const cameraOverlay = document.getElementById("camera-overlay");
const enableBtn    = document.getElementById("enable-camera-btn");

// ─── State ──────────────────────────────────────────────────────────────────
let handX = 0.5, handY = 0.5;
let targetX = 0.5, targetY = 0.5;
let isPinching = false;
let lastPinchTime = 0;
let panelOpen = false;
let handDetected = false;

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

  vec2 coverUV(vec2 uv, vec2 canvasRes, vec2 imgRes) {
    float canvasAspect = canvasRes.x / canvasRes.y;
    float imgAspect    = imgRes.x / imgRes.y;
    vec2 scale;
    if (canvasAspect > imgAspect) {
      scale = vec2(1.0, imgAspect / canvasAspect);
    } else {
      scale = vec2(canvasAspect / imgAspect, 1.0);
    }
    return (uv - 0.5) / scale + 0.5;
  }

  void main() {
    vec2 uv = coverUV(v_texCoord, u_resolution, u_imageSize);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    if (u_handActive > 0.5) {
      vec2 diff = v_texCoord - u_hand;
      float aspectRatio = u_resolution.x / u_resolution.y;
      diff.x *= aspectRatio;
      float dist = length(diff);
      float normDist = dist / (u_radius * max(aspectRatio, 1.0));

      if (normDist < 1.0) {
        float factor = 1.0 - normDist * normDist;
        factor = factor * factor;
        float wave = sin(u_time * 2.0 + dist * 30.0) * 0.15 + 1.0;
        vec2 offset = normalize(diff) * factor * u_strength * wave;
        uv += offset;
        uv = clamp(uv, vec2(0.0), vec2(1.0));
      }
    }

    gl_FragColor = texture2D(u_image, uv);
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
const program = gl.createProgram();
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
  handX += (targetX - handX) * LERP_SPEED;
  handY += (targetY - handY) * LERP_SPEED;

  gl.uniform2f(uHand, handX, handY);
  gl.uniform1f(uRadius, DISTORTION_RADIUS);
  gl.uniform1f(uStrength, DISTORTION_STRENGTH);
  gl.uniform1f(uTime, (performance.now() - t0) / 1000);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uHandActive, handDetected ? 1.0 : 0.0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(render);
}
render();

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
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onHandResults);

  debugCanvas.width  = 200;
  debugCanvas.height = 150;

  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
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

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    handDetected = false;
    handCursor.classList.remove("visible");
    return;
  }

  handDetected = true;
  const lm = results.multiHandLandmarks[0];

  const ix = 1 - lm[8].x;
  const iy = lm[8].y;

  targetX = ix;
  targetY = iy;

  handCursor.style.left = `${ix * 100}%`;
  handCursor.style.top  = `${iy * 100}%`;
  handCursor.classList.add("visible");

  // Hover detection for hamburger
  const hRect = hamburger.getBoundingClientRect();
  const screenX = ix * window.innerWidth;
  const screenY = iy * window.innerHeight;
  const pad = 24;
  const isOverHamburger =
    screenX >= hRect.left - pad &&
    screenX <= hRect.right + pad &&
    screenY >= hRect.top - pad &&
    screenY <= hRect.bottom + pad;

  hamburger.classList.toggle("hovered", isOverHamburger);

  // Pinch detection: thumb tip (4) ↔ index tip (8)
  const thumb = lm[4];
  const index = lm[8];
  const dx = thumb.x - index.x;
  const dy = thumb.y - index.y;
  const dz = (thumb.z || 0) - (index.z || 0);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const now = performance.now();
  const wasPinching = isPinching;
  isPinching = dist < PINCH_THRESHOLD;

  handCursor.classList.toggle("pinching", isPinching);

  if (isPinching && !wasPinching && now - lastPinchTime > PINCH_COOLDOWN) {
    lastPinchTime = now;
    onPinch(screenX, screenY, isOverHamburger);
  }

  // Draw landmarks on debug canvas (mirrored)
  debugCtx.fillStyle = "rgba(160, 224, 255, 0.9)";
  for (const p of lm) {
    const px = (1 - p.x) * debugCanvas.width;
    const py = p.y * debugCanvas.height;
    debugCtx.beginPath();
    debugCtx.arc(px, py, 2, 0, Math.PI * 2);
    debugCtx.fill();
  }

  // Draw line between thumb and index to visualize pinch
  const thumbPx = (1 - thumb.x) * debugCanvas.width;
  const thumbPy = thumb.y * debugCanvas.height;
  const indexPx = (1 - index.x) * debugCanvas.width;
  const indexPy = index.y * debugCanvas.height;
  debugCtx.strokeStyle = isPinching
    ? "rgba(255, 180, 100, 0.9)"
    : "rgba(160, 224, 255, 0.4)";
  debugCtx.lineWidth = isPinching ? 2 : 1;
  debugCtx.beginPath();
  debugCtx.moveTo(thumbPx, thumbPy);
  debugCtx.lineTo(indexPx, indexPy);
  debugCtx.stroke();
}

function onPinch(x, y, overHamburger) {
  pinchEl.style.left = `${x}px`;
  pinchEl.style.top  = `${y}px`;
  pinchEl.classList.remove("visible");
  void pinchEl.offsetWidth;
  pinchEl.classList.add("visible");
  setTimeout(() => pinchEl.classList.remove("visible"), 600);

  if (overHamburger) {
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
