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

function pointToSegDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-18) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Замкнут ли контур грубо (для выбора круг vs линия). */
export function isStrokeClosedHint(pts) {
  if (!pts || pts.length < 6) return false;
  const cleaned = dedupeConsecutive(pts, 0.00015);
  if (cleaned.length < 6) return false;
  const openLen = polylineLengthOpen(cleaned);
  if (openLen < 1e-9) return false;
  const gap = dist(cleaned[0], cleaned[cleaned.length - 1]);
  const bb = bboxOf(cleaned);
  const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 0.001);
  return gap < Math.max(0.018, 0.15 * size, 0.07 * openLen);
}

/**
 * Почти прямой открытый штрих → сегмент line (как линейка).
 */
export function trySketchToLineShape(stroke) {
  const raw = stroke?.points;
  if (!raw || raw.length < 4) return null;
  const pts = dedupeConsecutive(raw, 0.00012);
  if (pts.length < 4) return null;
  if (isStrokeClosedHint(pts)) return null;

  const a = pts[0], b = pts[pts.length - 1];
  const chord = dist(a, b);
  if (chord < 0.016) return null;
  const plen = polylineLengthOpen(pts);
  if (plen < 0.022) return null;
  if (chord / plen < 0.7) return null;

  let maxD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegDist(pts[i], a, b);
    if (d > maxD) maxD = d;
  }
  if (maxD / chord > 0.3) return null;

  return {
    type: "line",
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    color: stroke.color,
    lineWidth: stroke.lineWidth,
    opacity: stroke.opacity ?? 1,
  };
}
