import { HAND_CONNECTIONS } from "./app/config/landmarks.js";

const video = document.getElementById("video");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const statusText = document.getElementById("statusText");
const timerText = document.getElementById("timerText");
const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");

const MIRROR = true;
const GAME_DURATION_SEC = 45;

let handLandmarker = null;
let stream = null;
let raf = 0;
let lastTs = 0;
let running = false;
let startTs = 0;
let endElapsedSec = 0;

let prevTracks = [];
let nextTrackId = 1;
let cachedTracked = [];
let lastDetectMs = 0;
let detectIntervalMs = 33;
let lowPerfMode = false;

const players = [
  createPlayer(0, "Игрок 1", "rgba(99,102,241,0.95)"),
  createPlayer(1, "Игрок 2", "rgba(249,115,22,0.95)"),
];

function createPlayer(index, name, color) {
  return {
    index,
    name,
    color,
    bikeXNorm: 0.5,
    gas: 0,
    steer: 0,
    distance: 0,
    hits: 0,
    finishSec: null,
    obstacles: [],
    spawnAt: 0,
    finished: false,
    hands: { left: null, right: null },
  };
}

function setStatus(text) {
  statusText.textContent = text;
}

function fitCanvas() {
  const w = Math.max(760, window.innerWidth);
  const h = Math.max(420, window.innerHeight - 126);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function toCanvasPoint(p) {
  return {
    x: (MIRROR ? 1 - p.x : p.x) * canvas.width,
    y: p.y * canvas.height,
  };
}

function drawVideo() {
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

function detectHands(ts) {
  if (!handLandmarker) return [];
  const res = handLandmarker.detectForVideo(video, ts);
  const raw = res.landmarks || [];
  const withCenters = raw.map((hand) => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < hand.length; i++) {
      const p = toCanvasPoint(hand[i]);
      sx += p.x;
      sy += p.y;
    }
    return { hand, cx: sx / hand.length, cy: sy / hand.length };
  });

  const tracked = [];
  const used = new Set();
  for (const cur of withCenters) {
    let best = null;
    let bestD = Infinity;
    for (const prev of prevTracks) {
      if (used.has(prev.id)) continue;
      const d = Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy);
      if (d < bestD) {
        bestD = d;
        best = prev;
      }
    }
    const id = best && bestD < 110 ? best.id : nextTrackId++;
    if (best) used.add(best.id);
    tracked.push({ id, ...cur });
  }
  prevTracks = tracked.map((h) => ({ id: h.id, cx: h.cx, cy: h.cy }));
  return tracked;
}

function getTrackedHands(ts) {
  if (!handLandmarker) return cachedTracked;
  if (!lastDetectMs || ts - lastDetectMs >= detectIntervalMs) {
    cachedTracked = detectHands(ts);
    lastDetectMs = ts;
  }
  return cachedTracked;
}

function assignHandsToPlayers(tracked) {
  for (const p of players) {
    p.hands.left = null;
    p.hands.right = null;
  }
  const midX = canvas.width / 2;
  const byPlayer = [[], []];
  for (const t of tracked) {
    const idx = t.cx < midX ? 0 : 1;
    byPlayer[idx].push(t);
  }
  for (let i = 0; i < 2; i++) {
    byPlayer[i].sort((a, b) => a.cx - b.cx);
    if (byPlayer[i][0]) players[i].hands.left = byPlayer[i][0];
    if (byPlayer[i].length > 1) players[i].hands.right = byPlayer[i][byPlayer[i].length - 1];
    else if (byPlayer[i][0]) players[i].hands.right = byPlayer[i][0];
  }
}

function updateControls(dt) {
  for (const p of players) {
    if (p.finished) continue;
    const lh = p.hands.left;
    const rh = p.hands.right;
    if (lh && rh) {
      const ln = { x: lh.cx / canvas.width, y: lh.cy / canvas.height };
      const rn = { x: rh.cx / canvas.width, y: rh.cy / canvas.height };
      // Ayna etkisinden dolayı direksiyon yönünü ters çevir.
      const steerRaw = (rn.y - ln.y) * 2.8;
      p.steer = Math.max(-1, Math.min(1, steerRaw));
      p.gas = Math.max(0, Math.min(1, (0.92 - rn.y) / 0.72));
    } else {
      p.steer *= 0.8;
      p.gas *= 0.85;
    }

    const turnSpeed = 0.75;
    p.bikeXNorm += p.steer * turnSpeed * dt;
    p.bikeXNorm = Math.max(0.12, Math.min(0.88, p.bikeXNorm));
  }
}

