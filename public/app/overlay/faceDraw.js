import { toPx } from "./coords.js";

const EYE_LEFT_UPPER = [246, 161, 160, 159, 158, 157, 173];
const EYE_LEFT_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const EYE_LEFT_OUTLINE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const EYE_RIGHT_UPPER = [466, 388, 387, 386, 385, 384, 398];
const EYE_RIGHT_LOWER = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const EYE_RIGHT_OUTLINE = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
const IRIS_LEFT = [468, 469, 470, 471, 472];
const IRIS_RIGHT = [473, 474, 475, 476, 477];

const EYEBROW_LEFT = [70, 63, 105, 66, 107];
const EYEBROW_RIGHT = [300, 293, 334, 296, 336];

const EYE_LEFT_DETAIL = [
  33, 7, 163, 144, 145, 153, 154, 155, 133,
  173, 157, 158, 159, 160, 161, 246,
];
const EYE_RIGHT_DETAIL = [
  263, 249, 390, 373, 374, 380, 381, 382, 362,
  398, 384, 385, 386, 387, 388, 466,
];

function drawLandmarkPath(ctx, pts, indices, w, h, mirrorCamera, close = true) {
  ctx.beginPath();
  let started = false;
  for (const i of indices) {
    const p = pts[i];
    if (!p) continue;
    const pt = toPx(p, w, h, mirrorCamera);
    if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
    else ctx.lineTo(pt.x, pt.y);
  }
  if (close && started) ctx.closePath();
}

function drawIris(ctx, pts, indices, w, h, mirrorCamera, eyeClosed = false) {
  if (!pts[indices[0]]) return;
  const center = toPx(pts[indices[0]], w, h, mirrorCamera);
  let rSum = 0;
  let count = 0;
  for (let i = 1; i < indices.length; i++) {
    const p = pts[indices[i]];
    if (!p) continue;
    const pt = toPx(p, w, h, mirrorCamera);
    rSum += Math.hypot(pt.x - center.x, pt.y - center.y);
    count++;
  }
  const radius = count > 0 ? rSum / count : 4;

  if (eyeClosed) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 80, 80, 0.12)";
    ctx.fill();
    return;
  }

  ctx.save();
  ctx.shadowColor = "rgba(0, 200, 255, 0.5)";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 200, 255, 0.25)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 220, 255, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  for (let i = 1; i < indices.length; i++) {
    const p = pts[indices[i]];
    if (!p) continue;
    const pt = toPx(p, w, h, mirrorCamera);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 220, 255, 0.6)";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(center.x, center.y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fill();
}

