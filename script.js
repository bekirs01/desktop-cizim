/**
 * Canlı Hareket Takip Sistemi - Tam Çalışan Versiyon
 * MediaPipe Tasks Vision - Kamera, El, Pose, Yüz, Çizim
 */

import {
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";

// Model URL'leri
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";

// Pose landmark indeksleri
const POSE = {
  NOSE: 0, LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14, LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24, LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28
};

// El 21 landmark - her parmak ayrı renkte
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // Başparmak
  [0, 5], [5, 6], [6, 7], [7, 8],           // İşaret
  [0, 9], [9, 10], [10, 11], [11, 12],      // Orta
  [0, 13], [13, 14], [14, 15], [15, 16],   // Yüzük
  [0, 17], [17, 18], [18, 19], [19, 20],   // Serçe
  [5, 9], [9, 13], [13, 17]                 // Avuç
];
const FINGER_COLORS = {
  thumb: "#ff6b6b", index: "#4ecdc4", middle: "#ffe66d", ring: "#95e1d3", pinky: "#dda0dd"
};

// Pose iskelet bağlantıları
const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22]
];

const DEBOUNCE_MS = 600;
const MIN_VIS = 0.25;
const MIRROR_CAMERA = true;

// Оптимизация FPS для слабых устройств (поставь true если лагает)
const PERFORMANCE_MODE = true;
const DETECT_EVERY_N_FRAMES = PERFORMANCE_MODE ? 2 : 1; // 2 = детекция раз в 2 кадра
const VIDEO_WIDTH = PERFORMANCE_MODE ? 1280 : 1920;
const VIDEO_HEIGHT = PERFORMANCE_MODE ? 720 : 1080;

const MOTION_TR = {
  "Sağ elini kaldırdın": "Ты поднял правую руку",
  "Sağ elini indirdin": "Ты опустил правую руку",
  "Sol elini kaldırdın": "Ты поднял левую руку",
  "Sol elini indirdin": "Ты опустил левую руку",
  "İki elini kaldırdın": "Ты поднял обе руки",
  "Kollarını açtın": "Ты раскрыл руки",
  "Başını sola çevirdin": "Ты повернул голову влево",
  "Başını sağa çevirdin": "Ты повернул голову вправо",
  "Çömeliyorsun": "Ты присел",
  "Ayağa kalktın": "Ты встал",
  "Eğildin": "Ты наклонился",
  "Gözünü kapattın": "Ты закрыл глаза",
  "Gözünü açtın": "Ты открыл глаза",
  "Cismi tutup kaldırdın": "Ты поднял объект",
};

// DOM
const video = document.getElementById("video");
const output = document.getElementById("output");
const drawCanvas = document.getElementById("drawCanvas");
const cameraOverlay = document.getElementById("cameraOverlay");
const eyeOverlay = document.getElementById("eyeOverlay");
const errorMessage = document.getElementById("errorMessage");
const lowLightWarning = document.getElementById("lowLightWarning");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const drawBtn = document.getElementById("drawBtn");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const drawToolbar = document.getElementById("drawToolbar");
const toolbarTrigger = document.getElementById("toolbarTrigger");
const toolbarContent = document.getElementById("toolbarContent");
const gestureCursor = document.getElementById("gestureCursor");
const toolbarColor = document.getElementById("toolbarColor");
const toolbarSize = document.getElementById("toolbarSize");
const toolbarSizeVal = document.getElementById("toolbarSizeVal");
const objectsBtn = document.getElementById("objectsBtn");
const addObjBtn = document.getElementById("addObjBtn");
const removeObjBtn = document.getElementById("removeObjBtn");
const showSkeletonCheck = document.getElementById("showSkeleton");
const currentMotionEl = document.getElementById("currentMotion");
const motionLogEl = document.getElementById("motionLog");
const fpsEl = document.getElementById("fps");
const modeCameraBtn = document.getElementById("modeCameraBtn");
const modeWhiteSheetBtn = document.getElementById("modeWhiteSheetBtn");
const cameraWrapper = document.getElementById("cameraWrapper");
const previewCanvas = document.getElementById("previewCanvas");

// State
let poseLandmarker = null;
let faceLandmarker = null;
let handLandmarker = null;
let stream = null;
let loopId = null;
let lastMotion = "";
let lastMotionTime = 0;
let lastVideoTime = -1;
let frameCount = 0;
let lastFpsTime = performance.now();
let wasStanding = false;
let wasSitting = false;
let eyesClosedFrames = 0;
let eyesOpenFrames = 0;
let lastEyesClosedReport = 0;
let lastEyesOpenReport = 0;
let lastGrabbedReport = 0;
let drawMode = false;
let objectsMode = false;
let drawColor = "#00ff9f";
let drawLineWidth = 4;
let drawShape = "free";
let strokes = [];
let shapes = [];
let currentStroke = { points: [], color: "#00ff9f" };
let fingerLostFrames = 0;
let lastDrawHandId = null;
let wasPinching = false;
let wasTwoFingersClick = false;
let showSkeleton = true;
let whiteSheetMode = false;
let wasToolbarPinch = false;
let shapeInProgress = null; // { center, size, type } — pinch+drag для размера фигуры
// Кэш для throttled detection (переиспользуем при пропуске кадров)
let cachedLm = null;
let cachedEyesClosed = false;
let cachedHandLandmarks = [];

const OBJECT_COLORS = ["#00ff9f", "#ff6b9d", "#6b9dff", "#ffd93d", "#6bcb77", "#4d96ff"];
let objectIdCounter = 0;

function createObject(x, y, r = 0.05) {
  objectIdCounter++;
  const color = OBJECT_COLORS[(objectIdCounter - 1) % OBJECT_COLORS.length];
  return {
    id: objectIdCounter,
    x, y, r, color,
    grabbed: false, origX: x, origY: y,
    vx: 0, vy: 0, flying: false, trail: []
  };
}

let VIRTUAL_OBJECTS = [
  createObject(0.25, 0.4, 0.06),
  createObject(0.5, 0.35, 0.05),
  createObject(0.75, 0.4, 0.055)
];
let lastGrabPos = null;
const grabHistory = [];
const GRAB_HISTORY_MAX = 5;

// Koordinat dönüşümü (video/canvas piksel)
function toPx(p, w, h) {
  const x = MIRROR_CAMERA ? (1 - p.x) * w : p.x * w;
  return { x, y: p.y * h };
}

// ========== EL 21 LANDMARK - HER PARMAK AYRI TAKİP ==========
function getFingerColor(idx) {
  if (idx <= 4) return FINGER_COLORS.thumb;
  if (idx <= 8) return FINGER_COLORS.index;
  if (idx <= 12) return FINGER_COLORS.middle;
  if (idx <= 16) return FINGER_COLORS.ring;
  return FINGER_COLORS.pinky;
}

