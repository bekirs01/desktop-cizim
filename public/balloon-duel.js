import { HAND_CONNECTIONS } from "./app/config/landmarks.js";

const video = document.getElementById("video");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const statusText = document.getElementById("statusText");
const scoreText = document.getElementById("scoreText");
const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const targetSelect = document.getElementById("targetSelect");

const MIRROR = true;
const IS_LOW_END = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const DETECT_INTERVAL_MS = IS_LOW_END ? 50 : 33;
const CAMERA_WIDTH = IS_LOW_END ? 960 : 1280;
const CAMERA_HEIGHT = IS_LOW_END ? 540 : 720;
const DEFAULT_TARGET_SCORE = 10;
let targetScore = DEFAULT_TARGET_SCORE;

let handLandmarker = null;
let stream = null;
let raf = 0;
let lastTs = 0;
let running = false;

let nextTrackId = 1;
let prevTracks = [];
const motionByTrack = new Map();
let cachedTracked = [];
let lastDetectMs = 0;
let lastRunningStatusAt = 0;

const players = [
  makePlayer(0, "Игрок 1", "rgba(99,102,241,0.95)"),
  makePlayer(1, "Игрок 2", "rgba(249,115,22,0.95)"),
];

function makePlayer(index, name, color) {
  return {
    index,
    name,
    color,
    score: 0,
    balloons: [],
    spawnAt: 0,
    crosshairs: [],
    won: false,
  };
}

function setStatus(text) {
  statusText.textContent = text;
}

function updateScoreUi() {
  scoreText.textContent = `Счёт: Игрок 1 — ${players[0].score} | Игрок 2 — ${players[1].score} | Лимит: ${targetScore}`;
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
  const w = canvas.width, h = canvas.height;
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
  const items = raw.map((hand) => {
    const idx = toCanvasPoint(hand[8]);
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of hand) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const handScale = Math.hypot(maxX - minX, maxY - minY);
    return { hand, cx: idx.x, cy: idx.y, ny: hand[8].y, handScale };
  });
  const tracked = [];
  const used = new Set();
  for (const cur of items) {
    let best = null;
    let dist = Infinity;
    for (const prev of prevTracks) {
      if (used.has(prev.id)) continue;
      const d = Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy);
      if (d < dist) {
        dist = d;
        best = prev;
      }
    }
    const id = best && dist < 120 ? best.id : nextTrackId++;
    if (best) used.add(best.id);
    tracked.push({ id, ...cur });
  }
  prevTracks = tracked.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy }));
  return tracked;
}

function getTrackedHands(ts) {
  if (!handLandmarker) return cachedTracked;
  if (!lastDetectMs || ts - lastDetectMs >= DETECT_INTERVAL_MS) {
    cachedTracked = detectHands(ts);
    lastDetectMs = ts;
  }
  return cachedTracked;
}

function isGunPose(hand, handScale = 0.2) {
  if (!hand || hand.length < 21) return false;
  const isExtended = (tip, pip) => hand[tip].y < hand[pip].y;
  const indexExt = isExtended(8, 6);
  // Uzakta algılama kaybını azaltmak için kıvrık parmak koşulunu biraz esnetiyoruz.
  const middleFold = hand[12].y > hand[9].y - 0.012;
  const ringFold = hand[16].y > hand[13].y - 0.012;
  const pinkyFold = hand[20].y > hand[17].y - 0.012;
  const thumbDelta = Math.max(Math.abs(hand[4].x - hand[3].x), Math.abs(hand[4].y - hand[3].y));
  const thumbOpen = thumbDelta > Math.max(0.012, handScale * 0.06);
  return indexExt && middleFold && ringFold && pinkyFold && thumbOpen;
}

function assignAndFire(tracked, dt) {
  players[0].crosshairs = [];
  players[1].crosshairs = [];
  const mid = canvas.width / 2;

  for (const t of tracked) {
    const playerIdx = t.cx < mid ? 0 : 1;
    const p = players[playerIdx];
    p.crosshairs.push({ x: t.cx, y: t.cy });

    const prev = motionByTrack.get(t.id) || { y: t.cy, ny: t.ny, vy: 0, cooldown: 0 };
    const vy = (t.cy - prev.y) / Math.max(0.0001, dt); // +down, -up (px/s)
    const vyNorm = (t.ny - prev.ny) / Math.max(0.0001, dt); // +down, -up (normalized/s)
    let cooldown = Math.max(0, prev.cooldown - dt);

    // El küçüldükçe (uzaklaştıkça) daha düşük hız eşiği ile ateşlemeyi kabul et.
    const farRatio = Math.max(0, Math.min(1, (0.28 - t.handScale) / 0.18)); // 0=yakın, 1=uzak
    const vyNormThreshold = -0.38 + farRatio * 0.2; // yakın:-0.38, uzak:-0.18

    if (running && cooldown <= 0 && isGunPose(t.hand, t.handScale) && vyNorm < vyNormThreshold) {
      fireShot(playerIdx, t.cx, t.cy);
      cooldown = 0.34;
    }
    motionByTrack.set(t.id, { y: t.cy, ny: t.ny, vy, cooldown });
  }
}

