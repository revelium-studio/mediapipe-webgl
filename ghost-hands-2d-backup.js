// ─── BACKUP: 2D Ghost Hand Drawing (compact, soft, 2-pass) ─────────────────
// To restore, replace the Three.js ghost-hand section in app.js with this code.

const GHOST_SEGMENTS = [
  [0, 1, 12], [1, 2, 11], [2, 3, 9], [3, 4, 7],
  [0, 5, 12], [5, 6, 10], [6, 7, 8], [7, 8, 6],
  [5, 9, 11], [9, 10, 10], [10, 11, 8], [11, 12, 6],
  [9, 13, 10], [13, 14, 9], [14, 15, 7], [15, 16, 5],
  [13, 17, 10], [0, 17, 12], [17, 18, 8], [18, 19, 6], [19, 20, 5],
];
const PALM_INDICES = [0, 1, 5, 9, 13, 17];
const GHOST_SCALE = 0.5;

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