function drawHandLandmarks(ctx, hands, w, h) {
  if (!hands || hands.length === 0) return;
  hands.forEach((hand) => {
    if (!hand || hand.length < 21) return;
    // Bağlantı çizgileri - her parmak kendi rengi
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    HAND_CONNECTIONS.forEach(([i, j]) => {
      const a = hand[i], b = hand[j];
      if (a && b) {
        const p1 = toPx(a, w, h), p2 = toPx(b, w, h);
        ctx.strokeStyle = getFingerColor(i);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    });
    // Her parmak boğumu ve ucu - belirgin noktalar
    hand.forEach((p, i) => {
      if (!p) return;
      const pt = toPx(p, w, h);
      const isTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = getFingerColor(i);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isTip ? 10 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  });
}

// İki parmak (işaret + orta) - ТОЛЬКО полностью выпрямлены (ластик)
function isTwoFingersExtended(hand) {
  if (!hand || hand.length < 21) return false;
  const idxTip = hand[8], midTip = hand[12], idxPip = hand[6], midPip = hand[10];
  const ringTip = hand[16], pinkyTip = hand[20];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lenIdx = d(idxTip, hand[5]);
  const lenMid = d(midTip, hand[9]);
  const lenRing = d(ringTip, hand[13]);
  const lenPinky = d(pinkyTip, hand[17]);
  const distIdxMid = d(idxTip, midTip);
  // Минимум 0.07 — при согнутых пальцах tip ближе к MCP
  const minExtended = 0.07;
  // Проверка "прямоты": tip далеко от PIP — при согнутом пальце tip ближе к суставу
  const tipToPipIdx = d(idxTip, idxPip);
  const tipToPipMid = d(midTip, midPip);
  return lenIdx >= minExtended && lenMid >= minExtended &&
         tipToPipIdx > 0.03 && tipToPipMid > 0.03 &&
         lenIdx > lenRing * 1.2 && lenMid > lenRing * 1.2 &&
         lenIdx > lenPinky * 1.2 && lenMid > lenPinky * 1.2 &&
         distIdxMid > 0.03 && distIdxMid < 0.22;
}

function getTwoFingerPosition(hand) {
  if (!hand || hand.length < 13 || !isTwoFingersExtended(hand)) return null;
  const idx = hand[8], mid = hand[12];
  return { x: (idx.x + mid.x) / 2, y: (idx.y + mid.y) / 2 };
}

// Центр, расстояние и вектор между большим и указательным (для размера фигуры)
function getThumbIndexSize(hand) {
  if (!hand || hand.length < 9) return null;
  const thumb = hand[4], idx = hand[8];
  const dx = idx.x - thumb.x, dy = idx.y - thumb.y;
  const dist = Math.hypot(dx, dy);
  return { center: { x: (thumb.x + idx.x) / 2, y: (thumb.y + idx.y) / 2 }, size: dist, dx, dy };
}

function normToClient(normX, normY, w, h) {
  const px = MIRROR_CAMERA ? (1 - normX) * w : normX * w;
  const py = normY * h;
  const rect = output.getBoundingClientRect();
  return {
    clientX: rect.left + (px / w) * rect.width,
    clientY: rect.top + (py / h) * rect.height
  };
}

function simulateClickAtPosition(normX, normY, w, h) {
  const { clientX, clientY } = normToClient(normX, normY, w, h);
  const el = document.elementFromPoint(clientX, clientY);
  if (el) {
    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left;
    if (el.type === "range") {
      const pct = Math.max(0, Math.min(1, rect.width > 0 ? relX / rect.width : 0));
      const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100;
      el.value = min + pct * (max - min);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      ["mousedown", "mouseup", "click"].forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: type === "mousedown" ? 1 : 0 }));
      });
      if (el.type === "color") el.showPicker?.();
    }
  }
}

function simulateMouseMoveAtPosition(normX, normY, w, h) {
  const { clientX, clientY } = normToClient(normX, normY, w, h);
  const el = document.elementFromPoint(clientX, clientY);
  if (el) {
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 0 }));
  }
}

