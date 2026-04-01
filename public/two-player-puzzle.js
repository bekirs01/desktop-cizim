import { HAND_CONNECTIONS } from "./app/config/landmarks.js";

const video = document.getElementById("video");
const canvas = document.getElementById("stageCanvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const statusText = document.getElementById("statusText");
const timerText = document.getElementById("timerText");
const captureBtn = document.getElementById("captureBtn");
const reshuffleBtn = document.getElementById("reshuffleBtn");
const gridSizeSelect = document.getElementById("gridSizeSelect");

const MIRROR = true;

let gridSize = 3;
let handLandmarker = null;
let animationId = 0;
let stream = null;
let winner = null;
let gameStartedAt = 0;

let nextTrackId = 1;
let prevTracks = [];
const pinchStateByTrack = new Map();
const activeDrags = new Map();
let cachedRawHands = [];
let lastDetectMs = 0;
let detectIntervalMs = 33;
let lowPerfMode = false;
let lastFrameMs = 0;

let boardRects = [];
let boards = [];

function setStatus(text, isWinner = false) {
  statusText.textContent = text;
  statusText.classList.toggle("winner", !!isWinner);
}

function fitCanvasToViewport() {
  const w = Math.max(640, Math.floor(window.innerWidth));
  const h = Math.max(360, Math.floor(window.innerHeight - 128));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function drawVideoFrame() {
  const w = canvas.width;
  const h = canvas.height;
  if (!video.videoWidth || !video.videoHeight) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (MIRROR) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }
}

function toCanvasPoint(p) {
  return {
    x: (MIRROR ? 1 - p.x : p.x) * canvas.width,
    y: p.y * canvas.height,
  };
}

function handSize(hand) {
  if (!hand || hand.length < 10) return 0.2;
  return Math.hypot(hand[0].x - hand[9].x, hand[0].y - hand[9].y);
}

function isPinching(hand, prev) {
  if (!hand || hand.length < 9) return false;
  const d = Math.hypot(hand[8].x - hand[4].x, hand[8].y - hand[4].y);
  const hs = handSize(hand);
  const touchTh = Math.max(0.025, Math.min(0.085, hs * 0.32));
  const releaseTh = touchTh * 1.38;
  return prev ? d < releaseTh : d < touchTh;
}

function trackHands(rawHands) {
  const current = rawHands.map((hand) => {
    const p = toCanvasPoint(hand[8]);
    return { hand, x: p.x, y: p.y };
  });
  const usedPrev = new Set();
  const tracked = [];
  for (const cur of current) {
    let best = null;
    let bestDist = Infinity;
    for (const prev of prevTracks) {
      if (usedPrev.has(prev.id)) continue;
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (d < bestDist) {
        bestDist = d;
        best = prev;
      }
    }
    const id = best && bestDist < 110 ? best.id : nextTrackId++;
    if (best) usedPrev.add(best.id);
    tracked.push({ id, hand: cur.hand, x: cur.x, y: cur.y });
  }
  prevTracks = tracked.map((h) => ({ id: h.id, x: h.x, y: h.y }));
  return tracked;
}

function getBoardRects() {
  const w = canvas.width;
  const h = canvas.height;
  const sidePad = Math.max(14, Math.floor(w * 0.02));
  const gap = Math.max(32, Math.floor(w * 0.05));
  let size = Math.min((w - sidePad * 2 - gap) / 2, h * 0.68);
  size = Math.max(160, Math.floor(size));
  const total = size * 2 + gap;
  const left = (w - total) / 2;
  const top = Math.max(92, Math.floor((h - size) * 0.56));
  return [
    { x: left, y: top, size, owner: 0, title: "Игрок 1" },
    { x: left + size + gap, y: top, size, owner: 1, title: "Игрок 2" },
  ];
}

function shuffledTiles() {
  const cellCount = gridSize * gridSize;
  const arr = Array.from({ length: cellCount }, (_, i) => i);
  do {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } while (arr.every((v, i) => v === i));
  return arr;
}

function captureHalfImage(side) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const tmp = document.createElement("canvas");
  tmp.width = vw;
  tmp.height = vh;
  const tctx = tmp.getContext("2d");
  if (MIRROR) {
    tctx.save();
    tctx.scale(-1, 1);
    tctx.drawImage(video, -vw, 0, vw, vh);
    tctx.restore();
  } else {
    tctx.drawImage(video, 0, 0, vw, vh);
  }
  const halfW = Math.floor(vw / 2);
  const sx = side === 0 ? 0 : halfW;
  const out = document.createElement("canvas");
  out.width = halfW;
  out.height = vh;
  const octx = out.getContext("2d");
  octx.drawImage(tmp, sx, 0, halfW, vh, 0, 0, out.width, out.height);
  return out;
}

