import { HAND_CONNECTIONS } from "./app/config/landmarks.js";

const video = document.getElementById("video");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const statusText = document.getElementById("statusText");
const hpText = document.getElementById("hpText");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");

const name1El = document.getElementById("name1");
const name2El = document.getElementById("name2");
const char1El = document.getElementById("char1");
const char2El = document.getElementById("char2");
const item1El = document.getElementById("item1");
const item2El = document.getElementById("item2");

const MIRROR = true;
const IS_LOW_END = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const DETECT_INTERVAL_MS = IS_LOW_END ? 50 : 33;
const CAMERA_WIDTH = IS_LOW_END ? 960 : 1280;
const CAMERA_HEIGHT = IS_LOW_END ? 540 : 720;
const G = 820;
const AIR = 0.996;
const GROUND_BOUNCE = 0.35;

const ITEMS = {
  bone: { label: "Кость", damage: 22, speedScale: 1.0, radius: 10, color: "#e2e8f0" },
  food: { label: "Корм", damage: 16, speedScale: 1.2, radius: 8, color: "#f59e0b" },
  brick: { label: "Мяч", damage: 28, speedScale: 0.85, radius: 12, color: "#ef4444" },
};

let stream = null;
let handLandmarker = null;
let raf = 0;
let lastTs = 0;

let nextTrackId = 1;
let lastTracked = [];
let cachedHands = [];
let lastDetectMs = 0;

let running = false;
let winner = 0;
let currentTurn = 1;
const projectiles = [];

let world = null;
let players = [
  makePlayer(1),
  makePlayer(2),
];

const shotState = {
  phase: "idle", // idle | ready | charging
  handId: null,
  startX: 0,
  startY: 0,
  maxPull: 0,
  bestDx: 0,
  bestDy: 0,
  currentDx: 0,
  currentDy: 0,
};

function makePlayer(id) {
  return {
    id,
    name: id === 1 ? "Игрок 1" : "Игрок 2",
    char: id === 1 ? "cat" : "dog",
    item: "bone",
    hp: 100,
    x: 0,
    y: 0,
  };
}

function setStatus(text) {
  statusText.textContent = text;
}

function updateHpUi() {
  hpText.textContent = `${players[0].name}: ${Math.max(0, Math.round(players[0].hp))} HP | ${players[1].name}: ${Math.max(0, Math.round(players[1].hp))} HP`;
}

