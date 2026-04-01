import { HAND_CONNECTIONS } from "./app/config/landmarks.js";

const video = document.getElementById("video");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const statusText = document.getElementById("statusText");
const infoText = document.getElementById("infoText");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");

const MIRROR = true;
const BALL_R = 16;
const FRICTION = 0.985;
const RESTITUTION = 0.98;
const STOP_EPS = 12;

let stream = null;
let handLandmarker = null;
let raf = 0;
let lastTs = 0;
let running = false;
let phase = "aim"; // aim | rolling | ended

let currentPlayer = 1;
let groups = { 1: null, 2: null }; // solid | stripe
let winner = 0;

let table = null;
let pockets = [];
let balls = [];
let cueBallId = 0;
let lastTracked = [];
let nextTrackId = 1;
let shotCooldown = 0;
const singleHandShot = {
  phase: "idle", // idle | palm_ready | charging
  handId: null,
  startX: 0,
  startY: 0,
  startZ: 0,
  maxPull: 0,
  bestPullDx: 0,
  bestPullDy: 0,
};

let turnPocketed = [];
let turnCuePocketed = false;
let turnStartedBy = 1;

const BALL_COLORS = [
  null, "#f7c948", "#2d6cdf", "#d44f3a", "#7b3fa1", "#f08f2e", "#2f9e44", "#7f2f1f",
  "#121212", "#f7c948", "#2d6cdf", "#d44f3a", "#7b3fa1", "#f08f2e", "#2f9e44", "#7f2f1f",
];

function setStatus(t) { statusText.textContent = t; }

function fitCanvas() {
  const w = Math.max(900, window.innerWidth);
  const h = Math.max(520, window.innerHeight - 110);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function toCanvasPoint(p) {
  return { x: (MIRROR ? 1 - p.x : p.x) * canvas.width, y: p.y * canvas.height };
}

function initTable() {
  fitCanvas();
  const pad = 38;
  table = { x: pad, y: pad, w: canvas.width - pad * 2, h: canvas.height - pad * 2 };
  const x = table.x, y = table.y, w = table.w, h = table.h;
  pockets = [
    { x, y }, { x: x + w / 2, y }, { x: x + w, y },
    { x, y: y + h }, { x: x + w / 2, y: y + h }, { x: x + w, y: y + h },
  ];
}

function createBall(number, x, y, type) {
  return { id: number, number, type, x, y, vx: 0, vy: 0, pocketed: false };
}

function resetRack() {
  balls = [];
  initTable();
  const cueX = table.x + table.w * 0.24;
  const cueY = table.y + table.h * 0.5;
  balls.push(createBall(0, cueX, cueY, "cue"));
  cueBallId = 0;

  const startX = table.x + table.w * 0.72;
  const startY = table.y + table.h * 0.5;
  const dx = BALL_R * 2.05;
  const dy = BALL_R * 1.18;
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const px = startX + row * dx;
      const py = startY - (row * dy) / 2 + col * dy;
      const n = order[idx++];
      const type = n === 8 ? "eight" : n <= 7 ? "solid" : "stripe";
      balls.push(createBall(n, px, py, type));
    }
  }

  currentPlayer = 1;
  groups = { 1: null, 2: null };
  winner = 0;
  phase = "aim";
  turnPocketed = [];
  turnCuePocketed = false;
  turnStartedBy = 1;
  singleHandShot.phase = "idle";
  singleHandShot.handId = null;
  singleHandShot.maxPull = 0;
  singleHandShot.bestPullDx = 0;
  singleHandShot.bestPullDy = 0;
  shotCooldown = 0;
  running = true;
  updateInfo();
  setStatus("Игрок 1 ходит. Покажите открытую ладонь, сожмите кулак, оттяните назад и откройте ладонь для удара.");
}

function updateInfo() {
  const g1 = groups[1] === "solid" ? "Сплошные" : groups[1] === "stripe" ? "Полосатые" : "?";
  const g2 = groups[2] === "solid" ? "Сплошные" : groups[2] === "stripe" ? "Полосатые" : "?";
  infoText.textContent = `Игрок 1: ${g1} | Игрок 2: ${g2}`;
}

function drawVideoBg() {
  if (!video.videoWidth || !video.videoHeight) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (MIRROR) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
}