function isPointOverToolbar(clientX, clientY) {
  if (!drawToolbar) return false;
  const r = drawToolbar.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function updateGestureCursor(clientX, clientY, visible) {
  if (!gestureCursor) return;
  if (visible) {
    gestureCursor.style.left = clientX + "px";
    gestureCursor.style.top = clientY + "px";
    gestureCursor.classList.add("visible");
  } else {
    gestureCursor.classList.remove("visible");
  }
}

// İşaret parmağı uzatılmış mı? Yumrukta çizim yok
function isIndexFingerExtended(hand) {
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

// ========== POSE İSKELET ==========
function drawPoseSkeleton(ctx, lm, w, h) {
  if (!lm || lm.length < 29) return;
  ctx.strokeStyle = "#00ff9f";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,255,159,0.5)";
  ctx.shadowBlur = 6;
  POSE_CONNECTIONS.forEach(([i, j]) => {
    const a = lm[i], b = lm[j];
    const va = a?.visibility ?? 1, vb = b?.visibility ?? 1;
    if (a && b && va > MIN_VIS && vb > MIN_VIS) {
      const p1 = toPx(a, w, h), p2 = toPx(b, w, h);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  });
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#00ff9f";
  lm.forEach((p, i) => {
    if ((p?.visibility ?? 1) > MIN_VIS) {
      const pt = toPx(p, w, h);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// ========== GÖZ - Belirgin çerçeve, yüz net görünsün ==========
const EYE_LEFT = [33, 160, 159, 158, 157, 173, 133];
const EYE_RIGHT = [362, 385, 386, 387, 388, 466, 263];

function drawEyeContours(ctx, pts, w, h) {
  if (!pts || pts.length < 400) return;
  ctx.strokeStyle = "rgba(0,255,159,0.75)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  [EYE_LEFT, EYE_RIGHT].forEach((indices) => {
    ctx.beginPath();
    indices.forEach((i, j) => {
      const p = pts[i];
      if (p) {
        const pt = toPx(p, w, h);
        ctx[j ? "lineTo" : "moveTo"](pt.x, pt.y);
      }
    });
    ctx.closePath();
    ctx.stroke();
  });
}

function checkEyesClosed(faceResults) {
  if (!faceResults?.faceBlendshapes?.[0]) return false;
  let l = 0, r = 0;
  for (const b of faceResults.faceBlendshapes[0]) {
    if (b.categoryName === "eyeBlinkLeft") l = b.score;
    if (b.categoryName === "eyeBlinkRight") r = b.score;
  }
  return (l + r) / 2 > 0.4;
}

// ========== HAREKET ANALİZİ ==========
function analyzePose(lm) {
  const g = (i) => lm[i];
  const v = (i) => (lm[i]?.visibility ?? 0) > MIN_VIS;
  if (!lm || lm.length < 29) return null;
  const motions = [];
  if (v(POSE.RIGHT_WRIST) && v(POSE.RIGHT_SHOULDER)) {
    const wy = g(POSE.RIGHT_WRIST).y, sy = g(POSE.RIGHT_SHOULDER).y;
    if (wy < sy - 0.05) motions.push("Sağ elini kaldırdın");
    else if (wy > sy + 0.08) motions.push("Sağ elini indirdin");
  }
  if (v(POSE.LEFT_WRIST) && v(POSE.LEFT_SHOULDER)) {
    const wy = g(POSE.LEFT_WRIST).y, sy = g(POSE.LEFT_SHOULDER).y;
    if (wy < sy - 0.05) motions.push("Sol elini kaldırdın");
    else if (wy > sy + 0.08) motions.push("Sol elini indirdin");
  }
  if (v(POSE.LEFT_WRIST) && v(POSE.RIGHT_WRIST) && v(POSE.LEFT_SHOULDER) && v(POSE.RIGHT_SHOULDER)) {
    const lw = g(POSE.LEFT_WRIST).y, rw = g(POSE.RIGHT_WRIST).y, ls = g(POSE.LEFT_SHOULDER).y, rs = g(POSE.RIGHT_SHOULDER).y;
    if (lw < ls - 0.05 && rw < rs - 0.05) motions.push("İki elini kaldırdın");
  }
  if (v(POSE.LEFT_WRIST) && v(POSE.RIGHT_WRIST) && v(POSE.LEFT_SHOULDER) && v(POSE.RIGHT_SHOULDER)) {
    const wd = Math.abs(g(POSE.LEFT_WRIST).x - g(POSE.RIGHT_WRIST).x);
    const sd = Math.abs(g(POSE.LEFT_SHOULDER).x - g(POSE.RIGHT_SHOULDER).x);
    if (wd > sd * 1.3 && wd > 0.4) motions.push("Kollarını açtın");
  }
  if (v(POSE.NOSE) && v(POSE.LEFT_SHOULDER) && v(POSE.RIGHT_SHOULDER)) {
    const nx = g(POSE.NOSE).x, mid = (g(POSE.LEFT_SHOULDER).x + g(POSE.RIGHT_SHOULDER).x) / 2;
    if (nx < mid - 0.06) motions.push("Başını sola çevirdin");
    else if (nx > mid + 0.06) motions.push("Başını sağa çevirdin");
  }
  if (v(POSE.LEFT_HIP) && v(POSE.LEFT_KNEE) && v(POSE.RIGHT_HIP) && v(POSE.RIGHT_KNEE)) {
    const ld = g(POSE.LEFT_KNEE).y - g(POSE.LEFT_HIP).y, rd = g(POSE.RIGHT_KNEE).y - g(POSE.RIGHT_HIP).y;
    if (ld < 0.2 && rd < 0.2) { motions.push("Çömeliyorsun"); wasSitting = true; wasStanding = false; }
  }
  if (v(POSE.LEFT_HIP) && v(POSE.LEFT_ANKLE) && v(POSE.RIGHT_HIP) && v(POSE.RIGHT_ANKLE)) {
    const la = g(POSE.LEFT_ANKLE).y, lh = g(POSE.LEFT_HIP).y, ra = g(POSE.RIGHT_ANKLE).y, rh = g(POSE.RIGHT_HIP).y;
    if (la > lh + 0.15 && ra > rh + 0.15) {
      if (!wasStanding && wasSitting) motions.push("Ayağa kalktın");
      wasStanding = true;
      wasSitting = false;
    }
  }
  if (v(POSE.LEFT_SHOULDER) && v(POSE.RIGHT_SHOULDER) && v(POSE.LEFT_HIP) && v(POSE.RIGHT_HIP)) {
    const sy = (g(POSE.LEFT_SHOULDER).y + g(POSE.RIGHT_SHOULDER).y) / 2;
    const hy = (g(POSE.LEFT_HIP).y + g(POSE.RIGHT_HIP).y) / 2;
    if (sy > hy + 0.12) motions.push("Eğildin");
  }
  return motions[0] || null;
}

function reportMotion(text) {
  const now = Date.now();
  if (text === lastMotion && now - lastMotionTime < DEBOUNCE_MS) return;
  lastMotion = text;
  lastMotionTime = now;
  if (currentMotionEl) {
    const ru = MOTION_TR[text] || text;
    currentMotionEl.innerHTML = `<span class="motion-text highlight"><span class="motion-tr">${text}</span><span class="motion-ru">${ru}</span></span>`;
  }
  if (motionLogEl) {
    const ru = MOTION_TR[text] || text;
    const li = document.createElement("li");
    li.innerHTML = `<span class="time">${new Date().toLocaleTimeString("tr-TR")}</span>${text} / ${ru}`;
    motionLogEl.insertBefore(li, motionLogEl.firstChild);
    while (motionLogEl.children.length > 25) motionLogEl.removeChild(motionLogEl.lastChild);
  }
}

// ========== EL TUTMA VE ÇİZİM ==========
// Yumruk sıkılı mı? (tüm parmak uçları birbirine yakın)
function isFistClenched(hand) {
  if (!hand || hand.length < 21) return false;
  const idx = hand[8], mid = hand[12], ring = hand[16], pinky = hand[20];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const maxDist = 0.12;
  return d(idx, mid) < maxDist && d(mid, ring) < maxDist && d(ring, pinky) < maxDist && d(idx, pinky) < 0.16;
}

function getHandGrabPoint(hand) {
  if (!hand || hand.length < 21) return null;
  if (!isFistClenched(hand)) return null;
  const idx = hand[8], mid = hand[12], ring = hand[16], pinky = hand[20];
  return {
    x: (idx.x + mid.x + ring.x + pinky.x) / 4,
    y: (idx.y + mid.y + ring.y + pinky.y) / 4
  };
}

function getIndexFingerTip(hand, requireExtended = false) {
  if (!hand || hand.length < 9) return null;
  const tip = hand[8];
  if (!tip) return null;
  if (requireExtended && !isIndexFingerExtended(hand)) return null;
  return { x: tip.x, y: tip.y };
}

// İşaret + başparmak pinch - для рисования и фигур
function isIndexThumbPinch(hand) {
  if (!hand || hand.length < 9) return false;
  const idxTip = hand[8], thumbTip = hand[4];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return d(idxTip, thumbTip) < 0.06;
}

function getPinchCursorPosition(hand) {
  if (!hand || hand.length < 9) return null;
  const idxTip = hand[8];
  // İmleç: işaret uzatılmış veya pinch sırasında (parmak hafif bükülü olabilir)
  if (!isIndexFingerExtended(hand) && !isIndexThumbPinch(hand)) return null;
  return { x: idxTip.x, y: idxTip.y };
}

function updateObjects(hands, dt) {
  const now = performance.now();
  const grabbed = VIRTUAL_OBJECTS.find((o) => o.grabbed);

  const BOUND_MIN = 0.04;
  const BOUND_MAX = 0.96;
  const BOUNCE_DAMP = 0.5;

  function calcThrowVel() {
    if (grabHistory.length < 2 || !lastGrabPos) {
      return lastGrabPos && grabbed
        ? { vx: (grabbed.x - lastGrabPos.x) * 25, vy: (grabbed.y - lastGrabPos.y) * 25 }
        : { vx: 0, vy: 0 };
    }
    const old = grabHistory[0];
    const cur = grabHistory[grabHistory.length - 1];
    const frames = grabHistory.length;
    const scale = 20 / Math.max(frames, 1);
    return {
      vx: (cur.x - old.x) * scale,
      vy: (cur.y - old.y) * scale
    };
  }

  if (!hands || hands.length === 0) {
    if (grabbed) {
      const vel = calcThrowVel();
      grabbed.vx = vel.vx;
      grabbed.vy = vel.vy;
      grabbed.flying = true;
      grabbed.grabbed = false;
    }
    lastGrabPos = null;
    grabHistory.length = 0;
  } else {
  let anyGrab = false;
  hands.forEach((hand) => {
    const grab = getHandGrabPoint(hand);
    if (grab) {
      anyGrab = true;
      const gx = grab.x, gy = grab.y;
      if (grabbed) {
        lastGrabPos = { x: grabbed.x, y: grabbed.y };
        grabbed.x = gx;
        grabbed.y = gy;
        grabHistory.push({ x: gx, y: gy });
        if (grabHistory.length > GRAB_HISTORY_MAX) grabHistory.shift();
      } else {
        let nearest = null, nd = 0.12;
        VIRTUAL_OBJECTS.forEach((obj) => {
          const d = Math.hypot(gx - obj.x, gy - obj.y);
          if (d < nd) { nd = d; nearest = obj; }
        });
        if (nearest && Date.now() - lastGrabbedReport > DEBOUNCE_MS) {
          nearest.grabbed = true;
          nearest.x = gx;
          nearest.y = gy;
          nearest.flying = false;
          nearest.vx = 0;
          nearest.vy = 0;
          lastGrabPos = { x: gx, y: gy };
          grabHistory.length = 0;
          grabHistory.push({ x: gx, y: gy });
          reportMotion("Cismi tutup kaldırdın");
          lastGrabbedReport = Date.now();
        }
      }
    }
  });

  if (!anyGrab && grabbed) {
    const vel = calcThrowVel();
    grabbed.vx = vel.vx;
    grabbed.vy = vel.vy;
    grabbed.flying = true;
    grabbed.grabbed = false;
    lastGrabPos = null;
    grabHistory.length = 0;
  }
  if (!anyGrab) {
    lastGrabPos = null;
    grabHistory.length = 0;
  }
  }

  VIRTUAL_OBJECTS.forEach((obj) => {
    if (obj.flying) {
      obj.trail.push({ x: obj.x, y: obj.y });
      if (obj.trail.length > 12) obj.trail.shift();
      obj.x += obj.vx * dt;
      obj.y += obj.vy * dt;
      obj.vx *= 0.985;
      obj.vy *= 0.985;
      if (obj.x < BOUND_MIN) { obj.x = BOUND_MIN; obj.vx = Math.abs(obj.vx) * BOUNCE_DAMP; }
      if (obj.x > BOUND_MAX) { obj.x = BOUND_MAX; obj.vx = -Math.abs(obj.vx) * BOUNCE_DAMP; }
      if (obj.y < BOUND_MIN) { obj.y = BOUND_MIN; obj.vy = Math.abs(obj.vy) * BOUNCE_DAMP; }
      if (obj.y > BOUND_MAX) { obj.y = BOUND_MAX; obj.vy = -Math.abs(obj.vy) * BOUNCE_DAMP; }
      if (Math.abs(obj.vx) < 0.0008 && Math.abs(obj.vy) < 0.0008) {
        obj.flying = false;
        obj.trail = [];
      }
    }
  });
}

function drawObjects(ctx, w, h) {
  VIRTUAL_OBJECTS.forEach((obj) => {
    if (obj.flying && obj.trail.length > 1) {
      ctx.beginPath();
      obj.trail.forEach((t, i) => {
        const pt = toPx({ x: t.x, y: t.y }, w, h);
        ctx[i ? "lineTo" : "moveTo"](pt.x, pt.y);
      });
      ctx.strokeStyle = obj.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = (obj.r * Math.min(w, h)) * 0.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const pt = toPx({ x: obj.x, y: obj.y }, w, h);
    const r = obj.r * Math.min(w, h);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fillStyle = obj.color;
    ctx.globalAlpha = obj.grabbed ? 0.95 : 0.88;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

// Renk hex -> rgba
function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ========== ÇİZİM KATMANI - Modern neon stil ==========
function drawStrokesToCanvas(w, h) {
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, w, h);
  const sx = (x) => (MIRROR_CAMERA ? (1 - x) * w : x * w);

  const defLw = drawLineWidth || 4;

  shapes.forEach((sh) => {
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    const lwGlow = Math.max(lw * 4, 18);
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      const cx = sx(sh.cx), cy = sh.cy * h;
      dctx.beginPath();
      dctx.arc(cx, cy, sh.r * Math.min(w, h), 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "rect") {
      const x = sx(sh.x), y = sh.y * h;
      const rw = sh.w * w, rh = sh.h * h;
      dctx.strokeRect(x, y, rw, rh);
    } else if (sh.type === "line") {
      dctx.beginPath();
      dctx.moveTo(sx(sh.x1), sh.y1 * h);
      dctx.lineTo(sx(sh.x2), sh.y2 * h);
      dctx.stroke();
    } else if (sh.type === "ellipse") {
      const cx = sx(sh.x + sh.w / 2), cy = (sh.y + sh.h / 2) * h;
      const rx = (sh.w / 2) * w, ry = (sh.h / 2) * h;
      dctx.beginPath();
      dctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "triangle") {
      dctx.beginPath();
      dctx.moveTo(sx(sh.x1), sh.y1 * h);
      dctx.lineTo(sx(sh.x2), sh.y2 * h);
      dctx.lineTo(sx(sh.x3), sh.y3 * h);
      dctx.closePath();
      dctx.stroke();
    } else if (sh.type === "arrow") {
      const x1 = sx(sh.x1), y1 = sh.y1 * h, x2 = sx(sh.x2), y2 = sh.y2 * h;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const arrowLen = Math.min(len * 0.3, 20);
      const ax = x2 - ux * arrowLen + uy * arrowLen * 0.4;
      const ay = y2 - uy * arrowLen - ux * arrowLen * 0.4;
      const bx = x2 - ux * arrowLen - uy * arrowLen * 0.4;
      const by = y2 - uy * arrowLen + ux * arrowLen * 0.4;
      dctx.beginPath();
      dctx.moveTo(x1, y1);
      dctx.lineTo(x2, y2);
      dctx.moveTo(ax, ay);
      dctx.lineTo(x2, y2);
      dctx.lineTo(bx, by);
      dctx.stroke();
    }
  });

  // Превью фигуры при pinch+drag (зажать и тянуть по диагонали)
  if (shapeInProgress && drawMode) {
    const sp = shapeInProgress;
    const x1 = Math.min(sp.start.x, sp.end.x), x2 = Math.max(sp.start.x, sp.end.x);
    const y1 = Math.min(sp.start.y, sp.end.y), y2 = Math.max(sp.start.y, sp.end.y);
    const px1 = sx(x1), py1 = y1 * h, px2 = sx(x2), py2 = y2 * h;
    const rw = (x2 - x1) * w, rh = (y2 - y1) * h;
    const cx = (px1 + px2) / 2, cy = (py1 + py2) / 2;
    const rad = Math.hypot(rw, rh) / 2;
    const startPx = sx(sp.start.x), startPy = sp.start.y * h;
    dctx.strokeStyle = drawColor;
    dctx.lineWidth = 2;
    dctx.setLineDash([6, 4]);
    if (sp.type === "rect" || sp.type === "ellipse") {
      dctx.beginPath();
      dctx.arc(startPx, startPy, 6, 0, Math.PI * 2);
      dctx.fillStyle = drawColor;
      dctx.globalAlpha = 0.5;
      dctx.fill();
      dctx.globalAlpha = 1;
      dctx.stroke();
    }
    if (sp.type === "circle") {
      dctx.beginPath();
      dctx.arc(cx, cy, Math.max(rad, 4), 0, Math.PI * 2);
      dctx.stroke();
    } else if (sp.type === "rect" || sp.type === "ellipse") {
      if (sp.type === "rect") dctx.strokeRect(px1, py1, rw, rh);
      else if (sp.type === "ellipse") {
        dctx.beginPath();
        dctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2);
        dctx.stroke();
      }
    } else if (sp.type === "line" || sp.type === "arrow") {
      dctx.beginPath();
      dctx.moveTo(sx(sp.start.x), sp.start.y * h);
      dctx.lineTo(sx(sp.end.x), sp.end.y * h);
      dctx.stroke();
      if (sp.type === "arrow") {
        const dx = sp.end.x - sp.start.x, dy = sp.end.y - sp.start.y;
        const len = Math.hypot(dx, dy) || 0.001;
        const ux = dx / len, uy = dy / len;
        const arr = 0.08;
        const ax = sp.end.x - ux * arr + uy * arr * 0.5;
        const ay = sp.end.y - uy * arr - ux * arr * 0.5;
        const bx = sp.end.x - ux * arr - uy * arr * 0.5;
        const by = sp.end.y - uy * arr + ux * arr * 0.5;
        dctx.beginPath();
        dctx.moveTo(sx(ax), ay * h);
        dctx.lineTo(sx(sp.end.x), sp.end.y * h);
        dctx.lineTo(sx(bx), by * h);
        dctx.stroke();
      }
    } else if (sp.type === "triangle") {
      const x3 = sp.start.x, y3 = sp.end.y;
      dctx.beginPath();
      dctx.moveTo(sx(sp.start.x), sp.start.y * h);
      dctx.lineTo(sx(sp.end.x), sp.end.y * h);
      dctx.lineTo(sx(x3), y3 * h);
      dctx.closePath();
      dctx.stroke();
    }
    dctx.setLineDash([]);
  }

  const allStrokes = [...strokes, currentStroke.points.length > 0 ? currentStroke : null].filter(Boolean);
  allStrokes.forEach((stroke) => {
    const pts = stroke.points || stroke;
    const color = stroke.color || drawColor;
    const lw = stroke.lineWidth ?? defLw;
    const lwGlow = Math.max(lw * 4, 18);
    const lwMid = Math.max(lw * 2, 10);
    if (pts.length < 2) return;
    dctx.beginPath();
    dctx.moveTo(sx(pts[0].x), pts[0].y * h);
    for (let i = 1; i < pts.length; i++) dctx.lineTo(sx(pts[i].x), pts[i].y * h);
    const rgba = hexToRgba(color, 0.15);
    const rgba2 = hexToRgba(color, 0.4);
    dctx.strokeStyle = rgba;
    dctx.lineWidth = lwGlow;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    dctx.stroke();
    dctx.strokeStyle = rgba2;
    dctx.lineWidth = lwMid;
    dctx.stroke();
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.shadowColor = color;
    dctx.shadowBlur = 12;
    dctx.stroke();
    dctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    dctx.lineWidth = 1.5;
    dctx.shadowBlur = 0;
    dctx.stroke();
  });

  // İmleç: маленькая красивая точка
  if (window.drawCursor && drawMode) {
    const cx = MIRROR_CAMERA ? (1 - window.drawCursor.x) * w : window.drawCursor.x * w;
    const cy = window.drawCursor.y * h;
    dctx.beginPath();
    dctx.arc(cx, cy, 3, 0, Math.PI * 2);
    dctx.shadowColor = drawColor;
    dctx.shadowBlur = 6;
    dctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    dctx.fill();
    dctx.shadowBlur = 0;
    dctx.strokeStyle = drawColor;
    dctx.lineWidth = 1;
    dctx.stroke();
  }
  dctx.shadowBlur = 0;
}

function eraseAtPosition(eraseX, eraseY, radius = 0.07) {
  const r2 = radius * radius;
  shapes = shapes.filter((sh) => {
    let dx, dy;
    if (sh.type === "circle") { dx = sh.cx - eraseX; dy = sh.cy - eraseY; }
    else if (sh.type === "rect" || sh.type === "ellipse") { dx = (sh.x + sh.w / 2) - eraseX; dy = (sh.y + sh.h / 2) - eraseY; }
    else if (sh.type === "line" || sh.type === "arrow") { dx = (sh.x1 + sh.x2) / 2 - eraseX; dy = (sh.y1 + sh.y2) / 2 - eraseY; }
    else if (sh.type === "triangle") { dx = (sh.x1 + sh.x2 + sh.x3) / 3 - eraseX; dy = (sh.y1 + sh.y2 + sh.y3) / 3 - eraseY; }
    else return true;
    return dx * dx + dy * dy > r2;
  });
  const newStrokes = [];
  for (const stroke of strokes) {
    const pts = stroke.points || stroke;
    const color = stroke.color || drawColor;
    const lw = stroke.lineWidth ?? drawLineWidth;
    const segments = [];
    let seg = [];
    for (const pt of pts) {
      const d2 = (pt.x - eraseX) ** 2 + (pt.y - eraseY) ** 2;
      if (d2 < r2) {
        if (seg.length > 1) segments.push({ points: seg, color, lineWidth: lw });
        seg = [];
      } else {
        seg.push(pt);
      }
    }
    if (seg.length > 1) segments.push({ points: seg, color, lineWidth: lw });
    segments.forEach((s) => newStrokes.push(s));
  }
  strokes = newStrokes;
}

// ========== ANA DÖNGÜ ==========
function detectLoop() {
  if (!stream || !video.srcObject) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  if (video.readyState < 2) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  const w = output.width;
  const h = output.height;
  if (w <= 0 || h <= 0) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  const ctx = output.getContext("2d");
  const t = performance.now();
  if (t <= lastVideoTime) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  const dt = Math.min((t - lastVideoTime) / 1000, 0.05);
  lastVideoTime = t;

  // В режиме рисования — только рука (без pose/face), но каждый кадр для точного отслеживания
  const drawModeHandOnly = drawMode;
  const shouldDetect = drawModeHandOnly || (frameCount % DETECT_EVERY_N_FRAMES) === 0;

  // 1. Video çiz - ayna modu (beyaz kağıt modunda output gizli)
  if (MIRROR_CAMERA) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }

  try {
    let lm, handLandmarks;

    if (shouldDetect) {
      // 2. Pose — пропускаем в режиме рисования (только рука нужна)
      lm = null;
      if (!drawModeHandOnly && poseLandmarker) {
        const poseRes = poseLandmarker.detectForVideo(video, t);
        if (poseRes.landmarks?.length > 0) {
          lowLightWarning.classList.remove("visible");
          lm = poseRes.landmarks[0];
          cachedLm = lm;
          if (showSkeleton) drawPoseSkeleton(ctx, lm, w, h);
          const motion = analyzePose(lm);
          if (motion) reportMotion(motion);
        } else {
          lowLightWarning.classList.add("visible");
          cachedLm = null;
        }
      }

      // 3. Yüz / Göz — пропускаем в режиме рисования
      if (!drawModeHandOnly && faceLandmarker) {
        try {
          const faceRes = faceLandmarker.detectForVideo(video, t);
          if (faceRes.faceLandmarks?.length > 0) {
            window.eyesClosed = checkEyesClosed(faceRes);
            cachedEyesClosed = window.eyesClosed;
            if (showSkeleton) drawEyeContours(ctx, faceRes.faceLandmarks[0], w, h);
          } else {
            window.eyesClosed = false;
            cachedEyesClosed = false;
          }
        } catch (_) {}
      }

      // 4. El - 21 landmark
      handLandmarks = [];
      if (handLandmarker) {
        try {
          const handRes = handLandmarker.detectForVideo(video, t);
          handLandmarks = handRes.landmarks || [];
          cachedHandLandmarks = handLandmarks;
          if (showSkeleton && !drawModeHandOnly) drawHandLandmarks(ctx, handLandmarks, w, h);
        } catch (_) {}
      }
    } else {
      lm = cachedLm;
      window.eyesClosed = cachedEyesClosed;
      handLandmarks = cachedHandLandmarks || [];
      if (lm && showSkeleton) drawPoseSkeleton(ctx, lm, w, h);
      if (handLandmarks?.length && showSkeleton && !drawModeHandOnly) drawHandLandmarks(ctx, handLandmarks, w, h);
    }

    if (objectsMode) {
      updateObjects(handLandmarks, dt);
      drawObjects(ctx, w, h);
    }

    // 4b. İki parmak (işaret+orta) = клик по кнопкам (не в режиме рисования, там = ластик)
    if (handLandmarker && handLandmarks.length > 0 && !drawMode) {
      let twoFingerPos = null;
      for (let i = 0; i < handLandmarks.length; i++) {
        twoFingerPos = getTwoFingerPosition(handLandmarks[i]);
        if (twoFingerPos) break;
      }
      if (twoFingerPos) {
        if (!wasTwoFingersClick) {
          wasTwoFingersClick = true;
          simulateClickAtPosition(twoFingerPos.x, twoFingerPos.y, w, h);
        }
      } else {
        wasTwoFingersClick = false;
      }
    } else {
      wasTwoFingersClick = false;
    }

    // 5. Çizim / Silgi - pinch ile çizim (işaret+başparmak), imleç göster
    if (drawMode && handLandmarker) {
      let cursorPos = null;
      let twoFingerPos = null;
      let handIdx = -1;
      for (let i = 0; i < handLandmarks.length; i++) {
        cursorPos = getPinchCursorPosition(handLandmarks[i]);
        if (cursorPos) {
          handIdx = i;
          break;
        }
      }
      if (!cursorPos) {
        for (let i = 0; i < handLandmarks.length; i++) {
          twoFingerPos = getTwoFingerPosition(handLandmarks[i]);
          if (twoFingerPos) break;
        }
      }

      // 5a. Панель: указательный над полосой слева или панелью = мышь, щепотка = клик
      const overToolbar = cursorPos && (() => {
        const normX = MIRROR_CAMERA ? (1 - cursorPos.x) : cursorPos.x;
        const { clientX, clientY } = normToClient(cursorPos.x, cursorPos.y, w, h);
        return normX < 0.03 || isPointOverToolbar(clientX, clientY);
      })();

      if (overToolbar) {
        shapeInProgress = null;
        drawToolbar?.classList.add("expanded");
        const { clientX, clientY } = normToClient(cursorPos.x, cursorPos.y, w, h);
        simulateMouseMoveAtPosition(cursorPos.x, cursorPos.y, w, h);
        updateGestureCursor(clientX, clientY, true);
        const isPinch = handLandmarks[handIdx] && isIndexThumbPinch(handLandmarks[handIdx]);
        if (isPinch) {
          if (!wasToolbarPinch) {
            wasToolbarPinch = true;
            simulateClickAtPosition(cursorPos.x, cursorPos.y, w, h);
          }
        } else {
          wasToolbarPinch = false;
        }
        window.drawCursor = null; // не показываем на drawCanvas — есть gestureCursor
      } else {
        wasToolbarPinch = false;
        updateGestureCursor(0, 0, false);
      }

      if (overToolbar) {
        // пропускаем рисование/стирание — только панель
      } else if (twoFingerPos && !cursorPos) {
        drawToolbar?.classList.remove("expanded");
        fingerLostFrames = 0;
        wasPinching = false;
        shapeInProgress = null;
        currentStroke = { points: [], color: drawColor };
        window.drawCursor = null;
        eraseAtPosition(twoFingerPos.x, twoFingerPos.y, 0.08);
      } else if (cursorPos) {
        drawToolbar?.classList.remove("expanded");
        window.drawCursor = cursorPos;
        const isPinch = handLandmarks[handIdx] && isIndexThumbPinch(handLandmarks[handIdx]);
        const tiCenter = handLandmarks[handIdx] && getThumbIndexSize(handLandmarks[handIdx])?.center;
        const pinchPos = tiCenter && tiCenter.x >= 0 && tiCenter.x <= 1 && tiCenter.y >= 0 && tiCenter.y <= 1 ? tiCenter : cursorPos;
        if (isPinch) {
          fingerLostFrames = 0;
          if (["circle","rect","line","ellipse","triangle","arrow"].includes(drawShape)) {
            if (cursorPos.x >= 0 && cursorPos.x <= 1 && cursorPos.y >= 0 && cursorPos.y <= 1) {
              if (!shapeInProgress) shapeInProgress = { start: { x: pinchPos.x, y: pinchPos.y }, end: { x: pinchPos.x, y: pinchPos.y }, type: drawShape };
              else shapeInProgress.end = { x: pinchPos.x, y: pinchPos.y };
            }
          } else {
            const pts = currentStroke.points;
            const last = pts[pts.length - 1];
            const dx = last ? cursorPos.x - last.x : 0;
            const dy = last ? cursorPos.y - last.y : 0;
            const dist = Math.hypot(dx, dy);
            const maxJump = 0.15;
            if (dist > maxJump && last) {
              if (pts.length > 1) strokes.push({ points: [...pts], color: currentStroke.color, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
              currentStroke = { points: [], color: drawColor };
            } else if (cursorPos.x >= 0 && cursorPos.x <= 1 && cursorPos.y >= 0 && cursorPos.y <= 1) {
              if (!last || dist > 0.002) {
                currentStroke.points.push({ x: cursorPos.x, y: cursorPos.y });
                currentStroke.color = currentStroke.color || drawColor;
                currentStroke.lineWidth = currentStroke.lineWidth ?? drawLineWidth;
              }
            }
          }
          wasPinching = true;
        } else {
          if (shapeInProgress) {
            const s = shapeInProgress.start, e = shapeInProgress.end;
            let x1 = Math.min(s.x, e.x), x2 = Math.max(s.x, e.x);
            let y1 = Math.min(s.y, e.y), y2 = Math.max(s.y, e.y);
            let w = x2 - x1, h = y2 - y1;
            const diag = Math.hypot(w, h);
            const minSize = 0.03;
            if (diag < minSize) {
              const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
              const half = minSize / 2;
              x1 = cx - half; x2 = cx + half; y1 = cy - half; y2 = cy + half;
              w = minSize; h = minSize;
            }
            {
              const lw = drawLineWidth;
              const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
              if (shapeInProgress.type === "circle") {
                shapes.push({ type: "circle", cx, cy, r: Math.max(diag / 2, minSize / 2), color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "rect") {
                shapes.push({ type: "rect", x: x1, y: y1, w, h, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "line") {
                shapes.push({ type: "line", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "ellipse") {
                shapes.push({ type: "ellipse", x: x1, y: y1, w, h, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "triangle") {
                shapes.push({ type: "triangle", x1: s.x, y1: s.y, x2: e.x, y2: e.y, x3: s.x, y3: e.y, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "arrow") {
                shapes.push({ type: "arrow", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              }
            }
            shapeInProgress = null;
          }
          wasPinching = false;
          fingerLostFrames++;
          if (fingerLostFrames >= 2 && currentStroke.points.length > 0) {
            strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
            currentStroke = { points: [], color: drawColor };
          }
        }
      } else {
        window.drawCursor = null;
        wasPinching = false;
        shapeInProgress = null;
        fingerLostFrames++;
        if (fingerLostFrames >= 2 && currentStroke.points.length > 0) {
          strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
          currentStroke = { points: [], color: drawColor };
        }
      }
    } else {
      window.drawCursor = null;
      updateGestureCursor(0, 0, false);
    }
    drawStrokesToCanvas(w, h);

    if (whiteSheetMode && previewCanvas && stream) {
      const pw = 120, ph = 90;
      if (previewCanvas.width !== pw) previewCanvas.width = pw;
      if (previewCanvas.height !== ph) previewCanvas.height = ph;
      const pctx = previewCanvas.getContext("2d");
      const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
      const scale = Math.min(pw / vw, ph / vh);
      const sw = vw * scale, sh = vh * scale;
      const sx = (pw - sw) / 2, sy = (ph - sh) / 2;
      pctx.fillStyle = "#1a1a1f";
      pctx.fillRect(0, 0, pw, ph);
      pctx.save();
      if (MIRROR_CAMERA) {
        pctx.translate(pw, 0);
        pctx.scale(-1, 1);
        pctx.drawImage(video, sx, sy, sw, sh);
      } else {
        pctx.drawImage(video, sx, sy, sw, sh);
      }
      pctx.restore();
      if (handLandmarks?.length > 0 && showSkeleton) {
        pctx.save();
        pctx.translate(sx, sy);
        pctx.scale(sw / w, sh / h);
        drawHandLandmarks(pctx, handLandmarks, w, h);
        pctx.restore();
      }
    }

    // 6. Göz kapatma hareketi (overlay sadece iskelet açıksa)
    if (showSkeleton) {
    if (window.eyesClosed) {
      eyeOverlay.className = "eye-overlay eyes-closed";
      eyesClosedFrames++;
      eyesOpenFrames = 0;
      if (eyesClosedFrames > 6 && Date.now() - lastEyesClosedReport > DEBOUNCE_MS) {
        reportMotion("Gözünü kapattın");
        lastEyesClosedReport = Date.now();
      }
    } else {
      eyeOverlay.className = "eye-overlay eyes-open";
      eyesOpenFrames++;
      if (eyesClosedFrames > 4 && eyesOpenFrames > 3 && Date.now() - lastEyesOpenReport > DEBOUNCE_MS) {
        reportMotion("Gözünü açtın");
        lastEyesOpenReport = Date.now();
      }
      eyesClosedFrames = 0;
    }
    } else {
      eyeOverlay.className = "eye-overlay";
    }
  } catch (e) {
    console.warn("Detect:", e);
  }

  frameCount++;
  if (performance.now() - lastFpsTime >= 1000) {
    fpsEl.textContent = `${frameCount} FPS`;
    frameCount = 0;
    lastFpsTime = performance.now();
  }
  loopId = requestAnimationFrame(detectLoop);
}

// ========== KAMERA BAŞLAT ==========
async function startCamera() {
  try {
    errorMessage.classList.remove("visible");
    startBtn.disabled = true;
    startBtn.textContent = "Açılıyor...";

    if (window.location.protocol === "file:") {
      throw new Error("FILE_PROTOCOL");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Tarayıcınız kamera desteklemiyor. Chrome veya Firefox kullanın.");
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: VIDEO_WIDTH },
        height: { ideal: VIDEO_HEIGHT },
      },
      audio: false,
    });

    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");

    try {
      await video.play();
    } catch (playErr) {
      throw new Error("Video oynatılamadı. Sayfayı yenileyip tekrar deneyin.");
    }

    // Boyutlar gelene kadar bekle (max 3 sn)
    let wait = 0;
    while ((video.videoWidth === 0 || video.videoHeight === 0) && wait < 60) {
      await new Promise((r) => setTimeout(r, 50));
      wait++;
    }

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    output.width = vw;
    output.height = vh;
    drawCanvas.width = vw;
    drawCanvas.height = vh;

    if (cameraWrapper) {
      cameraWrapper.style.aspectRatio = `${vw} / ${vh}`;
      cameraWrapper.dataset.cameraActive = "1";
    }

    cameraOverlay.classList.add("hidden");
    stopBtn.disabled = false;
    if (modeCameraBtn) modeCameraBtn.disabled = false;
    if (modeWhiteSheetBtn) modeWhiteSheetBtn.disabled = false;
    drawBtn.disabled = false;
    clearDrawBtn.disabled = false;
    objectsBtn.disabled = false;
    addObjBtn.disabled = false;
    removeObjBtn.disabled = false;
    startBtn.textContent = "Kamerayı Başlat";

    lastVideoTime = -1;
    detectLoop();

    // Modelleri arka planda yükle - kamera hemen çalışır
    if (!poseLandmarker) {
      (async () => {
        try {
          const vision = await FilesetResolver.forVisionTasks(WASM);
          poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: POSE_MODEL },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.25,
            minTrackingConfidence: 0.25,
          });
          faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
          });
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.2,
            minHandPresenceConfidence: 0.2,
            minTrackingConfidence: 0.2,
          });
        } catch (modelErr) {
          console.error("Model yükleme:", modelErr);
        }
      })();
    }
  } catch (err) {
    console.error("Kamera hatası:", err);
    startBtn.textContent = "Kamerayı Başlat";
    startBtn.disabled = false;
    let msg = "Kamera erişilemedi. ";
    if (err.message === "FILE_PROTOCOL") {
      msg = "Dosyayı doğrudan açmak (file://) çalışmaz. Terminalde 'python3 -m http.server 8000' yazıp http://localhost:8000 adresine gidin.";
    } else if (err.message?.includes("Tarayıcınız")) {
      msg = err.message;
    } else {
      const s = (err.message || "").toLowerCase();
      if (err.name === "NotAllowedError" || s.includes("permission") || s.includes("denied")) {
        msg = "Kamera izni reddedildi. Adres çubuğundaki kilit/kamera ikonuna tıklayıp 'İzin ver' seçin, sayfayı yenileyin.";
      } else if (err.name === "NotFoundError") {
        msg = "Kamera bulunamadı. Başka bir cihaz deneyin.";
      } else if (err.name === "NotReadableError" || s.includes("not readable")) {
        msg = "Kamera başka bir uygulama tarafından kullanılıyor olabilir. Diğer programları kapatın.";
      } else if (s.includes("overconstrained") || s.includes("constraint")) {
        msg = "Kamera ayarları desteklenmiyor. Farklı bir tarayıcı deneyin.";
      } else {
        msg = "Hata: " + (err.message || err.name || "Bilinmeyen hata");
      }
    }
    errorMessage.textContent = msg;
    errorMessage.classList.add("visible");
    cameraOverlay.classList.remove("hidden");
  }
}

// ========== KAMERA DURDUR ==========
function stopCamera() {
  if (loopId) {
    cancelAnimationFrame(loopId);
    loopId = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  cachedLm = null;
  cachedHandLandmarks = [];
  if (cameraWrapper) {
    cameraWrapper.style.aspectRatio = "";
    delete cameraWrapper.dataset.cameraActive;
  }
  cameraOverlay.classList.remove("hidden");
  eyeOverlay.className = "eye-overlay";
  VIRTUAL_OBJECTS.forEach((o) => {
    o.grabbed = false;
    o.x = o.origX;
    o.y = o.origY;
    o.vx = o.vy = 0;
    o.flying = false;
    o.trail = [];
  });
  lastGrabPos = null;
  grabHistory.length = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (modeCameraBtn) modeCameraBtn.disabled = true;
  if (modeWhiteSheetBtn) modeWhiteSheetBtn.disabled = true;
  drawBtn.disabled = true;
  clearDrawBtn.disabled = true;
  objectsBtn.disabled = true;
  addObjBtn.disabled = true;
  removeObjBtn.disabled = true;
  drawMode = false;
  objectsMode = false;
  drawBtn.classList.remove("active");
  objectsBtn.classList.remove("active");
  objectsBtn.textContent = "🔮 Nesneler Aç";
  strokes = [];
  shapes = [];
  currentStroke = { points: [], color: drawColor };
  const ctx = output.getContext("2d");
  ctx.clearRect(0, 0, output.width, output.height);
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

// ========== EVENT LİSTENERS ==========
const fullscreenBtn = document.getElementById("fullscreenBtn");
const exitFullscreenBtn = document.getElementById("exitFullscreenBtn");
function toggleCanvasFullscreen() {
  const app = document.querySelector(".app");
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  app?.classList.add("canvas-fullscreen");
  document.body.classList.add("canvas-fullscreen");
  document.documentElement.classList.add("canvas-fullscreen");
  document.documentElement.requestFullscreen?.().catch(() => {
    app?.classList.remove("canvas-fullscreen");
    document.body.classList.remove("canvas-fullscreen");
    document.documentElement.classList.remove("canvas-fullscreen");
  });
}
fullscreenBtn?.addEventListener("click", toggleCanvasFullscreen);
exitFullscreenBtn?.addEventListener("click", toggleCanvasFullscreen);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.querySelector(".app.canvas-fullscreen")) toggleCanvasFullscreen();
    else if (document.fullscreenElement) document.exitFullscreen?.();
  }
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    document.querySelector(".app")?.classList.remove("canvas-fullscreen");
    document.body.classList.remove("canvas-fullscreen");
    document.documentElement.classList.remove("canvas-fullscreen");
  }
});

modeCameraBtn?.addEventListener("click", () => {
  whiteSheetMode = false;
  cameraWrapper?.classList.remove("white-sheet-mode");
  modeCameraBtn?.classList.add("active");
  modeWhiteSheetBtn?.classList.remove("active");
});

modeWhiteSheetBtn?.addEventListener("click", () => {
  whiteSheetMode = true;
  cameraWrapper?.classList.add("white-sheet-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.add("active");
});

showSkeletonCheck.addEventListener("change", () => {
  showSkeleton = showSkeletonCheck.checked;
});

toolbarTrigger?.addEventListener("click", () => {
  drawToolbar?.classList.toggle("expanded");
});

toolbarColor?.addEventListener("input", () => {
  drawColor = toolbarColor.value;
  currentStroke.color = drawColor;
  document.querySelectorAll(".color-preset").forEach((b) => b.classList.remove("active"));
});

toolbarSize?.addEventListener("input", () => {
  drawLineWidth = parseInt(toolbarSize.value, 10);
  if (toolbarSizeVal) toolbarSizeVal.textContent = drawLineWidth;
});

document.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".shape-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    drawShape = btn.dataset.shape || "free";
  });
});

document.querySelectorAll(".color-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const c = btn.dataset.color || "#00ff9f";
    drawColor = c;
    currentStroke.color = c;
    document.querySelectorAll(".color-preset").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (toolbarColor) toolbarColor.value = c;
  });
});

