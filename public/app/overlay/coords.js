/** Video landmark norm → canvas px (mirror = selfie aynası) */
export function toPx(p, w, h, mirrorCamera) {
  const x = mirrorCamera ? (1 - p.x) * w : p.x * w;
  return { x, y: p.y * h };
}
