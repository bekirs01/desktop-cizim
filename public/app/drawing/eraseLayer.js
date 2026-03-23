/**
 * Silgi: stroke/shape/fill katmanı — saf; renk varsayılanları parametre.
 */
export function eraseLayerAtPosition(
  strokesArr,
  shapesArr,
  eraseX,
  eraseY,
  radius = 0.07,
  fillShapesArr = [],
  defaultColor = "#6c5ce7",
  defaultLineWidth = 4
) {
  const r2 = radius * radius;
  let nextFillShapes = fillShapesArr || [];
  if (fillShapesArr?.length > 0) {
    for (let i = fillShapesArr.length - 1; i >= 0; i--) {
      const f = fillShapesArr[i];
      if (!f?.data || !f.w || !f.h) continue;
      const px = Math.floor(eraseX * f.w);
      const py = Math.floor(eraseY * f.h);
      if (px < 0 || py < 0 || px >= f.w || py >= f.h) continue;
      const idx = (py * f.w + px) * 4;
      if (f.data.data[idx + 3] > 10) {
        nextFillShapes = fillShapesArr.slice(0, i).concat(fillShapesArr.slice(i + 1));
        break;
      }
    }
  }
  const nextShapes = shapesArr.filter((sh) => {
    let dx, dy;
    if (sh.type === "circle") {
      dx = sh.cx - eraseX;
      dy = sh.cy - eraseY;
    } else if (sh.type === "rect" || sh.type === "ellipse") {
      dx = sh.x + sh.w / 2 - eraseX;
      dy = sh.y + sh.h / 2 - eraseY;
    } else if (sh.type === "line" || sh.type === "arrow") {
      dx = (sh.x1 + sh.x2) / 2 - eraseX;
      dy = (sh.y1 + sh.y2) / 2 - eraseY;
    } else if (sh.type === "triangle") {
      dx = (sh.x1 + sh.x2 + sh.x3) / 3 - eraseX;
      dy = (sh.y1 + sh.y2 + sh.y3) / 3 - eraseY;
    } else if (sh.type === "text") {
      dx = sh.x - eraseX;
      dy = sh.y - eraseY;
    } else return true;
    return dx * dx + dy * dy > r2;
  });
  const nextStrokes = [];
  for (const stroke of strokesArr) {
    const pts = stroke.points || stroke;
    const color = stroke.color || defaultColor;
    const lw = stroke.lineWidth ?? defaultLineWidth;
    const opacity = stroke.opacity ?? 1;
    const segments = [];
    let seg = [];
    for (const pt of pts) {
      const d2 = (pt.x - eraseX) ** 2 + (pt.y - eraseY) ** 2;
      if (d2 < r2) {
        if (seg.length > 1) segments.push({ points: seg, color, lineWidth: lw, opacity });
        seg = [];
      } else {
        seg.push(pt);
      }
    }
    if (seg.length > 1) segments.push({ points: seg, color, lineWidth: lw, opacity });
    for (const s of segments) nextStrokes.push({ points: s.points, color: s.color, lineWidth: s.lineWidth, opacity: s.opacity });
  }
  return { strokes: nextStrokes, shapes: nextShapes, fillShapes: nextFillShapes };
}