function startPuzzleFromCapture() {
  gridSize = Number(gridSizeSelect?.value || 3) === 4 ? 4 : 3;
  boards = [0, 1].map((side) => ({
    source: captureHalfImage(side),
    tiles: shuffledTiles(),
    solved: false,
    moveCount: 0,
    solvedSince: 0,
    confirmed: false,
    locked: false,
    finishTimeSec: null,
  }));
  winner = null;
  gameStartedAt = performance.now();
  activeDrags.clear();
  setStatus(`Пазл ${gridSize}x${gridSize} начался. Щепоткой (указательный + большой) берите и перемещайте фрагменты.`);
}

function getCellFromPoint(rect, x, y) {
  if (x < rect.x || y < rect.y || x > rect.x + rect.size || y > rect.y + rect.size) return -1;
  const cell = rect.size / gridSize;
  const cx = Math.min(gridSize - 1, Math.max(0, Math.floor((x - rect.x) / cell)));
  const cy = Math.min(gridSize - 1, Math.max(0, Math.floor((y - rect.y) / cell)));
  return cy * gridSize + cx;
}

function findTileCell(board, tileId) {
  return board.tiles.findIndex((id) => id === tileId);
}

function tileBeingDragged(boardIndex, tileId) {
  for (const d of activeDrags.values()) {
    if (d.boardIndex === boardIndex && d.tileId === tileId) return true;
  }
  return false;
}

function beginDrag(trackId, x, y) {
  if (!boards.length) return;
  const boardIndex = x < canvas.width / 2 ? 0 : 1;
  const rect = boardRects[boardIndex];
  const board = boards[boardIndex];
  if (!rect || !board || board.locked) return;
  const cellIdx = getCellFromPoint(rect, x, y);
  if (cellIdx < 0) return;
  const tileId = board.tiles[cellIdx];
  if (tileBeingDragged(boardIndex, tileId)) return;
  const cell = rect.size / gridSize;
  const cellX = rect.x + (cellIdx % gridSize) * cell;
  const cellY = rect.y + Math.floor(cellIdx / gridSize) * cell;
  activeDrags.set(trackId, {
    boardIndex,
    tileId,
    fromCell: cellIdx,
    x,
    y,
    dx: x - cellX,
    dy: y - cellY,
  });
}

function updateDrag(trackId, x, y) {
  const d = activeDrags.get(trackId);
  if (!d) return;
  d.x = x;
  d.y = y;
}

function releaseDrag(trackId) {
  const d = activeDrags.get(trackId);
  if (!d) return;
  const board = boards[d.boardIndex];
  const rect = boardRects[d.boardIndex];
  if (!board || !rect || board.locked) {
    activeDrags.delete(trackId);
    return;
  }
  const target = getCellFromPoint(rect, d.x, d.y);
  const src = findTileCell(board, d.tileId);
  if (target >= 0 && src >= 0 && target !== src) {
    const otherTile = board.tiles[target];
    board.tiles[target] = d.tileId;
    board.tiles[src] = otherTile;
    board.moveCount++;
  }
  board.solved = board.tiles.every((v, i) => v === i);
  if (!board.solved) {
    board.solvedSince = 0;
    board.confirmed = false;
  }
  activeDrags.delete(trackId);
}

