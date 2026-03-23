import { toPx } from "./coords.js";

const EYE_LEFT = [33, 160, 159, 158, 157, 173, 133];
const EYE_RIGHT = [362, 385, 386, 387, 388, 466, 263];

export function drawEyeContours(ctx, pts, w, h, mirrorCamera) {
  if (!pts || pts.length < 400) return;
  ctx.strokeStyle = "rgba(0,255,159,0.75)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  [EYE_LEFT, EYE_RIGHT].forEach((indices) => {
    ctx.beginPath();
    indices.forEach((i, j) => {
      const p = pts[i];
      if (p) {
        const pt = toPx(p, w, h, mirrorCamera);
        ctx[j ? "lineTo" : "moveTo"](pt.x, pt.y);
      }
    });
    ctx.closePath();
    ctx.stroke();
  });
}

export function checkEyesClosed(faceResults) {
  if (!faceResults?.faceBlendshapes?.[0]) return false;
  let l = 0, r = 0;
  for (const b of faceResults.faceBlendshapes[0]) {
    if (b.categoryName === "eyeBlinkLeft") l = b.score;
    if (b.categoryName === "eyeBlinkRight") r = b.score;
  }
  return (l + r) / 2 > 0.4;
}
