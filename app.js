// ─── Configuration ──────────────────────────────────────────────────────────
const PINCH_THRESHOLD = 0.06;
const PINCH_COOLDOWN  = 600;          // ms between pinch triggers
const DISTORTION_RADIUS = 0.25;       // normalised radius of effect
const DISTORTION_STRENGTH = 0.045;    // maximum UV displacement
const LERP_SPEED = 0.12;             // hand-position smoothing
const IMAGE_PATH = "images/test-1.jpg";

// ─── DOM references ─────────────────────────────────────────────────────────
const canvas      = document.getElementById("webgl-canvas");
const video       = document.getElementById("webcam");
const debugCanvas = document.getElementById("debug-canvas");
const debugCtx    = debugCanvas.getContext("2d");
const hamburger   = document.getElementById("hamburger");
const panel       = document.getElementById("panel");
const handCursor  = document.getElementById("hand-cursor");
const pinchEl     = document.getElementById("pinch-indicator");

// ─── State ──────────────────────────────────────────────────────────────────
let handX = 0.5, handY = 0.5;        // normalised [0,1]
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
  uniform vec2  u_hand;           // hand position in UV space
  uniform float u_radius;         // distortion radius
  uniform float u_strength;       // distortion strength
  uniform float u_time;           // for subtle animation
  uniform vec2  u_resolution;     // canvas size
  uniform vec2  u_imageSize;      // original image dimensions
  uniform float u_handActive;     // 0 or 1

  vec2 coverUV(vec2 uv, vec2 canvasRes, vec2 imgRes) {
    float canvasAspect = canvasRes.x / canvasRes.y;
    float imgAspect    = imgRes.x / imgRes.y;
    vec2 scale = vec2(1.0);
    if (canvasAspect > imgAspect) {
      scale.y = (imgAspect / canvasAspect);
    } else {
      scale.x = (canvasAspect / imgAspect);
    }
    return (uv - 0.5) * scale + 0.5;  // Flip removed — we'll flip the quad instead
  }

  void main() {
    vec2 uv = coverUV(v_texCoord, u_resolution, u_imageSize);

    // Out-of-bounds → black
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    if (u_handActive > 0.5) {
      vec2 diff = v_texCoord - u_hand;
      float aspectRatio = u_resolution.x / u_resolution.y;
      diff.x *= aspectRatio;
      float dist = length(diff);
      float normDist = dist / (u_radius * aspectRatio);

      if (normDist < 1.0) {
        float factor = 1.0 - normDist * normDist;
        factor = factor * factor;

        float wave = sin(u_time * 2.0 + dist * 30.0) * 0.15 + 1.0;
        vec2 offset = normalize(diff) * factor * u_strength * wave;
        uv += offset;

        uv = clamp(uv, 0.0, 1.0);
      }
    }

    vec4 color = texture2D(u_image, uv);
    gl_FragColor = color;
  }
`;

function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
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
  console.error(gl.getProgramInfoLog(program));
}
gl.useProgram(program);

// Full-screen quad (Y flipped so image isn't upside-down)
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

// Uniforms
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
img.crossOrigin = "anonymous";
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
const startTime = performance.now();

function render() {
  handX += (targetX - handX) * LERP_SPEED;
  handY += (targetY - handY) * LERP_SPEED;

  gl.uniform2f(uHand, handX, handY);
  gl.uniform1f(uRadius, DISTORTION_RADIUS);
  gl.uniform1f(uStrength, DISTORTION_STRENGTH);
  gl.uniform1f(uTime, (performance.now() - startTime) / 1000);
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uImageSize, imgW, imgH);
  gl.uniform1f(uHandActive, handDetected ? 1.0 : 0.0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(render);
}
render();

// ─── MediaPipe Hands ────────────────────────────────────────────────────────
async function initMediaPipe() {
  const { Hands } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js"
  );

  const hands = new Hands({
    locateFile: (f) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  hands.onResults(onHandResults);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
  });
  video.srcObject = stream;
  await video.play();

  debugCanvas.width  = 200;
  debugCanvas.height = 150;

  async function tick() {
    await hands.send({ image: video });
    requestAnimationFrame(tick);
  }
  tick();
}

function onHandResults(results) {
  // Draw debug preview
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.save();
  debugCtx.scale(-1, 1);
  debugCtx.drawImage(
    results.image,
    -debugCanvas.width, 0,
    debugCanvas.width, debugCanvas.height
  );
  debugCtx.restore();

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    handDetected = false;
    handCursor.classList.remove("visible");
    return;
  }

  handDetected = true;
  const lm = results.multiHandLandmarks[0];

  // Landmark 8 = index finger tip
  const ix = 1 - lm[8].x;   // mirror x for selfie view
  const iy = lm[8].y;

  targetX = ix;
  targetY = iy;

  // Position hand cursor
  handCursor.style.left = `${ix * 100}%`;
  handCursor.style.top  = `${iy * 100}%`;
  handCursor.classList.add("visible");

  // Check hover on hamburger
  const hRect = hamburger.getBoundingClientRect();
  const screenX = ix * window.innerWidth;
  const screenY = iy * window.innerHeight;
  const isOverHamburger =
    screenX >= hRect.left - 20 &&
    screenX <= hRect.right + 20 &&
    screenY >= hRect.top - 20 &&
    screenY <= hRect.bottom + 20;

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

  // Trigger on pinch start
  if (isPinching && !wasPinching && now - lastPinchTime > PINCH_COOLDOWN) {
    lastPinchTime = now;
    onPinch(screenX, screenY, isOverHamburger);
  }

  // Draw landmarks on debug canvas
  debugCtx.fillStyle = "rgba(160, 224, 255, 0.9)";
  for (const p of lm) {
    const px = (1 - p.x) * debugCanvas.width;
    const py = p.y * debugCanvas.height;
    debugCtx.beginPath();
    debugCtx.arc(px, py, 2, 0, Math.PI * 2);
    debugCtx.fill();
  }
}

function onPinch(x, y, overHamburger) {
  // Show pinch indicator
  pinchEl.style.left = `${x}px`;
  pinchEl.style.top  = `${y}px`;
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

// ─── Bootstrap ──────────────────────────────────────────────────────────────
initMediaPipe().catch((err) => {
  console.warn("MediaPipe init failed — hand tracking unavailable:", err);
});
