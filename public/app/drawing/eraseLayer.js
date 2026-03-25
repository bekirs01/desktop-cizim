/** Слишком короткие обломки линий после ластика — не храним (убирает «потёртости»). */
const MIN_STROKE_NORM_LEN = 0.0045;

function polylineNormLength(pts) {
  if (!pts || pts.length < 2) return 0;
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    L += Math.hypot(dx, dy);
  }
  return L;
}

/** Попадание ластика в заливку: любой непрозрачный пиксель в круге (как в редакторах). */
function fillLayerHitByErase(f, eraseX, eraseY, radiusNorm) {
  if (!f?.data || !f.w || !f.h) return false;
  const rw = f.w;
  const rh = f.h;
  const cx = eraseX * rw;
  const cy = eraseY * rh;
  const rPix = Math.max(2, radiusNorm * Math.min(rw, rh));
  const r2 = rPix * rPix;
  const x0 = Math.max(0, Math.floor(cx - rPix));
  const y0 = Math.max(0, Math.floor(cy - rPix));
  const x1 = Math.min(rw - 1, Math.ceil(cx + rPix));
  const y1 = Math.min(rh - 1, Math.ceil(cy + rPix));
  const d = f.data.data;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy > r2) continue;
      const idx = (py * rw + px) * 4;
      if (d[idx + 3] > 10) return true;
    }
  }
  return false;
}

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
      if (fillLayerHitByErase(f, eraseX, eraseY, radius)) {
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
    } else if (sh.type === "image") {
      dx = sh.x + sh.w / 2 - eraseX;
      dy = sh.y + sh.h / 2 - eraseY;
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
    for (const s of segments) {
      if (polylineNormLength(s.points) >= MIN_STROKE_NORM_LEN) {
        nextStrokes.push({ points: s.points, color: s.color, lineWidth: s.lineWidth, opacity: s.opacity });
      }
    }
  }
  return { strokes: nextStrokes, shapes: nextShapes, fillShapes: nextFillShapes };
}
