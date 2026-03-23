import { HAND_CONNECTIONS, FINGER_COLORS } from "../config/landmarks.js";
import { toPx } from "./coords.js";

function getFingerColor(idx) {
  if (idx <= 4) return FINGER_COLORS.thumb;
  if (idx <= 8) return FINGER_COLORS.index;
  if (idx <= 12) return FINGER_COLORS.middle;
  if (idx <= 16) return FINGER_COLORS.ring;
  return FINGER_COLORS.pinky;
}

export function drawHandLandmarks(ctx, hands, w, h, mirrorCamera) {
  if (!hands || hands.length === 0) return;
  hands.forEach((hand) => {
    if (!hand || hand.length < 21) return;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    HAND_CONNECTIONS.forEach(([i, j]) => {
      const a = hand[i], b = hand[j];
      if (a && b) {
        const p1 = toPx(a, w, h, mirrorCamera), p2 = toPx(b, w, h, mirrorCamera);
        ctx.strokeStyle = getFingerColor(i);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    });
    hand.forEach((p, i) => {
      if (!p) return;
      const pt = toPx(p, w, h, mirrorCamera);
      const isTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = getFingerColor(i);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isTip ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}
