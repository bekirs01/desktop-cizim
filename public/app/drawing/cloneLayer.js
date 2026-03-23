export function cloneStroke(stroke) {
  if (!stroke) return stroke;
  const points = Array.isArray(stroke.points) ? stroke.points.map((p) => ({ x: p.x, y: p.y })) : [];
  return { ...stroke, points };
}

export function cloneShape(shape) {
  return shape ? { ...shape } : shape;
}

export function clonePageLayer(strokesArr = [], shapesArr = []) {
  return {
    strokes: strokesArr.map(cloneStroke),
    shapes: shapesArr.map(cloneShape),
  };
}