export function drawEyeContours(ctx, pts, w, h, mirrorCamera, blinkState = null) {
  if (!pts || pts.length < 400) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const leftClosed = blinkState?.leftClosed ?? false;
  const rightClosed = blinkState?.rightClosed ?? false;
  const leftScore = blinkState?.leftScore ?? 0;
  const rightScore = blinkState?.rightScore ?? 0;
  const closedStates = [leftClosed, rightClosed];
  const scores = [leftScore, rightScore];

  const outlines = [EYE_LEFT_OUTLINE, EYE_RIGHT_OUTLINE];
  for (let ei = 0; ei < outlines.length; ei++) {
    const closed = closedStates[ei];
    const outlineColor = closed ? "rgba(255, 80, 80, 0.85)" : "rgba(0, 220, 255, 0.7)";
    const glowColor = closed ? "rgba(255, 60, 60, 0.5)" : "rgba(0, 200, 255, 0.4)";
    const fillColor = closed ? "rgba(255, 80, 80, 0.08)" : "rgba(0, 220, 255, 0.06)";

    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 2.5;
    drawLandmarkPath(ctx, pts, outlines[ei], w, h, mirrorCamera);
    ctx.stroke();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.restore();
  }

  const uppers = [EYE_LEFT_UPPER, EYE_RIGHT_UPPER];
  const lowers = [EYE_LEFT_LOWER, EYE_RIGHT_LOWER];
  for (let ei = 0; ei < 2; ei++) {
    const closed = closedStates[ei];
    ctx.strokeStyle = closed ? "rgba(255, 140, 140, 0.6)" : "rgba(120, 255, 200, 0.55)";
    ctx.lineWidth = 1.2;
    drawLandmarkPath(ctx, pts, uppers[ei], w, h, mirrorCamera, false);
    ctx.stroke();
    drawLandmarkPath(ctx, pts, lowers[ei], w, h, mirrorCamera, false);
    ctx.stroke();
  }

  for (const brow of [EYEBROW_LEFT, EYEBROW_RIGHT]) {
    ctx.strokeStyle = "rgba(180, 160, 255, 0.5)";
    ctx.lineWidth = 1.5;
    drawLandmarkPath(ctx, pts, brow, w, h, mirrorCamera, false);
    ctx.stroke();
  }

  const details = [EYE_LEFT_DETAIL, EYE_RIGHT_DETAIL];
  for (let ei = 0; ei < details.length; ei++) {
    const closed = closedStates[ei];
    ctx.fillStyle = closed ? "rgba(255, 100, 100, 0.7)" : "rgba(0, 220, 255, 0.5)";
    for (const idx of details[ei]) {
      const p = pts[idx];
      if (!p) continue;
      const pt = toPx(p, w, h, mirrorCamera);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (pts.length > 477) {
    drawIris(ctx, pts, IRIS_LEFT, w, h, mirrorCamera, leftClosed);
    drawIris(ctx, pts, IRIS_RIGHT, w, h, mirrorCamera, rightClosed);
  }

  const labelPairs = [
    { idx: EYE_LEFT_OUTLINE, closed: leftClosed, score: leftScore, label: "L" },
    { idx: EYE_RIGHT_OUTLINE, closed: rightClosed, score: rightScore, label: "R" },
  ];
  for (const { idx, closed, score, label } of labelPairs) {
    let cx = 0, cy = 0, n = 0;
    for (const i of idx) {
      const p = pts[i];
      if (!p) continue;
      const pt = toPx(p, w, h, mirrorCamera);
      cx += pt.x; cy += pt.y; n++;
    }
    if (n === 0) continue;
    cx /= n; cy /= n;

    ctx.save();
    ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = closed ? "rgba(255, 80, 80, 0.95)" : "rgba(0, 220, 255, 0.85)";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 3;
    const stateText = closed ? "KAPALI" : "ACIK";
    ctx.fillText(`${label}: ${stateText}`, cx, cy - 18);
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(200,200,200,0.7)";
    ctx.fillText(`${(score * 100).toFixed(0)}%`, cx, cy - 8);
    ctx.restore();
  }
}

function getBlendshapeList(faceResults) {
  const bs = faceResults?.faceBlendshapes?.[0];
  if (!bs) return [];
  if (Array.isArray(bs)) return bs;
  if (bs.categories && Array.isArray(bs.categories)) return bs.categories;
  return [];
}

export function checkEyesClosed(faceResults) {
  const list = getBlendshapeList(faceResults);
  if (!list.length) return false;
  let l = 0, r = 0;
  for (const b of list) {
    if (b.categoryName === "eyeBlinkLeft") l = b.score;
    if (b.categoryName === "eyeBlinkRight") r = b.score;
  }
  return (l + r) / 2 > 0.4;
}

export function getEyeBlinkState(faceResults, prevState = null) {
  let leftScore = 0;
  let rightScore = 0;
  const list = getBlendshapeList(faceResults);
  for (const b of list) {
    if (b.categoryName === "eyeBlinkLeft") leftScore = b.score;
    if (b.categoryName === "eyeBlinkRight") rightScore = b.score;
  }
  const closeTh = 0.52;
  const openTh = 0.32;
  const prevLeft = !!prevState?.leftClosed;
  const prevRight = !!prevState?.rightClosed;
  const leftClosed = prevLeft ? leftScore > openTh : leftScore > closeTh;
  const rightClosed = prevRight ? rightScore > openTh : rightScore > closeTh;
  return {
    leftClosed,
    rightClosed,
    bothClosed: leftClosed && rightClosed,
    leftScore,
    rightScore,
  };
}
