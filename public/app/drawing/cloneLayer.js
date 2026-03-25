export function cloneStroke(stroke) {
  if (!stroke) return stroke;
  const points = Array.isArray(stroke.points) ? stroke.points.map((p) => ({ x: p.x, y: p.y })) : [];
  return { ...stroke, points };
}

export function cloneShape(shape) {
  if (!shape) return shape;
  const c = { ...shape };
  if (c.type === "image") delete c._img;
  return c;
}

export function clonePageLayer(strokesArr = [], shapesArr = []) {
  return {
    strokes: strokesArr.map(cloneStroke),
    shapes: shapesArr.map(cloneShape),
  };
}
