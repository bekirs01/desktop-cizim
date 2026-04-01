import { POSE_CONNECTIONS } from "../config/landmarks.js";
import { toPx } from "./coords.js";

export function drawPoseSkeleton(ctx, lm, w, h, mirrorCamera, minVis) {
  if (!lm || lm.length < 29) return;
  ctx.strokeStyle = "#6c5ce7";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  POSE_CONNECTIONS.forEach(([i, j]) => {
    const a = lm[i], b = lm[j];
    const va = a?.visibility ?? 1, vb = b?.visibility ?? 1;
    if (a && b && va > minVis && vb > minVis) {
      const p1 = toPx(a, w, h, mirrorCamera), p2 = toPx(b, w, h, mirrorCamera);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  });
  ctx.fillStyle = "#6c5ce7";
  lm.forEach((p, idx) => {
    if (idx < 11) return;
    if ((p?.visibility ?? 1) > minVis) {
      const pt = toPx(p, w, h, mirrorCamera);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