function drawTable() {
  ctx.fillStyle = "rgba(56,34,20,0.95)";
  ctx.fillRect(table.x - 20, table.y - 20, table.w + 40, table.h + 40);
  ctx.fillStyle = "rgba(18,105,62,0.94)";
  ctx.fillRect(table.x, table.y, table.w, table.h);
  for (const p of pockets) {
    ctx.beginPath();
    ctx.fillStyle = "#101010";
    ctx.arc(p.x, p.y, BALL_R * 1.65, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBall(ball) {
  if (ball.pocketed) return;
  const c = ball.number === 0 ? "#f9fafb" : BALL_COLORS[ball.number];
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = c;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.stroke();

  if (ball.type === "stripe") {
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(ball.x - BALL_R, ball.y - BALL_R * 0.36, BALL_R * 2, BALL_R * 0.72);
  }

  if (ball.number > 0) {
    ctx.beginPath();
    ctx.fillStyle = "#f8fafc";
    ctx.arc(ball.x, ball.y, BALL_R * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(ball.number), ball.x, ball.y + 0.3);
  }
}

function detectHands(ts) {
  if (!handLandmarker) return [];
  const res = handLandmarker.detectForVideo(video, ts);
  const items = (res.landmarks || []).map((hand) => {
    const i = toCanvasPoint(hand[8]);
    const palm = [hand[0], hand[5], hand[9], hand[13], hand[17]];
    const nz = palm.reduce((s, p) => s + (p.z || 0), 0) / palm.length;
    return { hand, x: i.x, y: i.y, nx: hand[8].x, ny: hand[8].y, nz };
  });
  const tracked = [];
  const used = new Set();
  for (const cur of items) {
    let best = null;
    let bestD = Infinity;
    for (const prev of lastTracked) {
      if (used.has(prev.id)) continue;
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (d < bestD) { bestD = d; best = prev; }
    }
    const id = best && bestD < 130 ? best.id : nextTrackId++;
    if (best) used.add(best.id);
    tracked.push({ id, ...cur });
  }
  lastTracked = tracked.map((h) => ({ id: h.id, x: h.x, y: h.y }));
  return tracked;
}

function getCueBall() {
  return balls.find((b) => b.id === cueBallId);
}

function isFist(hand) {
  if (!hand || hand.length < 21) return false;
  const folded =
    hand[8].y > hand[6].y &&
    hand[12].y > hand[10].y &&
    hand[16].y > hand[14].y &&
    hand[20].y > hand[18].y;
  const nearPalm = (tip, mcp) => Math.hypot(hand[tip].x - hand[mcp].x, hand[tip].y - hand[mcp].y) < 0.16;
  return folded && nearPalm(8, 5) && nearPalm(12, 9) && nearPalm(16, 13) && nearPalm(20, 17);
}

function isPalmOpen(hand) {
  if (!hand || hand.length < 21) return false;
  const extended =
    hand[8].y < hand[6].y &&
    hand[12].y < hand[10].y &&
    hand[16].y < hand[14].y &&
    hand[20].y < hand[18].y;
  const thumbOpen = Math.abs(hand[4].x - hand[3].x) > 0.02 || Math.abs(hand[4].y - hand[3].y) > 0.02;
  return extended && thumbOpen;
}

function getCurrentPlayerHands(hands) {
  const mid = canvas.width / 2;
  const filtered = hands.filter((h) => (currentPlayer === 1 ? h.x < mid : h.x >= mid));
  return filtered.length ? filtered : hands;
}

function pickAimHand(hands, cue) {
  if (!hands.length) return null;
  let best = hands[0];
  let bestDist = Math.hypot(best.x - cue.x, best.y - cue.y);
  for (let i = 1; i < hands.length; i++) {
    const d = Math.hypot(hands[i].x - cue.x, hands[i].y - cue.y);
    if (d < bestDist) {
      bestDist = d;
      best = hands[i];
    }
  }
  return best;
}

function tryShootFromHands(hands, dt) {
  if (phase !== "aim" || !running || winner) return;
  if (shotCooldown > 0) shotCooldown -= dt;
  const cue = getCueBall();
  if (!cue || cue.pocketed) return;
  const candidateHands = getCurrentPlayerHands(hands);
  const hand = pickAimHand(candidateHands, cue);
  if (!hand) {
    singleHandShot.phase = "idle";
    singleHandShot.handId = null;
    singleHandShot.maxPull = 0;
    singleHandShot.bestPullDx = 0;
    singleHandShot.bestPullDy = 0;
    return;
  }

  const dirX = hand.x - cue.x;
  const dirY = hand.y - cue.y;
  const len = Math.hypot(dirX, dirY) || 1;
  let aimNx = dirX / len;
  let aimNy = dirY / len;

  const palm = isPalmOpen(hand.hand);
  const fist = isFist(hand.hand);
  const sameTrackedHand = singleHandShot.handId === null || singleHandShot.handId === hand.id;

  if (singleHandShot.phase === "idle") {
    if (palm) {
      singleHandShot.phase = "palm_ready";
      singleHandShot.handId = hand.id;
    }
  } else if (singleHandShot.phase === "palm_ready") {
    if (!sameTrackedHand) {
      singleHandShot.phase = "idle";
      singleHandShot.handId = null;
      singleHandShot.maxPull = 0;
      singleHandShot.bestPullDx = 0;
      singleHandShot.bestPullDy = 0;
    } else if (fist) {
      singleHandShot.phase = "charging";
      singleHandShot.startX = hand.x;
      singleHandShot.startY = hand.y;
      singleHandShot.startZ = hand.nz;
      singleHandShot.maxPull = 0;
      singleHandShot.bestPullDx = 0;
      singleHandShot.bestPullDy = 0;
    } else if (!palm) {
      singleHandShot.phase = "idle";
      singleHandShot.handId = null;
      singleHandShot.maxPull = 0;
      singleHandShot.bestPullDx = 0;
      singleHandShot.bestPullDy = 0;
    }
  } else if (singleHandShot.phase === "charging") {
    if (!sameTrackedHand) {
      singleHandShot.phase = "idle";
      singleHandShot.handId = null;
      singleHandShot.maxPull = 0;
      singleHandShot.bestPullDx = 0;
      singleHandShot.bestPullDy = 0;
    } else if (fist) {
      const dx = hand.x - singleHandShot.startX;
      const dy = hand.y - singleHandShot.startY;
      const pull2d = Math.hypot(dx, dy);
      const pullZ = Math.max(0, hand.nz - singleHandShot.startZ) * 920;
      const pull = pull2d * 0.8 + pullZ;
      if (pull > singleHandShot.maxPull) {
        singleHandShot.maxPull = pull;
        singleHandShot.bestPullDx = dx;
        singleHandShot.bestPullDy = dy;
      }
      // Şarj sırasında tahmin yönü: çekişin tam tersi
      if (pull2d > 5) {
        aimNx = -dx / pull2d;
        aimNy = -dy / pull2d;
      }
    } else if (palm) {
      if (shotCooldown <= 0 && singleHandShot.maxPull > 16) {
        const power = Math.min(1180, 220 + singleHandShot.maxPull * 2.6);
        const bestLen = Math.hypot(singleHandShot.bestPullDx, singleHandShot.bestPullDy);
        if (bestLen > 4) {
          aimNx = -singleHandShot.bestPullDx / bestLen;
          aimNy = -singleHandShot.bestPullDy / bestLen;
        }
        cue.vx = aimNx * power;
        cue.vy = aimNy * power;
        phase = "rolling";
        shotCooldown = 0.42;
        turnStartedBy = currentPlayer;
        turnPocketed = [];
        turnCuePocketed = false;
        setStatus(`Игрок ${currentPlayer} ударил. Шары в движении...`);
      }
      singleHandShot.phase = "palm_ready";
      singleHandShot.maxPull = 0;
      singleHandShot.bestPullDx = 0;
      singleHandShot.bestPullDy = 0;
    }
  }

  drawAim(cue, aimNx, aimNy, hand, singleHandShot.phase === "charging", singleHandShot.maxPull);
}

function drawAim(cue, nx, ny, hand, charging, maxPull) {
  const px = hand.x;
  const py = hand.y;
  const pullRatio = Math.max(0, Math.min(1, maxPull / 220));
  const cueLen = 120 + pullRatio * 120;

  ctx.save();

  // Tek elle sanal ıstaka
  ctx.strokeStyle = charging ? "rgba(250,204,21,0.95)" : "rgba(56,189,248,0.9)";
  ctx.lineWidth = charging ? 6 : 4;
  ctx.beginPath();
  ctx.moveTo(px - nx * cueLen, py - ny * cueLen);
  ctx.lineTo(px + nx * 16, py + ny * 16);
  ctx.stroke();

  // Topun gidiş tahmini
  ctx.strokeStyle = "rgba(255,255,255,0.72)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(cue.x, cue.y);
  ctx.lineTo(cue.x + nx * 190, cue.y + ny * 190);
  ctx.stroke();
  ctx.setLineDash([]);

  // Nişangah
  ctx.beginPath();
  ctx.arc(px, py, 10, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Güç barı
  ctx.fillStyle = "rgba(15,23,42,0.78)";
  ctx.fillRect(18, 18, 190, 24);
  ctx.fillStyle = charging ? "rgba(250,204,21,0.95)" : "rgba(148,163,184,0.85)";
  ctx.fillRect(20, 20, 186 * pullRatio, 20);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.strokeRect(20, 20, 186, 20);
  ctx.restore();
}

function updatePhysics(dt) {
  if (phase !== "rolling") return;

  for (const b of balls) {
    if (b.pocketed) continue;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= FRICTION;
    b.vy *= FRICTION;
    if (Math.abs(b.vx) < STOP_EPS) b.vx = 0;
    if (Math.abs(b.vy) < STOP_EPS) b.vy = 0;
    const left = table.x + BALL_R, right = table.x + table.w - BALL_R;
    const top = table.y + BALL_R, bottom = table.y + table.h - BALL_R;
    if (b.x < left) { b.x = left; b.vx *= -RESTITUTION; }
    if (b.x > right) { b.x = right; b.vx *= -RESTITUTION; }
    if (b.y < top) { b.y = top; b.vy *= -RESTITUTION; }
    if (b.y > bottom) { b.y = bottom; b.vy *= -RESTITUTION; }
  }

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.pocketed) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.pocketed) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minD = BALL_R * 2;
      if (dist <= 0 || dist >= minD) continue;
      const nx = dx / dist, ny = dy / dist;
      const overlap = minD - dist;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn > 0) continue;
      const impulse = -(1 + RESTITUTION) * vn * 0.5;
      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
    }
  }

  for (const b of balls) {
    if (b.pocketed) continue;
    for (const p of pockets) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < BALL_R * 1.28) {
        b.pocketed = true;
        b.vx = 0; b.vy = 0;
        if (b.number === 0) turnCuePocketed = true;
        else turnPocketed.push(b);
        break;
      }
    }
  }

  const anyMoving = balls.some((b) => !b.pocketed && (Math.abs(b.vx) > 0 || Math.abs(b.vy) > 0));
  if (!anyMoving) settleTurn();
}

