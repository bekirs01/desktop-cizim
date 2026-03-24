/**
 * Распознавание грубого замкнутого контура как окружности (нормализованные координаты 0–1).
 * Вызывается только после удержания указателя на месте (см. SKETCH_SNAP_HOLD_MS в script.js).
 * Прямая линия из штриха — в sketchToLine.js / sketchHoldSnap.js.
 */

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dedupeConsecutive(pts, eps) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(p, last) >= eps) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function polylineLengthOpen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Алгебраическая подгонка (Kåsa / Pratt после переноса центра масс). */
function fitCircleAlgebraic(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0,
    my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let Suu = 0,
    Suv = 0,
    Svv = 0,
    Suuu = 0,
    Svvv = 0,
    Suvv = 0,
    Svuu = 0;
  for (const p of pts) {
    const u = p.x - mx,
      v = p.y - my;
    const uu = u * u,
      vv = v * v;
    Suu += uu;
    Suv += u * v;
    Svv += vv;
    Suuu += u * uu;
    Svvv += v * vv;
    Suvv += u * vv;
    Svuu += v * uu;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-16) return null;
  const bu = 0.5 * (Suuu + Suvv);
  const bv = 0.5 * (Svvv + Svuu);
  const uc = (Svv * bu - Suv * bv) / det;
  const vc = (-Suv * bu + Suu * bv) / det;
  const cx = mx + uc;
  const cy = my + vc;
  const rSq = uc * uc + vc * vc + (Suu + Svv) / n;
  if (!(rSq > 1e-12)) return null;
  return { cx, cy, r: Math.sqrt(rSq) };
}

/** Равномерная выборка N точек по замкнутому контуру (включая ребро last→first). */
function resampleClosed(pts, nOut) {
  if (pts.length < 2) return pts.slice();
  const segs = [];
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = dist(a, b);
    segs.push({ a, b, len });
    L += len;
  }
  if (L < 1e-10) return pts.slice();
  const out = [];
  for (let k = 0; k < nOut; k++) {
    let d = (k / nOut) * L;
    for (const s of segs) {
      if (d <= s.len + 1e-12) {
        const u = s.len < 1e-12 ? 0 : d / s.len;
        out.push({
          x: s.a.x + u * (s.b.x - s.a.x),
          y: s.a.y + u * (s.b.y - s.a.y),
        });
        break;
      }
      d -= s.len;
    }
  }
  return out;
}

function windingNumberAround(pts, cx, cy) {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const ta = Math.atan2(a.y - cy, a.x - cx);
    const tb = Math.atan2(b.y - cy, b.x - cx);
    let d = tb - ta;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sum += d;
  }
  const a = pts[pts.length - 1],
    b = pts[0];
  const ta = Math.atan2(a.y - cy, a.x - cx);
  const tb = Math.atan2(b.y - cy, b.x - cx);
  let d = tb - ta;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  sum += d;
  return sum / (2 * Math.PI);
}

/**
 * Если штрих похож на замкнутую окружность — вернуть объект фигуры как у drawShapeToCtx.
 * @param {object} stroke — { points, color?, lineWidth?, opacity? }
 * @param {boolean} fill — shapeFill в момент завершения
 * @returns {object|null} { type, cx, cy, r, color, lineWidth, fill, opacity }
 */
export function trySketchToCircleShape(stroke, fill) {
  const raw = stroke?.points;
  if (!raw || raw.length < 10) return null;

  const pts = dedupeConsecutive(raw, 0.00012);
  if (pts.length < 9) return null;

  const openLen = polylineLengthOpen(pts);
  const gap = dist(pts[0], pts[pts.length - 1]);
  const bb = bboxOf(pts);
  const bw = bb.maxX - bb.minX;
  const bh = bb.maxY - bb.minY;
  const size = Math.max(bw, bh);
  if (size < 0.016) return null;

  const aspect = bw > 1e-9 ? bh / bw : 999;
  if (aspect < 0.42 || aspect > 2.35) return null;

  const rBBox = 0.5 * Math.hypot(bw, bh);
  const closeTol = Math.max(0.15 * rBBox, 0.022, 0.34 * gap + 0.012 * size);
  if (gap > closeTol) return null;

  const closedPerim = openLen + gap;
  if (closedPerim < 0.032) return null;

  const sampled = resampleClosed(pts, 52);
  const fit = fitCircleAlgebraic(sampled);
  if (!fit || !Number.isFinite(fit.r) || fit.r < 0.009) return null;

  if (fit.cx + fit.r < -0.04 || fit.cx - fit.r > 1.04 || fit.cy + fit.r < -0.04 || fit.cy - fit.r > 1.04) return null;

  let sumAbs = 0,
    maxAbs = 0;
  for (const p of sampled) {
    const d = Math.abs(dist(p, { x: fit.cx, y: fit.cy }) - fit.r);
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
  }
  const meanAbs = sumAbs / sampled.length;
  const relMean = meanAbs / (fit.r + 1e-9);
  const relMax = maxAbs / (fit.r + 1e-9);
  if (relMean > 0.2) return null;
  if (relMax > 0.54) return null;

  const circ = 2 * Math.PI * fit.r;
  const lenRatio = closedPerim / circ;
  if (lenRatio < 0.44 || lenRatio > 1.68) return null;

  const wind = Math.abs(windingNumberAround(pts, fit.cx, fit.cy));
  if (wind < 0.58 || wind > 1.38) return null;

  return {
    type: "circle",
    cx: fit.cx,
    cy: fit.cy,
    r: fit.r,
    color: stroke.color,
    lineWidth: stroke.lineWidth,
    fill: !!fill,
    opacity: stroke.opacity ?? 1,
  };
}
