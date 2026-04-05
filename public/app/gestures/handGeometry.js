export function isIndexFingerExtended(hand) {
  if (!hand || hand.length < 21) return false;
  const idxTip = hand[8], idxMcp = hand[5];
  const midTip = hand[12], ringTip = hand[16];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lenIdx = d(idxTip, idxMcp);
  const distToMid = d(idxTip, midTip);
  const distToRing = d(idxTip, ringTip);
  if (distToMid < 0.07 || distToRing < 0.07) return false;
  const lenMid = d(midTip, hand[9]);
  const lenRing = d(ringTip, hand[13]);
  return lenIdx > 0.04 && lenIdx > lenMid * 0.8 && lenIdx > lenRing * 0.8;
}

export function isTwoFingersExtended(hand) {
  if (!hand || hand.length < 21) return false;
  const idxTip = hand[8], midTip = hand[12], idxPip = hand[6], midPip = hand[10];
  const ringTip = hand[16], pinkyTip = hand[20];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const handSize = d(hand[0], hand[9]);
  const lenIdx = d(idxTip, hand[5]);
  const lenMid = d(midTip, hand[9]);
  const lenRing = d(ringTip, hand[13]);
  const lenPinky = d(pinkyTip, hand[17]);
  const distIdxMid = d(idxTip, midTip);
  const minExtended = Math.max(0.025, handSize * 0.12);
  const minVGap = Math.max(0.01, handSize * 0.2);
  const maxVGap = handSize * 1.5;
  const tipToPipMin = Math.max(0.018, handSize * 0.1);
  const tipToPipIdx = d(idxTip, idxPip);
  const tipToPipMid = d(midTip, midPip);
  const maxBentLen = handSize * 0.5;
  const minRatio = 1.35;
  return (
    lenIdx >= minExtended &&
    lenMid >= minExtended &&
    tipToPipIdx > tipToPipMin &&
    tipToPipMid > tipToPipMin &&
    lenRing < maxBentLen &&
    lenPinky < maxBentLen &&
    lenIdx > lenRing * minRatio &&
    lenMid > lenRing * minRatio &&
    lenIdx > lenPinky * minRatio &&
    lenMid > lenPinky * minRatio &&
    distIdxMid > minVGap &&
    distIdxMid < maxVGap
  );
}

export function getTwoFingerPosition(hand) {
  if (!hand || hand.length < 13 || !isTwoFingersExtended(hand)) return null;
  const idx = hand[8], mid = hand[12];
  return { x: (idx.x + mid.x) / 2, y: (idx.y + mid.y) / 2 };
}

export function isFistClenched(hand) {
  if (!hand || hand.length < 21) return false;
  const idx = hand[8], mid = hand[12], ring = hand[16], pinky = hand[20];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const maxDist = 0.12;
  return d(idx, mid) < maxDist && d(mid, ring) < maxDist && d(ring, pinky) < maxDist && d(idx, pinky) < 0.16;
}

export function getHandGrabPoint(hand) {
  if (!hand || hand.length < 21) return null;
  if (!isFistClenched(hand)) return null;
  const idx = hand[8], mid = hand[12], ring = hand[16], pinky = hand[20];
  return {
    x: (idx.x + mid.x + ring.x + pinky.x) / 4,
    y: (idx.y + mid.y + ring.y + pinky.y) / 4,
  };
}

export function getIndexFingerTip(hand, requireExtended = false) {
  if (!hand || hand.length < 9) return null;
  const tip = hand[8];
  if (!tip) return null;
  if (requireExtended && !isIndexFingerExtended(hand)) return null;
  return { x: tip.x, y: tip.y };
}

export function getThumbIndexDistance(hand) {
  if (!hand || hand.length < 9) return Infinity;
  const idxTip = hand[8], thumbTip = hand[4];
  return Math.hypot(idxTip.x - thumbTip.x, idxTip.y - thumbTip.y);
}

/** Orta parmak ucu (12) ile başparmak ucu (4) arası mesafe (normalize). */
export function getThumbMiddleDistance(hand) {
  if (!hand || hand.length < 13) return Infinity;
  const midTip = hand[12], thumbTip = hand[4];
  return Math.hypot(midTip.x - thumbTip.x, midTip.y - thumbTip.y);
}