function fireShot(playerIdx, x, y) {
  const p = players[playerIdx];
  if (p.won || !running) return;
  const lane = laneRect(playerIdx);
  let hitIndex = -1;
  let bestY = Infinity;
  for (let i = 0; i < p.balloons.length; i++) {
    const b = p.balloons[i];
    const bx = lane.x + b.xNorm * lane.w + Math.sin(b.phase) * b.wobble;
    const by = lane.y + b.yNorm * lane.h;
    const d = Math.hypot(bx - x, by - y);
    if (by < y && d < b.r + 32 && by < bestY) {
      bestY = by;
      hitIndex = i;
    }
  }
  // Visual shot line
  ctx.save();
  ctx.strokeStyle = playerIdx === 0 ? "rgba(99,102,241,0.95)" : "rgba(249,115,22,0.95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 220);
  ctx.stroke();
  ctx.restore();

  if (hitIndex >= 0) {
    p.balloons.splice(hitIndex, 1);
    p.score += 1;
    updateScoreUi();
    if (p.score >= targetScore) {
      p.won = true;
      running = false;
      const loser = playerIdx === 0 ? 2 : 1;
      setStatus(`Победил Игрок ${playerIdx + 1}! Игрок ${loser} проиграл.`);
    }
  }
}

function laneRect(i) {
  const pad = 14;
  const gap = 20;
  const w = (canvas.width - pad * 2 - gap) / 2;
  const h = canvas.height - 32;
  const x = i === 0 ? pad : pad + w + gap;
  return { x, y: 16, w, h };
}

function spawnAndMoveBalloons(dt, elapsed) {
  for (const p of players) {
    if (elapsed >= p.spawnAt) {
      p.spawnAt = elapsed + 0.95 + Math.random() * 0.5;
      p.balloons.push({
        xNorm: 0.18 + Math.random() * 0.64,
        yNorm: 1.08,
        speed: 0.08 + Math.random() * 0.06,
        r: 16 + Math.random() * 12,
        wobble: 8 + Math.random() * 10,
        phase: Math.random() * Math.PI * 2,
      });
    }
    for (const b of p.balloons) {
      b.yNorm -= b.speed * dt;
      b.phase += dt * 2.2;
    }
    p.balloons = p.balloons.filter((b) => b.yNorm > -0.15);
  }
}

function drawHands(tracked) {
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
    const tip = toCanvasPoint(t.hand[8]);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(tip.x, tip.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawScene(elapsed) {
  for (let i = 0; i < 2; i++) {
    const lane = laneRect(i);
    const p = players[i];
    ctx.save();
    ctx.fillStyle = "rgba(10,14,24,0.65)";
    ctx.fillRect(lane.x, lane.y, lane.w, lane.h);
    ctx.strokeStyle = i === 0 ? "rgba(99,102,241,0.9)" : "rgba(249,115,22,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(lane.x, lane.y, lane.w, lane.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "700 18px system-ui";
    ctx.fillText(`Игрок ${i + 1}`, lane.x + 10, lane.y + 24);
    ctx.font = "600 14px system-ui";
    ctx.fillText(`Попадания: ${p.score}/${targetScore}`, lane.x + 10, lane.y + 44);

    // Balloons
    for (const b of p.balloons) {
      const bx = lane.x + b.xNorm * lane.w + Math.sin(b.phase) * b.wobble;
      const by = lane.y + b.yNorm * lane.h;
      ctx.beginPath();
      ctx.fillStyle = i === 0 ? "rgba(96,165,250,0.9)" : "rgba(251,146,60,0.9)";
      ctx.arc(bx, by, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by + b.r);
      ctx.lineTo(bx, by + b.r + 12);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.stroke();
    }

    // Crosshairs (оба руки игрока могут стрелять)
    for (const crosshair of p.crosshairs) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(crosshair.x, crosshair.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(crosshair.x - 18, crosshair.y);
      ctx.lineTo(crosshair.x + 18, crosshair.y);
      ctx.moveTo(crosshair.x, crosshair.y - 18);
      ctx.lineTo(crosshair.x, crosshair.y + 18);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function resetGame() {
  for (let i = 0; i < 2; i++) {
    players[i] = makePlayer(i, `Игрок ${i + 1}`, i === 0 ? "rgba(99,102,241,0.95)" : "rgba(249,115,22,0.95)");
  }
  updateScoreUi();
}

function startGame() {
  const selectedTarget = Number(targetSelect?.value || DEFAULT_TARGET_SCORE);
  targetScore = selectedTarget === 15 ? 15 : 10;
  resetGame();
  running = true;
  setStatus(`Старт! Ваша цель: первым сбить ${targetScore} шаров.`);
}

function render(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  fitCanvas();
  drawVideo();
  const tracked = getTrackedHands(ts);
  assignAndFire(tracked, dt);

  const elapsed = ts / 1000;
  if (running) spawnAndMoveBalloons(dt, elapsed);
  drawScene(elapsed);
  drawHands(tracked);

  if (running && ts - lastRunningStatusAt >= 250) {
    lastRunningStatusAt = ts;
    setStatus(
      `Игра идёт (${(elapsed).toFixed(1)} c). Поза «пистолет» + резкий взмах вверх = выстрел.`,
    );
  }

  raf = requestAnimationFrame(render);
}

async function initCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT }, frameRate: { ideal: 30, max: 30 } },
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
  setStatus("Запрашиваем доступ к камере...");
  await initCamera();
  setStatus("Камера запущена. Загружаем модель рук...");
  await initModel();
  resetGame();
  setStatus("Готово. Нажмите «Старт».");
  raf = requestAnimationFrame(render);
})().catch((err) => {
  console.error(err);
  setStatus("Ошибка запуска: " + (err?.message || err));
});