function countRemaining(type) {
  return balls.filter((b) => !b.pocketed && b.type === type).length;
}

function settleTurn() {
  if (phase !== "rolling") return;
  phase = "aim";

  const p = turnStartedBy;
  const op = p === 1 ? 2 : 1;

  const eightPocketed = turnPocketed.some((b) => b.type === "eight");
  if (eightPocketed) {
    const pGroup = groups[p];
    const canWin = pGroup && countRemaining(pGroup) === 0 && !turnCuePocketed;
    winner = canWin ? p : op;
    phase = "ended";
    running = false;
    setStatus(canWin ? `Игрок ${p} победил (8-ball)!` : `Игрок ${p} забил 8-ball рано. Победил Игрок ${op}.`);
    return;
  }

  const typedPocketed = turnPocketed.filter((b) => b.type === "solid" || b.type === "stripe");
  if (!groups[1] && typedPocketed.length) {
    groups[p] = typedPocketed[0].type;
    groups[op] = typedPocketed[0].type === "solid" ? "stripe" : "solid";
  }

  if (turnCuePocketed) {
    const cue = getCueBall();
    cue.pocketed = false;
    cue.x = table.x + table.w * 0.24;
    cue.y = table.y + table.h * 0.5;
    cue.vx = 0; cue.vy = 0;
  }

  let keepTurn = false;
  if (groups[p]) {
    keepTurn = typedPocketed.some((b) => b.type === groups[p]) && !turnCuePocketed;
  } else {
    keepTurn = typedPocketed.length > 0 && !turnCuePocketed;
  }

  if (!keepTurn) currentPlayer = op;
  updateInfo();
  setStatus(`Сейчас ходит Игрок ${currentPlayer}.`);
  turnPocketed = [];
  turnCuePocketed = false;
}

function drawHands(hands) {
  for (const h of hands) {
    ctx.strokeStyle = "rgba(56,189,248,0.85)";
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = toCanvasPoint(h.hand[a]);
      const p2 = toCanvasPoint(h.hand[b]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }
}

function render(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  drawVideoBg();
  drawTable();
  const hands = detectHands(ts);
  if (phase === "aim") tryShootFromHands(hands, dt);
  updatePhysics(dt);

  for (const b of balls) drawBall(b);
  drawHands(hands);
  raf = requestAnimationFrame(render);
}

async function initCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
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

function startGame() {
  resetRack();
}

startBtn.addEventListener("click", startGame);
resetBtn.addEventListener("click", startGame);
window.addEventListener("resize", () => initTable());
window.addEventListener("beforeunload", () => {
  if (raf) cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
});

(async function init() {
  setStatus("Камера izni isteniyor...");
  await initCamera();
  setStatus("Камера hazır. Модель рук загружается...");
  await initModel();
  initTable();
  resetRack();
  raf = requestAnimationFrame(render);
})().catch((err) => {
  console.error(err);
  setStatus("Ошибка запуска: " + (err?.message || err));
});
