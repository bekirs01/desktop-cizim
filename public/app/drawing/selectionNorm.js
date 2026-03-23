import { getThumbIndexDistance, getHandSize } from "../gestures/handGeometry.js";

export function normRectsIntersect(a, b) {
  const ax0 = Math.min(a.x0, a.x1), ax1 = Math.max(a.x0, a.x1);
  const ay0 = Math.min(a.y0, a.y1), ay1 = Math.max(a.y0, a.y1);
  const bx0 = Math.min(b.x0, b.x1), bx1 = Math.max(b.x0, b.x1);
  const by0 = Math.min(b.y0, b.y1), by1 = Math.max(b.y0, b.y1);
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}

export function strokeNormBBox(stroke) {
  const pts = stroke?.points;
  if (!pts?.length) return null;
  let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
  for (const pt of pts) {
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

export function shapeNormBBox(sh) {
  if (!sh?.type) return null;
  if (sh.type === "circle") {
    const pad = sh.r || 0.02;
    return { x0: sh.cx - pad, y0: sh.cy - pad, x1: sh.cx + pad, y1: sh.cy + pad };
  }
  if (sh.type === "rect" || sh.type === "ellipse") {
    const x0 = Math.min(sh.x, sh.x + sh.w), x1 = Math.max(sh.x, sh.x + sh.w);
    const y0 = Math.min(sh.y, sh.y + sh.h), y1 = Math.max(sh.y, sh.y + sh.h);
    return { x0, y0, x1, y1 };
  }
  if (sh.type === "line" || sh.type === "arrow") {
    return {
      x0: Math.min(sh.x1, sh.x2),
      y0: Math.min(sh.y1, sh.y2),
      x1: Math.max(sh.x1, sh.x2),
      y1: Math.max(sh.y1, sh.y2),
    };
  }
  if (sh.type === "triangle") {
    return {
      x0: Math.min(sh.x1, sh.x2, sh.x3),
      y0: Math.min(sh.y1, sh.y2, sh.y3),
      x1: Math.max(sh.x1, sh.x2, sh.x3),
      y1: Math.max(sh.y1, sh.y2, sh.y3),
    };
  }
  if (sh.type === "text" && sh.text) {
    const approxW = Math.min(0.35, (String(sh.text).length || 1) * 0.018);
    const approxH = (sh.fontSize || 24) / 480;
    return { x0: sh.x, y0: sh.y - approxH, x1: sh.x + approxW, y1: sh.y + approxH * 0.35 };
  }
  return null;
}

export function pickSelectionInRect(rect, strokesArr, shapesArr) {
  const strokeIdx = [];
  const shapeIdx = [];
  strokesArr.forEach((st, i) => {
    const bb = strokeNormBBox(st);
    if (bb && normRectsIntersect(rect, bb)) strokeIdx.push(i);
  });
  shapesArr.forEach((sh, i) => {
    const bb = shapeNormBBox(sh);
    if (bb && normRectsIntersect(rect, bb)) shapeIdx.push(i);
  });
  return { strokeIdx, shapeIdx };
}

export function selectionUnionBBoxFromSel(sel, strokesArr, shapesArr) {
  if (!sel || (!sel.strokeIdx.length && !sel.shapeIdx.length)) return null;
  let bb = null;
  const grow = (b) => {
    if (!b) return;
    if (!bb) bb = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    else {
      bb.x0 = Math.min(bb.x0, b.x0);
      bb.y0 = Math.min(bb.y0, b.y0);
      bb.x1 = Math.max(bb.x1, b.x1);
      bb.y1 = Math.max(bb.y1, b.y1);
    }
  };
  for (const i of sel.strokeIdx) grow(strokeNormBBox(strokesArr[i]));
  for (const i of sel.shapeIdx) grow(shapeNormBBox(shapesArr[i]));
  return bb;
}

export function pointInNormRect(px, py, r, pad = 0.012) {
  const x0 = Math.min(r.x0, r.x1) - pad, x1 = Math.max(r.x0, r.x1) + pad;
  const y0 = Math.min(r.y0, r.y1) - pad, y1 = Math.max(r.y0, r.y1) + pad;
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

export function clampNorm(v) {
  return Math.max(0, Math.min(1, v));
}

export function offsetStrokeNorm(stroke, dx, dy) {
  if (!stroke?.points) return;
  stroke.points = stroke.points.map((p) => ({ x: clampNorm(p.x + dx), y: clampNorm(p.y + dy) }));
}

export function offsetShapeNorm(sh, dx, dy) {
  if (sh.type === "circle") {
    sh.cx = clampNorm(sh.cx + dx);
    sh.cy = clampNorm(sh.cy + dy);
  } else if (sh.type === "rect" || sh.type === "ellipse") {
    sh.x = clampNorm(sh.x + dx);
    sh.y = clampNorm(sh.y + dy);
  } else if (sh.type === "line" || sh.type === "arrow") {
    sh.x1 = clampNorm(sh.x1 + dx);
    sh.y1 = clampNorm(sh.y1 + dy);
    sh.x2 = clampNorm(sh.x2 + dx);
    sh.y2 = clampNorm(sh.y2 + dy);
  } else if (sh.type === "triangle") {
    sh.x1 = clampNorm(sh.x1 + dx);
    sh.y1 = clampNorm(sh.y1 + dy);
    sh.x2 = clampNorm(sh.x2 + dx);
    sh.y2 = clampNorm(sh.y2 + dy);
    sh.x3 = clampNorm(sh.x3 + dx);
    sh.y3 = clampNorm(sh.y3 + dy);
  } else if (sh.type === "text") {
    sh.x = clampNorm(sh.x + dx);
    sh.y = clampNorm(sh.y + dy);
  }
}

export function applySelectionOffset(sel, dx, dy, strokesArr, shapesArr) {
  if (!sel) return;
  for (const i of sel.strokeIdx) {
    const st = strokesArr[i];
    if (st?.points) offsetStrokeNorm(st, dx, dy);
  }
  for (const i of sel.shapeIdx) {
    const sh = shapesArr[i];
    if (sh) offsetShapeNorm(sh, dx, dy);
  }
}

export function landmarkZ(lm) {
  return typeof lm?.z === "number" && Number.isFinite(lm.z) ? lm.z : 0;
}

export function pointSegDistNorm(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-14) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function getActivePinchDepthRel(hand) {
  if (!hand || hand.length < 9) return 0;
  const zw = landmarkZ(hand[0]);
  const zp = (landmarkZ(hand[4]) + landmarkZ(hand[8])) / 2;
  const relZ = zp - zw;
  const yPinch = (hand[4].y + hand[8].y) / 2;
  const yWrist = hand[0].y;
  const relY = yPinch - yWrist;
  const hasZ = Math.abs(zw) > 1e-6 || Math.abs(zp) > 1e-6;
  return hasZ ? relZ : relY * 0.55;
}

export function isThumbIndexSpreadGate(hand) {
  if (!hand || hand.length < 9) return false;
  const d = getThumbIndexDistance(hand);
  const hs = getHandSize(hand);
  const spreadMin = Math.max(0.065, hs * 0.32);
  const spreadMax = Math.max(spreadMin + 0.04, hs * 3.5);
  return d >= spreadMin && d <= spreadMax;
}

export function getOffHandForSelectGate(handLandmarks, activeHandIdx, embedTrackBothHands, cachedOffHandLandmark) {
  if (embedTrackBothHands && handLandmarks && handLandmarks.length >= 2 && activeHandIdx >= 0) {
    const other = handLandmarks.find((_, i) => i !== activeHandIdx);
    return other || null;
  }
  return cachedOffHandLandmark;
}

export function scaleStrokeNorm(stroke, cx, cy, s) {
  if (!stroke?.points || s === 1) return;
  stroke.points = stroke.points.map((p) => ({
    x: clampNorm(cx + (p.x - cx) * s),
    y: clampNorm(cy + (p.y - cy) * s),
  }));
}

export function scaleShapeNorm(sh, cx, cy, s) {
  if (!sh || s === 1) return;
  if (sh.type === "circle") {
    sh.cx = clampNorm(cx + (sh.cx - cx) * s);
    sh.cy = clampNorm(cy + (sh.cy - cy) * s);
    sh.r = Math.max(0.004, (sh.r || 0.02) * s);
  } else if (sh.type === "rect" || sh.type === "ellipse") {
    const w0 = sh.w, h0 = sh.h;
    const ccx = sh.x + w0 / 2, ccy = sh.y + h0 / 2;
    const nccx = cx + (ccx - cx) * s;
    const nccy = cy + (ccy - cy) * s;
    sh.w = w0 * s;
    sh.h = h0 * s;
    sh.x = nccx - sh.w / 2;
    sh.y = nccy - sh.h / 2;
  } else if (sh.type === "line" || sh.type === "arrow") {
    sh.x1 = clampNorm(cx + (sh.x1 - cx) * s);
    sh.y1 = clampNorm(cy + (sh.y1 - cy) * s);
    sh.x2 = clampNorm(cx + (sh.x2 - cx) * s);
    sh.y2 = clampNorm(cy + (sh.y2 - cy) * s);
  } else if (sh.type === "triangle") {
    sh.x1 = clampNorm(cx + (sh.x1 - cx) * s);
    sh.y1 = clampNorm(cy + (sh.y1 - cy) * s);
    sh.x2 = clampNorm(cx + (sh.x2 - cx) * s);
    sh.y2 = clampNorm(cy + (sh.y2 - cy) * s);
    sh.x3 = clampNorm(cx + (sh.x3 - cx) * s);
    sh.y3 = clampNorm(cy + (sh.y3 - cy) * s);
  } else if (sh.type === "text") {
    sh.x = clampNorm(cx + (sh.x - cx) * s);
    sh.y = clampNorm(cy + (sh.y - cy) * s);
    sh.fontSize = Math.max(8, Math.min(220, (sh.fontSize || 24) * s));
  }
}

export function applySelectionScale(sel, scaleMult, strokesArr, shapesArr) {
  if (!sel || scaleMult === 1) return;
  const ub = selectionUnionBBoxFromSel(sel, strokesArr, shapesArr);
  if (!ub) return;
  const cx = (ub.x0 + ub.x1) / 2, cy = (ub.y0 + ub.y1) / 2;
  for (const i of sel.strokeIdx) {
    const st = strokesArr[i];
    if (st?.points) scaleStrokeNorm(st, cx, cy, scaleMult);
  }
  for (const i of sel.shapeIdx) {
    const sh = shapesArr[i];
    if (sh) scaleShapeNorm(sh, cx, cy, scaleMult);
  }
}

export function screenRectFromNormMarquee(x0, y0, x1, y1, w, h, sx) {
  const xd0 = Math.min(x0, x1), xd1 = Math.max(x0, x1);
  const yd0 = Math.min(y0, y1), yd1 = Math.max(y0, y1);
  const px0 = sx(xd0), px1 = sx(xd1);
  return {
    left: Math.min(px0, px1),
    top: yd0 * h,
    rw: Math.max(1, Math.abs(px1 - px0)),
    rh: Math.max(1, (yd1 - yd0) * h),
  };
}
