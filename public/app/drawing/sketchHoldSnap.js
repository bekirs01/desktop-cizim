import { trySketchToCircleShape } from "./sketchToCircle.js";
import { isStrokeClosedHint, trySketchToLineShape } from "./sketchToLine.js";

/**
 * После удержания: круг (если контур замкнутый) или прямая линия.
 */
export function trySnapFreehandToShape(stroke, fill) {
  const pts = stroke?.points;
  if (!pts || pts.length < 6) return null;
  if (isStrokeClosedHint(pts)) {
    if (pts.length < 10) return null;
    const c = trySketchToCircleShape(stroke, fill);
    if (c) return c;
    return null;
  }
  return trySketchToLineShape(stroke);
}