/**
 * Orta+b başparmak “baskın” pinch: işaret+b başparmaktan belirgin şekilde daha yakın.
 * Böylece normal çizim (işaret+başparmak) ile karışmaz.
 */
export function isMiddleThumbPinchDominant(hand) {
  if (!hand || hand.length < 13) return false;
  const dTm = getThumbMiddleDistance(hand);
  const dTi = getThumbIndexDistance(hand);
  const pinchStart = getPinchStartThreshold(hand);
  return dTm < pinchStart && dTm < dTi * 0.88;
}

/**
 * Orta+b başparmak dokunuşu — gevşek eşik + histerezis (titremeyi azaltır).
 * wasTouching true iken bırakma için daha geniş eşik kullanılır.
 * İşaret parmağı başparmakta ise (çizim pinch) orta jest sayılmaz.
 */
export function stepMiddleThumbTouching(hand, wasTouching) {
  if (!hand || hand.length < 13) return false;
  const dTm = getThumbMiddleDistance(hand);
  const dTi = getThumbIndexDistance(hand);
  const hs = getHandSize(hand);
  const touchTh = Math.max(0.048, Math.min(0.16, hs * 0.58));
  const releaseTh = Math.max(touchTh * 1.32, touchTh + 0.016);
  const indexClearlyPinching = dTi < getPinchStartThreshold(hand) * 0.92 && dTi < dTm * 0.82;
  if (wasTouching) {
    if (dTm > releaseTh) return false;
    if (indexClearlyPinching) return false;
    return true;
  }
  if (indexClearlyPinching) return false;
  return dTm < touchTh && dTm < dTi * 0.98;
}

/** Полностью открытая ладонь: все 4 пальца разогнуты и раздвинуты. */
export function isOpenPalm(hand) {
  if (!hand || hand.length < 21) return false;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const hs = Math.max(0.12, getHandSize(hand));
  const extMin = hs * 0.34;
  const spreadMin = hs * 0.2;
  const idxExt = d(hand[8], hand[5]) > extMin;
  const midExt = d(hand[12], hand[9]) > extMin;
  const ringExt = d(hand[16], hand[13]) > extMin;
  const pinkExt = d(hand[20], hand[17]) > extMin;
  const spread =
    d(hand[8], hand[12]) > spreadMin &&
    d(hand[12], hand[16]) > spreadMin * 0.82 &&
    d(hand[16], hand[20]) > spreadMin * 0.72;
  const yOrder =
    hand[8].y < hand[6].y &&
    hand[12].y < hand[10].y &&
    hand[16].y < hand[14].y &&
    hand[20].y < hand[18].y;
  return idxExt && midExt && ringExt && pinkExt && spread && yOrder;
}

export function getHandSize(hand) {
  if (!hand || hand.length < 10) return 0.2;
  return Math.hypot(hand[0].x - hand[9].x, hand[0].y - hand[9].y);
}

export function getPinchStartThreshold(hand) {
  const hs = hand ? getHandSize(hand) : 0.2;
  return Math.max(0.025, Math.min(0.1, hs * 0.28));
}

export function getPinchReleaseThreshold(hand) {
  const hs = hand ? getHandSize(hand) : 0.2;
  return Math.max(0.04, Math.min(0.14, hs * 0.4));
}

export function isIndexThumbPinch(hand) {
  return getThumbIndexDistance(hand) < getPinchStartThreshold(hand);
}

export function getPinchCursorPosition(hand) {
  if (!hand || hand.length < 9) return null;
  if (isTwoFingersExtended(hand)) return null;
  const idxTip = hand[8];
  return { x: idxTip.x, y: idxTip.y };
}

export function getThumbIndexSize(hand) {
  if (!hand || hand.length < 9) return null;
  const thumb = hand[4], idx = hand[8];
  const dx = idx.x - thumb.x, dy = idx.y - thumb.y;
  const dist = Math.hypot(dx, dy);
  return { center: { x: (thumb.x + idx.x) / 2, y: (thumb.y + idx.y) / 2 }, size: dist, dx, dy };
}