function fitCanvas() {
  const w = Math.max(960, window.innerWidth);
  const h = Math.max(560, window.innerHeight - 170);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function initWorld() {
  fitCanvas();
  const groundY = canvas.height - 68;
  world = {
    groundY,
    wall: {
      x: canvas.width * 0.5 - 16,
      y: groundY - 210,
      w: 32,
      h: 210,
    },
  };
  players[0].x = canvas.width * 0.18;
  players[0].y = groundY;
  players[1].x = canvas.width * 0.82;
  players[1].y = groundY;
}

function resetMatch() {
  players = [makePlayer(1), makePlayer(2)];
  players[0].name = (name1El.value || "Игрок 1").trim();
  players[1].name = (name2El.value || "Игрок 2").trim();
  players[0].char = char1El.value;
  players[1].char = char2El.value;
  players[0].item = item1El.value;
  players[1].item = item2El.value;
  players[0].hp = 100;
  players[1].hp = 100;
  initWorld();
  projectiles.length = 0;
  winner = 0;
  currentTurn = 1;
  shotState.phase = "idle";
  shotState.handId = null;
  shotState.maxPull = 0;
  shotState.bestDx = 0;
  shotState.bestDy = 0;
  shotState.currentDx = 0;
  shotState.currentDy = 0;
  running = true;
  updateHpUi();
  setStatus(`${players[0].name} начинает. Открытая ладонь -> кулак -> оттянуть -> открыть ладонь для броска.`);
}

function drawVideo() {
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

function drawWorld() {
  ctx.fillStyle = "rgba(28,42,68,0.28)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, world.groundY, canvas.width, canvas.height - world.groundY);

  ctx.fillStyle = "#475569";
  ctx.fillRect(world.wall.x, world.wall.y, world.wall.w, world.wall.h);

  drawPlayer(players[0], "#60a5fa");
  drawPlayer(players[1], "#fb923c");
}

function drawPlayer(p, tint) {
  const r = 32;
  ctx.beginPath();
  ctx.fillStyle = tint;
  ctx.arc(p.x, p.y - 24, r, 0, Math.PI * 2);
  ctx.fill();

  // simple ear shapes for cat/dog distinction
  if (p.char === "cat") {
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.moveTo(p.x - 22, p.y - 52);
    ctx.lineTo(p.x - 8, p.y - 82);
    ctx.lineTo(p.x + 2, p.y - 52);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x + 22, p.y - 52);
    ctx.lineTo(p.x + 8, p.y - 82);
    ctx.lineTo(p.x - 2, p.y - 52);
    ctx.fill();
  } else {
    ctx.fillStyle = "#111827";
    ctx.fillRect(p.x - 28, p.y - 64, 12, 22);
    ctx.fillRect(p.x + 16, p.y - 64, 12, 22);
  }

  ctx.fillStyle = "#0f172a";
  ctx.font = "600 14px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(p.name, p.x, p.y - 78);
}

function toCanvasPoint(p) {
  return {
    x: (MIRROR ? 1 - p.x : p.x) * canvas.width,
    y: p.y * canvas.height,
  };
}

function detectHands(ts) {
  if (!handLandmarker) return [];
  const res = handLandmarker.detectForVideo(video, ts);
  const items = (res.landmarks || []).map((hand) => {
    const i = toCanvasPoint(hand[8]);
    return { hand, x: i.x, y: i.y };
  });
  const tracked = [];
  const used = new Set();
  for (const cur of items) {
    let best = null;
    let bestD = Infinity;
    for (const prev of lastTracked) {
      if (used.has(prev.id)) continue;
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (d < bestD) {
        bestD = d;
        best = prev;
      }
    }
    const id = best && bestD < 130 ? best.id : nextTrackId++;
    if (best) used.add(best.id);
    tracked.push({ id, ...cur });
  }
  lastTracked = tracked.map((h) => ({ id: h.id, x: h.x, y: h.y }));
  return tracked;
}

function getHandsForFrame(ts) {
  if (!handLandmarker) return cachedHands;
  if (!lastDetectMs || ts - lastDetectMs >= DETECT_INTERVAL_MS) {
    cachedHands = detectHands(ts);
    lastDetectMs = ts;
  }
  return cachedHands;
}

function isFist(hand) {
  if (!hand || hand.length < 21) return false;
  let foldedCount = 0;
  if (hand[8].y > hand[6].y - 0.01) foldedCount += 1;
  if (hand[12].y > hand[10].y - 0.01) foldedCount += 1;
  if (hand[16].y > hand[14].y - 0.01) foldedCount += 1;
  if (hand[20].y > hand[18].y - 0.01) foldedCount += 1;
  return foldedCount >= 3;
}

function isPalmOpen(hand) {
  if (!hand || hand.length < 21) return false;
  return (
    hand[8].y < hand[6].y &&
    hand[12].y < hand[10].y &&
    hand[16].y < hand[14].y &&
    hand[20].y < hand[18].y
  );
}

function getActiveTurnHands(hands) {
  const mid = canvas.width / 2;
  const filtered = hands.filter((h) => (currentTurn === 1 ? h.x < mid : h.x >= mid));
  return filtered.length ? filtered : hands;
}

function pickMainHand(hands, player) {
  if (!hands.length) return null;
  let best = hands[0];
  let bestD = Math.hypot(best.x - player.x, best.y - (player.y - 30));
  for (let i = 1; i < hands.length; i++) {
    const d = Math.hypot(hands[i].x - player.x, hands[i].y - (player.y - 30));
    if (d < bestD) {
      bestD = d;
      best = hands[i];
    }
  }
  return best;
}

function tryGestureThrow(hands) {
  if (!running || winner) return;
  if (projectiles.length) return; // turn-based, one shot at a time
  const activePlayer = players[currentTurn - 1];
  const sideHands = getActiveTurnHands(hands);
  const hand = pickMainHand(sideHands, activePlayer);

  if (!hand) {
    shotState.phase = "idle";
    shotState.handId = null;
    shotState.maxPull = 0;
    shotState.currentDx = 0;
    shotState.currentDy = 0;
    return;
  }

  const palm = isPalmOpen(hand.hand);
  const fist = isFist(hand.hand);
  const sameHand = shotState.handId === null || shotState.handId === hand.id;

  if (shotState.phase === "idle") {
    if (palm) {
      shotState.phase = "ready";
      shotState.handId = hand.id;
    }
  } else if (shotState.phase === "ready") {
    if (!sameHand) {
      shotState.phase = "idle";
      shotState.handId = null;
      shotState.currentDx = 0;
      shotState.currentDy = 0;
    } else if (fist) {
      shotState.phase = "charging";
      shotState.startX = hand.x;
      shotState.startY = hand.y;
      shotState.maxPull = 0;
      shotState.bestDx = 0;
      shotState.bestDy = 0;
      shotState.currentDx = 0;
      shotState.currentDy = 0;
    } else if (!palm) {
      shotState.phase = "idle";
      shotState.handId = null;
      shotState.currentDx = 0;
      shotState.currentDy = 0;
    }
  } else if (shotState.phase === "charging") {
    if (!sameHand) {
      shotState.phase = "idle";
      shotState.handId = null;
      shotState.maxPull = 0;
      shotState.currentDx = 0;
      shotState.currentDy = 0;
    } else if (fist) {
      const dx = hand.x - shotState.startX;
      const dy = hand.y - shotState.startY;
      const pull = Math.hypot(dx, dy);
      shotState.currentDx = dx;
      shotState.currentDy = dy;
      if (pull > shotState.maxPull) {
        shotState.maxPull = pull;
        shotState.bestDx = dx;
        shotState.bestDy = dy;
      }
    } else if (palm) {
      // direction lock: fist phase final pull vector is used; palm transition does not alter direction
      if (shotState.maxPull > 14) {
        const relLen = Math.hypot(shotState.currentDx, shotState.currentDy);
        const throwDx = relLen > 4 ? shotState.currentDx : shotState.bestDx;
        const throwDy = relLen > 4 ? shotState.currentDy : shotState.bestDy;
        throwProjectile(activePlayer, throwDx, throwDy, shotState.maxPull);
      }
      shotState.phase = "ready";
      shotState.maxPull = 0;
      shotState.bestDx = 0;
      shotState.bestDy = 0;
      shotState.currentDx = 0;
      shotState.currentDy = 0;
    }
  }

  drawAimGuide(activePlayer, hand);
}

function throwProjectile(player, pullDx, pullDy, pullAmount) {
  const len = Math.hypot(pullDx, pullDy);
  if (len < 4) return;
  const nx = -pullDx / len; // opposite of pull
  const ny = -pullDy / len; // opposite of pull
  const item = ITEMS[player.item] || ITEMS.bone;
  const speed = Math.min(920, 260 + pullAmount * 3.8) * item.speedScale;

  projectiles.push({
    owner: player.id,
    itemKey: player.item,
    x: player.x + (player.id === 1 ? 26 : -26),
    y: player.y - 34,
    vx: nx * speed,
    vy: ny * speed,
    r: item.radius,
    damage: item.damage,
    active: true,
  });

  setStatus(`${player.name} бросил: ${item.label}!`);
}

function drawAimGuide(player, hand) {
  if (!hand) return;
  const ratio = Math.max(0, Math.min(1, shotState.maxPull / 220));
  const dx = shotState.phase === "charging" ? shotState.currentDx : shotState.bestDx;
  const dy = shotState.phase === "charging" ? shotState.currentDy : shotState.bestDy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = len > 0 ? -dx / len : (player.id === 1 ? 1 : -1);
  const ny = len > 0 ? -dy / len : -0.2;

  ctx.save();
  ctx.strokeStyle = shotState.phase === "charging" ? "rgba(250,204,21,0.95)" : "rgba(56,189,248,0.9)";
  ctx.lineWidth = shotState.phase === "charging" ? 5 : 3;
  // Kıvrımlı (balistik) tahmini yol: yaklaşık %70 doğruluk hedefi
  const baseSpeed = Math.min(920, 260 + Math.max(shotState.maxPull, 14) * 3.8);
  const vx0 = nx * baseSpeed;
  const vy0 = ny * baseSpeed;
  const sx = player.x;
  const sy = player.y - 34;
  ctx.beginPath();
  for (let i = 0; i <= 28; i++) {
    const t = (i / 28) * 0.9; // yaklaşık ilk 0.9 saniye
    const px = sx + vx0 * t;
    const py = sy + vy0 * t + 0.5 * G * t * t;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    if (px < 0 || px > canvas.width || py > world.groundY) break;
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(hand.x, hand.y, 10, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "rgba(15,23,42,0.78)";
  ctx.fillRect(18, 18, 190, 24);
  ctx.fillStyle = shotState.phase === "charging" ? "rgba(250,204,21,0.95)" : "rgba(148,163,184,0.9)";
  ctx.fillRect(20, 20, 186 * ratio, 20);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.strokeRect(20, 20, 186, 20);
  ctx.restore();
}

function updateProjectiles(dt) {
  if (!projectiles.length) return;
  const wall = world.wall;
  const p1 = players[0];
  const p2 = players[1];

  for (const pr of projectiles) {
    if (!pr.active) continue;
    pr.vy += G * dt;
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.vx *= AIR;
    pr.vy *= AIR;

    // wall collision
    if (
      pr.x + pr.r > wall.x &&
      pr.x - pr.r < wall.x + wall.w &&
      pr.y + pr.r > wall.y &&
      pr.y - pr.r < wall.y + wall.h
    ) {
      pr.active = false;
      continue;
    }

    // ground bounce + stop
    if (pr.y + pr.r >= world.groundY) {
      pr.y = world.groundY - pr.r;
      pr.vy *= -GROUND_BOUNCE;
      pr.vx *= 0.72;
      if (Math.abs(pr.vy) < 60 && Math.abs(pr.vx) < 60) {
        pr.active = false;
      }
    }

    // out of bounds
    if (pr.x < -120 || pr.x > canvas.width + 120 || pr.y > canvas.height + 120) {
      pr.active = false;
    }

    const target = pr.owner === 1 ? p2 : p1;
    const hit = Math.hypot(pr.x - target.x, pr.y - (target.y - 28)) < pr.r + 34;
    if (hit) {
      target.hp -= pr.damage;
      pr.active = false;
      updateHpUi();
      if (target.hp <= 0) {
        target.hp = 0;
        winner = pr.owner;
        running = false;
        setStatus(`${players[winner - 1].name} победил!`);
      }
    }
  }

  for (let i = projectiles.length - 1; i >= 0; i--) {
    if (!projectiles[i].active) projectiles.splice(i, 1);
  }

  if (!projectiles.length && running && !winner) {
    currentTurn = currentTurn === 1 ? 2 : 1;
    setStatus(`Ход: ${players[currentTurn - 1].name}`);
  }
}

function drawProjectiles() {
  for (const pr of projectiles) {
    const item = ITEMS[pr.itemKey] || ITEMS.bone;
    ctx.beginPath();
    ctx.fillStyle = item.color;
    ctx.arc(pr.x, pr.y, pr.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.stroke();
  }
}

function drawHands(hands) {
  for (const h of hands) {
    ctx.strokeStyle = "rgba(125,211,252,0.85)";
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

  drawVideo();
  drawWorld();
  const hands = getHandsForFrame(ts);
  if (running && !winner) {
    tryGestureThrow(hands);
    updateProjectiles(dt);
  }
  drawProjectiles();
  drawHands(hands);
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

startBtn.addEventListener("click", resetMatch);
resetBtn.addEventListener("click", resetMatch);

window.addEventListener("resize", () => {
  initWorld();
});
window.addEventListener("beforeunload", () => {
  if (raf) cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
});

(async function init() {
  setStatus("Запрашивается доступ к камере...");
  await initCamera();
  setStatus("Камера готова. Загружается модель рук...");
  await initModel();
  initWorld();
  resetMatch();
  raf = requestAnimationFrame(render);
})().catch((err) => {
  console.error(err);
  setStatus("Ошибка запуска: " + (err?.message || err));
});
