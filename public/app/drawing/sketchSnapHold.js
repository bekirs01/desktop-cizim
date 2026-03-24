/** После последнего заметного шага штриха (см. SIGNIFICANT в script.js) столько мс — можно копить удержание. */
export const SKETCH_SNAP_QUIET_MS = 280;
/** Указатель ушёл от опоры дальше — сброс; дрожание внутри этого радиуса (норм.) не сбивает таймер. */
export const SKETCH_SNAP_WANDER_NORM = 0.095;

/**
 * @param {{ holdMs: number, holdRef: { x: number, y: number } | null }} state
 * @returns {boolean} true → попробовать snap (один раз за накопление)
 */
export function tickSketchSnapHold(state, ptr, lastSignificantPointAt, ptsLen, minPts, holdTargetMs, pollMs) {
  if (ptsLen < minPts || !ptr) {
    state.holdMs = 0;
    state.holdRef = null;
    return false;
  }
  const now = performance.now();
  if (!lastSignificantPointAt || now - lastSignificantPointAt < SKETCH_SNAP_QUIET_MS) {
    state.holdMs = 0;
    state.holdRef = null;
    return false;
  }
  if (!state.holdRef) {
    state.holdRef = { x: ptr.x, y: ptr.y };
    state.holdMs = pollMs;
    return false;
  }
  const d = Math.hypot(ptr.x - state.holdRef.x, ptr.y - state.holdRef.y);
  if (d > SKETCH_SNAP_WANDER_NORM) {
    state.holdRef = { x: ptr.x, y: ptr.y };
    state.holdMs = pollMs;
    return false;
  }
  state.holdMs += pollMs;
  if (state.holdMs >= holdTargetMs) {
    state.holdMs = 0;
    state.holdRef = { x: ptr.x, y: ptr.y };
    return true;
  }
  return false;
}

export function resetSnapHoldState(state) {
  state.holdMs = 0;
  state.holdRef = null;
}