function updateWinState(now) {
  if (!boards.length) return;
  for (let i = 0; i < boards.length; i++) {
    const b = boards[i];
    const solved = b.tiles.every((v, idx) => v === idx);
    b.solved = solved;
    if (!solved || b.moveCount < 3) {
      b.solvedSince = 0;
      b.confirmed = false;
      continue;
    }
    if (!b.solvedSince) b.solvedSince = now;
    if (!b.confirmed && now - b.solvedSince >= 700) {
      b.confirmed = true;
      b.locked = true;
      b.finishTimeSec = gameStartedAt ? (now - gameStartedAt) / 1000 : null;
      if (winner == null) {
        winner = i;
        setStatus(`Первым завершил Игрок ${winner + 1}. Второй игрок может продолжать.`, true);
      }
    }
  }
  const b1 = boards[0];
  const b2 = boards[1];
  if (b1?.locked && b2?.locked) {
    const t1 = b1.finishTimeSec ?? 0;
    const t2 = b2.finishTimeSec ?? 0;
    const best = t1 <= t2 ? 1 : 2;
    setStatus(`Итог: Игрок 1 — ${t1.toFixed(1)} c, Игрок 2 — ${t2.toFixed(1)} c. Победил Игрок ${best}.`, true);
  }
}

function drawHandOverlay(hand, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = toCanvasPoint(hand[a]);
    const pb = toCanvasPoint(hand[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  if (!lowPerfMode) {
    ctx.fillStyle = color;
    for (let i = 0; i < hand.length; i++) {
      const p = toCanvasPoint(hand[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 8 || i === 4 ? 4 : 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBoard(board, rect, boardIndex) {
  const cell = rect.size / gridSize;
  const sW = board.source.width / gridSize;
  const sH = board.source.height / gridSize;
  ctx.save();
  ctx.fillStyle = "rgba(11, 11, 18, 0.84)";
  ctx.fillRect(rect.x - 12, rect.y - 42, rect.size + 24, rect.size + 54);
  ctx.strokeStyle = boardIndex === 0 ? "rgba(99,102,241,0.9)" : "rgba(249,115,22,0.9)";
  ctx.lineWidth = 2.2;
  ctx.strokeRect(rect.x - 12, rect.y - 42, rect.size + 24, rect.size + 54);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "bold 18px system-ui";
  const suffix = board.confirmed
    ? ` - ГОТОВО (${(board.finishTimeSec ?? 0).toFixed(1)} c)`
    : (winner === boardIndex ? " - ПОБЕДА" : "");
  ctx.fillText(`${rect.title}${suffix}`, rect.x, rect.y - 16);

  for (let cellIdx = 0; cellIdx < board.tiles.length; cellIdx++) {
    const tileId = board.tiles[cellIdx];
    if (tileBeingDragged(boardIndex, tileId)) continue;
    const sx = (tileId % gridSize) * sW;
    const sy = Math.floor(tileId / gridSize) * sH;
    const dx = rect.x + (cellIdx % gridSize) * cell;
    const dy = rect.y + Math.floor(cellIdx / gridSize) * cell;
    ctx.drawImage(board.source, sx, sy, sW, sH, dx, dy, cell, cell);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridSize; i++) {
    const p = rect.x + i * cell;
    ctx.beginPath();
    ctx.moveTo(p, rect.y);
    ctx.lineTo(p, rect.y + rect.size);
    ctx.stroke();
    const q = rect.y + i * cell;
    ctx.beginPath();
    ctx.moveTo(rect.x, q);
    ctx.lineTo(rect.x + rect.size, q);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDraggedTiles() {
  for (const d of activeDrags.values()) {
    const board = boards[d.boardIndex];
    if (!board) continue;
    const rect = boardRects[d.boardIndex];
    const cell = rect.size / gridSize;
    const sW = board.source.width / gridSize;
    const sH = board.source.height / gridSize;
    const tileId = d.tileId;
    const sx = (tileId % gridSize) * sW;
    const sy = Math.floor(tileId / gridSize) * sH;
    const dx = d.x - d.dx;
    const dy = d.y - d.dy;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12;
    ctx.drawImage(board.source, sx, sy, sW, sH, dx, dy, cell, cell);
    ctx.restore();
  }
}

function processHands(rawHands) {
  const tracked = trackHands(rawHands);
  const seenIds = new Set();
  for (const t of tracked) {
    seenIds.add(t.id);
    const prev = pinchStateByTrack.get(t.id) || false;
    const now = isPinching(t.hand, prev);
    if (now && !prev) beginDrag(t.id, t.x, t.y);
    if (now) updateDrag(t.id, t.x, t.y);
    if (!now && prev) releaseDrag(t.id);
    pinchStateByTrack.set(t.id, now);
  }
  for (const [id, prevPinch] of [...pinchStateByTrack.entries()]) {
    if (seenIds.has(id)) continue;
    if (prevPinch) releaseDrag(id);
    pinchStateByTrack.delete(id);
  }
  return tracked;
}

function drawGuides() {
  boardRects = getBoardRects();
  for (const rect of boardRects) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(rect.x, rect.y, rect.size, rect.size);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "600 15px system-ui";
    ctx.fillText(`${rect.title} — поле`, rect.x, rect.y - 10);
    ctx.restore();
  }
}

function renderLoop() {
  const now = performance.now();
  if (!lastFrameMs) lastFrameMs = now;
  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  lowPerfMode = dt > 0.038;
  detectIntervalMs = lowPerfMode ? 50 : 33;
  fitCanvasToViewport();
  drawVideoFrame();
  drawGuides();

  let rawHands = cachedRawHands;
  if (handLandmarker && (!lastDetectMs || now - lastDetectMs >= detectIntervalMs)) {
    const res = handLandmarker.detectForVideo(video, now);
    rawHands = res.landmarks || [];
    cachedRawHands = rawHands;
    lastDetectMs = now;
  }
  const tracked = processHands(rawHands);
  updateWinState(now);

  if (boards.length === 2) {
    drawBoard(boards[0], boardRects[0], 0);
    drawBoard(boards[1], boardRects[1], 1);
    drawDraggedTiles();
  }

  for (const t of tracked) {
    const boardIndex = t.x < canvas.width / 2 ? 0 : 1;
    const color = boardIndex === 0 ? "rgba(99,102,241,0.95)" : "rgba(249,115,22,0.95)";
    drawHandOverlay(t.hand, color);
  }

  if (!boards.length) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(20, 20, 580, 74);
    ctx.fillStyle = "white";
    ctx.font = "600 24px system-ui";
    ctx.fillText("Нажмите «Сфотографировать и начать»", 34, 56);
    ctx.font = "14px system-ui";
    ctx.fillText("Игрок 1 — слева, Игрок 2 — справа.", 34, 80);
  }

  if (timerText) {
    if (boards.length && gameStartedAt) {
      const elapsed = (now - gameStartedAt) / 1000;
      const t1 = boards[0]?.finishTimeSec;
      const t2 = boards[1]?.finishTimeSec;
      const parts = [`Время: ${elapsed.toFixed(1)} c`];
      if (t1 != null) parts.push(`Игрок 1: ${t1.toFixed(1)} c`);
      if (t2 != null) parts.push(`Игрок 2: ${t2.toFixed(1)} c`);
      timerText.textContent = parts.join(" | ");
    } else {
      timerText.textContent = "Время: 0.0 c";
    }
  }

  animationId = requestAnimationFrame(renderLoop);
}

async function initCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

async function initHandModel() {
  const {
    FilesetResolver,
    HandLandmarker,
  } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 4,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
}

async function init() {
  fitCanvasToViewport();
  setStatus("Запрашиваем доступ к камере...");
  await initCamera();
  renderLoop();
  setStatus("Камера запущена. Загружаем модель рук...");
  try {
    await initHandModel();
    setStatus("Готово. Отслеживание 4 рук активно. Сделайте фото и начните пазл.");
  } catch (err) {
    console.error(err);
    setStatus("Камера работает, но модель рук не загрузилась: " + (err?.message || err));
  }
}

captureBtn.addEventListener("click", () => {
  if (!video.videoWidth || !video.videoHeight) return;
  startPuzzleFromCapture();
});

reshuffleBtn.addEventListener("click", () => {
  if (!boards.length) return;
  gridSize = Number(gridSizeSelect?.value || 3) === 4 ? 4 : 3;
  boards.forEach((b) => {
    b.tiles = shuffledTiles();
    b.solved = false;
    b.moveCount = 0;
    b.solvedSince = 0;
    b.confirmed = false;
    b.locked = false;
    b.finishTimeSec = null;
  });
  gameStartedAt = performance.now();
  winner = null;
  activeDrags.clear();
  setStatus(`Фрагменты перемешаны снова (${gridSize}x${gridSize}).`);
});

window.addEventListener("resize", fitCanvasToViewport);
window.addEventListener("beforeunload", () => {
  if (animationId) cancelAnimationFrame(animationId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
});

init().catch((err) => {
  console.error(err);
  setStatus("Камера не запустилась: " + (err?.message || err));
});
