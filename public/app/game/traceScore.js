function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function sampleCircle(cx, cy, r, n = 200) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return pts;
}

export function sampleSegment(x0, y0, x1, y1, n = 160) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1);
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return pts;
}

export function sampleSquare(cx, cy, half, n = 200) {
  const pts = [];
  const na = Math.max(2, Math.floor(n / 4));
  const edge = (xa, ya, xb, yb, count) => {
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1 || 1);
      pts.push({ x: xa + (xb - xa) * t, y: ya + (yb - ya) * t });
    }
  };
  edge(cx - half, cy - half, cx + half, cy - half, na);
  edge(cx + half, cy - half, cx + half, cy + half, na);
  edge(cx + half, cy + half, cx - half, cy + half, na);
  edge(cx - half, cy + half, cx - half, cy - half, na);
  return pts;
}

export function sampleTriangle(cx, cy, R, n = 200) {
  const verts = [];
  for (let k = 0; k < 3; k++) {
    const t = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
    verts.push({ x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) });
  }
  const pts = [];
  const na = Math.max(2, Math.floor(n / 3));
  for (let e = 0; e < 3; e++) {
    const a = verts[e];
    const b = verts[(e + 1) % 3];
    for (let i = 0; i < na; i++) {
      const t = i / (na - 1 || 1);
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return pts;
}

const SHAPE_BUILDERS = {
  circle: () => sampleCircle(0.5, 0.5, 0.22, 220),
  square: () => sampleSquare(0.5, 0.5, 0.17, 220),
  triangle: () => sampleTriangle(0.5, 0.52, 0.24, 220),
  line: () => sampleSegment(0.1, 0.5, 0.9, 0.5, 200),
  diagonal: () => sampleSegment(0.15, 0.2, 0.85, 0.8, 220),
};

export function getShapePolyline(id) {
  const fn = SHAPE_BUILDERS[id] || SHAPE_BUILDERS.circle;
  return fn();
}

export const SHAPE_IDS = Object.keys(SHAPE_BUILDERS);

/** Норм. 0–1 → изотропные координаты (как на квадратном холсте), если буфер не квадратный. */
function flattenStrokes(userStrokes, bufW, bufH) {
  const userPts = [];
  const w = bufW > 0 ? bufW : 0;
  const h = bufH > 0 ? bufH : 0;
  const useIso = w > 0 && h > 0 && Math.abs(w - h) > 0.5;
  const s = useIso ? Math.min(w, h) / 2 : 0;
  for (const st of userStrokes || []) {
    const pts = st?.points;
    if (pts?.length) {
      for (const p of pts) {
        if (useIso) {
          userPts.push({
            x: (p.x - 0.5) * (w / s),
            y: (p.y - 0.5) * (h / s),
          });
        } else {
          userPts.push({ x: p.x, y: p.y });
        }
      }
    }
  }
  return userPts;
}

function centroid(pts) {
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const n = pts.length;
  return { x: sx / n, y: sy / n };
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

function rotate(p, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

function pointSegDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy + 1e-18;
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x0 + t * dx;
  const qy = y0 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

const SQUARE_SEGS = [
  [-1, -1, 1, -1],
  [1, -1, 1, 1],
  [1, 1, -1, 1],
  [-1, 1, -1, -1],
];
const R3 = Math.sqrt(3) / 2;
const TRI_SEGS = [
  [0, -1, R3, 0.5],
  [R3, 0.5, -R3, 0.5],
  [-R3, 0.5, 0, -1],
];

function meanDistToSegments(pts, segs) {
  let sum = 0;
  for (const p of pts) {
    let m = 9;
    for (const s of segs) {
      m = Math.min(m, pointSegDist(p.x, p.y, s[0], s[1], s[2], s[3]));
    }
    sum += m;
  }
  return sum / (pts.length || 1);
}

/** Центр + масштаб по max(|x|,|y|) после переноса центра масс. */
function normalizeToUnitSquare(pts) {
  const c = centroid(pts);
  const rel = pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
  let maxE = 0;
  for (const p of rel) maxE = Math.max(maxE, Math.abs(p.x), Math.abs(p.y));
  if (maxE < 1e-6) return null;
  const inv = 1 / maxE;
  return rel.map((p) => ({ x: p.x * inv, y: p.y * inv }));
}

function scoreSquareForm(pts) {
  if (pts.length < 12) return tooFew();
  const sample = resampleArcLength(pts, 120);
  const userNorm = normalizeToUnitSquare(sample);
  if (!userNorm) return tooFew();
  let best = 9;
  for (const flip of [1, -1]) {
    const u0 = userNorm.map((p) => ({ x: p.x * flip, y: p.y }));
    for (let k = 0; k < 4; k++) {
      const ang = (k * Math.PI) / 2;
      const r = u0.map((p) => rotate(p, ang));
      best = Math.min(best, meanDistToSegments(r, SQUARE_SEGS));
    }
  }
  const raw = 100 * (1 - Math.min(1, best / 0.14));
  return finalize(
    raw,
    "Квадрат: отклонение от сторон после выравнивания и масштаба (поворот и зеркало учитываются)."
  );
}

function scoreTriangleForm(pts) {
  if (pts.length < 12) return tooFew();
  const sample = resampleArcLength(pts, 120);
  const userNorm = normalizeToUnitSquare(sample);
  if (!userNorm) return tooFew();
  const rots = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  let best = 9;
  for (const ang of rots) {
    const u0 = userNorm.map((p) => rotate(p, ang));
    best = Math.min(best, meanDistToSegments(u0, TRI_SEGS));
    const u1 = userNorm.map((p) => rotate({ x: p.x, y: -p.y }, ang));
    best = Math.min(best, meanDistToSegments(u1, TRI_SEGS));
  }
  const raw = 100 * (1 - Math.min(1, best / 0.13));
  return finalize(
    raw,
    "Треугольник: отклонение от сторон после выравнивания (поворот и отражение учитываются)."
  );
}

function pcaLineMetrics(pts) {
  const c = centroid(pts);
  const rel = pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  const n = rel.length;
  for (const p of rel) {
    cxx += p.x * p.x;
    cxy += p.x * p.y;
    cyy += p.y * p.y;
  }
  cxx /= n;
  cxy /= n;
  cyy /= n;
  const tr = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
  const l1 = tr * 0.5 + disc;
  const l2 = tr * 0.5 - disc;
  let vx;
  let vy;
  if (Math.abs(cxy) < 1e-10) {
    vx = cxx >= cyy ? 1 : 0;
    vy = cxx >= cyy ? 0 : 1;
  } else {
    vx = l1 - cyy;
    vy = cxy;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len;
    vy /= len;
  }
  const angle = Math.atan2(vy, vx);
  const extent = Math.max(
    Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
    Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
    0.04
  );
  const rmsPerp = Math.sqrt(Math.max(0, l2));
  const elong = l1 / (l2 + 1e-8);
  return { angle, rmsPerp, extent, elong };
}

/** Разница направлений прямой (без учёта ориентации). */
function angleDiffUndirected(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function scoreLineFamily(pts, expectedAngle) {
  const { angle, rmsPerp, extent, elong } = pcaLineMetrics(pts);
  const ad = angleDiffUndirected(angle, expectedAngle);
  const angleDeg = (ad * 180) / Math.PI;
  const sAng = 100 * (1 - Math.min(1, angleDeg / 16));
  const wig = rmsPerp / extent;
  const sStraight = 100 * (1 - Math.min(1, wig / 0.075));
  const sElong = 100 * Math.min(1, (elong - 2) / 14);
  const percent = 0.35 * sAng + 0.4 * sStraight + 0.25 * Math.max(0, Math.min(100, sElong));
  return Math.max(0, Math.min(100, percent));
}

function tooFew() {
  return { percent: 0, label: "Мало линий", detail: "Проведите фигуру целиком." };
}

function finalize(percent, detail) {
  const rounded = Math.max(0, Math.min(100, Math.round(percent)));
  let label = "Ещё потренироваться";
  if (rounded >= 92) label = "Отлично";
  else if (rounded >= 78) label = "Очень хорошо";
  else if (rounded >= 60) label = "Хорошо";
  else if (rounded >= 40) label = "Неплохо";
  return { percent: rounded, label, detail };
}

/** Алгебраический фит окружности (Pratt), устойчивее центра масс для «клубков». */
function fitCirclePratt(points) {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suuu = 0;
  let svvv = 0;
  let suuv = 0;
  let suvv = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    const u2 = u * u;
    const v2 = v * v;
    suu += u2;
    suv += u * v;
    svv += v2;
    suuu += u * u2;
    svvv += v * v2;
    suuv += u2 * v;
    suvv += u * v2;
  }
  const A = (suuu + suvv) / (2 * n);
  const B = (svvv + suuv) / (2 * n);
  const det = suv * suv - suu * svv;
  if (Math.abs(det) < 1e-12) return null;
  const uc = (svv * A - suv * B) / det;
  const vc = (suu * B - suv * A) / det;
  const cx = uc + mx;
  const cy = vc + my;
  const R = Math.sqrt(Math.max(0, uc * uc + vc * vc + (suu + svv) / n));
  if (R < 1e-5 || !Number.isFinite(R)) return null;
  return { cx, cy, R };
}

/** Равномерный ресемпл по длине дуги — убирает шум от плотных точек мыши. */
function resampleArcLength(pts, nOut) {
  if (pts.length < 2) return pts.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  }
  const L = cum[cum.length - 1];
  if (L < 1e-9) return [pts[0]];
  const out = [];
  for (let k = 0; k < nOut; k++) {
    const t = (k / Math.max(1, nOut - 1)) * L;
    let j = 0;
    while (j < cum.length - 1 && cum[j + 1] < t) j++;
    const segLen = dist(pts[j], pts[j + 1]) || 1e-9;
    const u = Math.max(0, Math.min(1, (t - cum[j]) / segLen));
    out.push({
      x: pts[j].x + u * (pts[j + 1].x - pts[j].x),
      y: pts[j].y + u * (pts[j + 1].y - pts[j].y),
    });
  }
  return out;
}

function polygonAreaClosed(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) * 0.5;
}

function scoreCircleForm(pts) {
  if (pts.length < 12) return tooFew();
  const sample = resampleArcLength(pts, 100);
  if (sample.length < 12) return tooFew();

  const fit = fitCirclePratt(sample);
  const G = centroid(sample);
  const cx = fit?.cx ?? G.x;
  const cy = fit?.cy ?? G.y;
  const R = fit?.R ?? mean(sample.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  if (R < 0.012) return finalize(0, "Нарисуйте круг крупнее.");

  const residuals = sample.map((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - R));
  const mad = mean(residuals);
  const relMad = mad / (R + 1e-6);
  const sFit = 100 * (1 - Math.min(1, relMad / 0.14));

  let arcLen = 0;
  for (let i = 1; i < sample.length; i++) arcLen += dist(sample[i - 1], sample[i]);
  const closureD = dist(sample[0], sample[sample.length - 1]);
  const perim = arcLen + closureD;
  const ideal = 2 * Math.PI * R;
  const rArc = arcLen / (ideal + 1e-9);
  let sArc = 100;
  if (rArc < 0.55) sArc = 100 * (rArc / 0.55);
  else if (rArc > 1.4) sArc = Math.max(0, 100 * (1 - (rArc - 1.4) / 0.8));

  const sClose = 100 * (1 - Math.min(1, closureD / (2.5 * R + 1e-6)));

  const closedRing = [...sample, sample[0]];
  const A = polygonAreaClosed(closedRing);
  const iso = (4 * Math.PI * A) / (perim * perim + 1e-9);
  const sIso = 100 * Math.min(1, iso);

  const raw = 0.48 * sFit + 0.18 * sArc + 0.18 * sClose + 0.16 * sIso;
  return finalize(
    raw,
    "Круг: отклонение точек от подогнанной окружности (Pratt), длина контура, замыкание и компактность (4πA/P²). Положение не важно."
  );
}

/**
 * Оценка формы (положение и масштаб не фиксированы). Серый контур — только подсказка.
 */
export function scoreShapeForm(shapeId, userStrokes, bufW, bufH) {
  const pts = flattenStrokes(userStrokes, bufW, bufH);
  if (pts.length < 8) return tooFew();

  switch (shapeId) {
    case "circle":
      return scoreCircleForm(pts);
    case "line": {
      const p = scoreLineFamily(pts, 0);
      return finalize(
        p,
        "Прямая линия: ровность и направление (горизонталь), не привязка к месту."
      );
    }
    case "diagonal": {
      const exp = Math.atan2(0.6, 0.7);
      const p = scoreLineFamily(pts, exp);
      return finalize(p, "Диагональ: угол и прямолинейность, положение свободное.");
    }
    case "square":
      return scoreSquareForm(pts);
    case "triangle":
      return scoreTriangleForm(pts);
    default:
      return scoreCircleForm(pts);
  }
}