function updateWorld(dt, elapsedSec) {
  for (const p of players) {
    if (p.finished) continue;
    const speed = 220 + p.gas * 220;
    p.distance += speed * dt * 0.055;

    if (elapsedSec >= p.spawnAt) {
      // Engel sıklığını bir miktar azalt.
      p.spawnAt = elapsedSec + Math.max(0.95, 1.75 - p.distance * 0.0005);
      const laneCenter = Math.random() * 0.76 + 0.12;
      const width = 0.1 + Math.random() * 0.08;
      p.obstacles.push({
        xNorm: laneCenter,
        yNorm: -0.18,
        wNorm: width,
        hNorm: 0.13 + Math.random() * 0.05,
        speed: 0.23 + Math.random() * 0.13 + p.distance * 0.000015,
      });
    }

    for (const ob of p.obstacles) {
      ob.yNorm += ob.speed * dt;
    }
    p.obstacles = p.obstacles.filter((o) => o.yNorm < 1.22);
  }
}

function checkCollisions() {
  for (const p of players) {
    if (p.finished) continue;
    const bike = { x: p.bikeXNorm, y: 0.86, w: 0.12, h: 0.16 };
    const keep = [];
    for (const o of p.obstacles) {
      const hit =
        Math.abs(o.xNorm - bike.x) < (o.wNorm + bike.w) * 0.5 &&
        Math.abs(o.yNorm - bike.y) < (o.hNorm + bike.h) * 0.5;
      if (hit) {
        p.hits += 1;
        return p.index;
      } else {
        keep.push(o);
      }
    }
    p.obstacles = keep;
  }
  return -1;
}