document.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    let v = parseInt(toolbarSize?.value || "4", 10) + parseInt(btn.dataset.delta || "0", 10);
    v = Math.max(1, Math.min(20, v));
    drawLineWidth = v;
    if (toolbarSize) toolbarSize.value = v;
    if (toolbarSizeVal) toolbarSizeVal.textContent = v;
  });
});

if (toolbarSizeVal) toolbarSizeVal.textContent = drawLineWidth;
if (toolbarColor) toolbarColor.value = drawColor;
document.querySelectorAll(".color-preset").forEach((b) => {
  b.classList.toggle("active", (b.dataset.color || "").toLowerCase() === drawColor.toLowerCase());
});

drawBtn.addEventListener("click", () => {
  drawMode = !drawMode;
  drawBtn.classList.toggle("active", drawMode);
  if (drawMode) drawToolbar?.classList.add("expanded");
  if (!drawMode && currentStroke.points.length > 0) {
    strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
    currentStroke = { points: [], color: drawColor };
  }
});

clearDrawBtn.addEventListener("click", () => {
  strokes = [];
  shapes = [];
  currentStroke = { points: [], color: drawColor };
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
});

objectsBtn.addEventListener("click", () => {
  objectsMode = !objectsMode;
  objectsBtn.classList.toggle("active", objectsMode);
  objectsBtn.textContent = objectsMode ? "🔮 Nesneler Kapat" : "🔮 Nesneler Aç";
});

addObjBtn.addEventListener("click", () => {
  const x = 0.2 + Math.random() * 0.6;
  const y = 0.25 + Math.random() * 0.4;
  VIRTUAL_OBJECTS.push(createObject(x, y));
});

removeObjBtn.addEventListener("click", () => {
  if (VIRTUAL_OBJECTS.length > 0) {
    const last = VIRTUAL_OBJECTS.pop();
    if (last?.grabbed) lastGrabPos = null;
  }
});

startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);