function drawLane(p, x, y, w, h, elapsedSec) {
  ctx.save();
  ctx.fillStyle = "rgba(8, 10, 18, 0.65)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  // Lane marks.
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  const stride = 46;
  const offs = (elapsedSec * 180) % stride;
  for (let yy = -stride; yy < h + stride; yy += stride) {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y + yy + offs);
    ctx.lineTo(x + w * 0.5, y + yy + offs + 20);
    ctx.stroke();
  }

  // Obstacles.
  for (const o of p.obstacles) {
    const ox = x + (o.xNorm - o.wNorm * 0.5) * w;
    const oy = y + (o.yNorm - o.hNorm * 0.5) * h;
    const ow = o.wNorm * w;
    const oh = o.hNorm * h;
    ctx.fillStyle = "rgba(239,68,68,0.92)";
    ctx.fillRect(ox, oy, ow, oh);
  }

  // Bike.
  const bx = x + p.bikeXNorm * w;
  const by = y + h * 0.86;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.moveTo(bx, by - 26);
  ctx.lineTo(bx - 18, by + 20);
  ctx.lineTo(bx + 18, by + 20);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.arc(bx - 12, by + 20, 8, 0, Math.PI * 2);
  ctx.arc(bx + 12, by + 20, 8, 0, Math.PI * 2);
  ctx.fill();

  // HUD
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "700 18px system-ui";
  ctx.fillText(p.name + (p.finished ? " — ГОТОВО" : ""), x + 10, y + 24);
  ctx.font = "600 14px system-ui";
  ctx.fillStyle = "rgba(229,231,235,0.92)";
  ctx.fillText(`Дистанция: ${p.distance.toFixed(1)} м`, x + 10, y + 46);
  ctx.fillText(`Столкновения: ${p.hits}`, x + 10, y + 64);
  if (p.finishSec != null) {
    ctx.fillStyle = "rgba(34,197,94,0.95)";
    ctx.fillText(`Финиш: ${p.finishSec.toFixed(1)} c`, x + 10, y + 82);
  }

  // Control helper.
  if (p.hands.left && p.hands.right) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.hands.left.cx, p.hands.left.cy);
    ctx.lineTo(p.hands.right.cx, p.hands.right.cy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHands(tracked) {
  if (lowPerfMode) return;
  for (const t of tracked) {
    const color = t.cx < canvas.width / 2 ? "rgba(99,102,241,0.9)" : "rgba(249,115,22,0.9)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = toCanvasPoint(t.hand[a]);
      const p2 = toCanvasPoint(t.hand[b]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }
}

function finishGame(elapsedSec) {
  for (const p of players) {
    if (!p.finished) {
      p.finished = true;
      p.finishSec = elapsedSec;
    }
  }
  running = false;
  endElapsedSec = elapsedSec;
  const score1 = players[0].distance - players[0].hits * 18;
  const score2 = players[1].distance - players[1].hits * 18;
  const win = score1 === score2 ? 0 : score1 > score2 ? 1 : 2;
  const winnerText = win === 0 ? "Ничья!" : `Победил Игрок ${win}.`;
  setStatus(`${winnerText} Очки: Игрок 1 = ${score1.toFixed(1)}, Игрок 2 = ${score2.toFixed(1)}.`);
}

function finishByCrash(loserIndex, elapsedSec) {
  running = false;
  endElapsedSec = elapsedSec;
  const winnerIndex = loserIndex === 0 ? 1 : 0;
  players[loserIndex].finished = true;
  players[winnerIndex].finished = true;
  players[loserIndex].finishSec = elapsedSec;
  players[winnerIndex].finishSec = elapsedSec;
  setStatus(`Игрок ${loserIndex + 1} первым врезался и проиграл. Победил Игрок ${winnerIndex + 1}.`);
}

function startGame() {
  running = true;
  startTs = performance.now();
  endElapsedSec = 0;
  winner = null;
  for (let i = 0; i < players.length; i++) {
    players[i] = createPlayer(i, `Игрок ${i + 1}`, i === 0 ? "rgba(99,102,241,0.95)" : "rgba(249,115,22,0.95)");
  }
  setStatus("Игра запущена. Правая рука — газ, угол рук — поворот. Избегайте препятствий.");
}

function render(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  lowPerfMode = dt > 0.038;
  detectIntervalMs = lowPerfMode ? 50 : 33;

  fitCanvas();
  drawVideo();

  const tracked = getTrackedHands(ts);
  assignHandsToPlayers(tracked);

  const elapsedSec = startTs ? (ts - startTs) / 1000 : 0;
  const worldElapsedSec = running ? elapsedSec : endElapsedSec;
  if (running) {
    updateControls(dt);
    updateWorld(dt, elapsedSec);
    const loser = checkCollisions();
    if (loser >= 0) finishByCrash(loser, elapsedSec);
    else if (elapsedSec >= GAME_DURATION_SEC) finishGame(elapsedSec);
  }

  const lanePad = 14;
  const gap = 20;
  const laneW = (canvas.width - lanePad * 2 - gap) / 2;
  const laneH = canvas.height - 30;
  drawLane(players[0], lanePad, 18, laneW, laneH, worldElapsedSec);
  drawLane(players[1], lanePad + laneW + gap, 18, laneW, laneH, worldElapsedSec);
  drawHands(tracked);

  if (timerText) {
    const shown = running ? Math.min(elapsedSec, GAME_DURATION_SEC) : endElapsedSec;
    timerText.textContent = `Время: ${shown.toFixed(1)} c / ${GAME_DURATION_SEC} c`;
  }

  raf = requestAnimationFrame(render);
}

async function initCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

async function initModel() {
  const { FilesetResolver, HandLandmarker } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs");
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

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", startGame);

window.addEventListener("resize", fitCanvas);
window.addEventListener("beforeunload", () => {
  if (raf) cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
});

(async function init() {
  fitCanvas();
  setStatus("Запрашиваем доступ к камере...");
  await initCamera();
  setStatus("Камера запущена. Загружаем модель рук...");
  await initModel();
  setStatus("Готово. Нажмите «Старт».");
  raf = requestAnimationFrame(render);
})().catch((err) => {
  console.error(err);
  setStatus("Ошибка запуска: " + (err?.message || err));
});
