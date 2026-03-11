/**
 * Masaüstü overlay - el hareketi ile çizim
 */
import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";

const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const MIRROR_CAMERA = true;

const video = document.getElementById("video");
const drawCanvas = document.getElementById("drawCanvas");
const previewCanvas = document.getElementById("previewCanvas");
const cameraPreview = document.getElementById("cameraPreview");

let handLandmarker = null;
let stream = null;
let loopId = null;
let lastVideoTime = -1;

let drawColor = "#00ff9f";
let drawLineWidth = 4;
let drawShape = "free";
let strokes = [];
let shapes = [];
let currentStroke = { points: [], color: "#00ff9f" };
let fingerLostFrames = 0;
let wasPinching = false;
let wasTwoFingersClick = false;

function toPx(p, w, h) {
  const x = MIRROR_CAMERA ? (1 - p.x) * w : p.x * w;
  return { x, y: p.y * h };
}

function isOnlyIndexThumbExtended(hand) {
  if (!hand || hand.length < 21) return false;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wrist = hand[0];
  const idxTip = hand[8], midTip = hand[12], ringTip = hand[16], pinkyTip = hand[20];
  const distIdx = d(idxTip, wrist), distMid = d(midTip, wrist), distRing = d(ringTip, wrist), distPinky = d(pinkyTip, wrist);
  return distIdx > 0.08 && distMid < 0.16 && distRing < 0.16 && distPinky < 0.16;
}

function isIndexThumbPinch(hand) {
  if (!hand || hand.length < 9) return false;
  const idxTip = hand[8], thumbTip = hand[4];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (d(idxTip, thumbTip) >= 0.04) return false;
  return isOnlyIndexThumbExtended(hand);
}

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

function getPinchCursorPosition(hand) {
  if (!hand || hand.length < 9) return null;
  const idxTip = hand[8];
  if (isIndexThumbPinch(hand)) return { x: idxTip.x, y: idxTip.y };
  if (isIndexFingerExtended(hand) && isOnlyIndexThumbExtended(hand)) return { x: idxTip.x, y: idxTip.y };
  return null;
}

function isTwoFingersExtended(hand) {
  if (!hand || hand.length < 21) return false;
  const idxTip = hand[8], midTip = hand[12], ringTip = hand[16], pinkyTip = hand[20];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lenIdx = d(idxTip, hand[5]);
  const lenMid = d(midTip, hand[9]);
  const lenRing = d(ringTip, hand[13]);
  const lenPinky = d(pinkyTip, hand[17]);
  const distIdxMid = d(idxTip, midTip);
  return lenIdx > 0.05 && lenMid > 0.05 &&
         lenIdx > lenRing * 0.9 && lenMid > lenRing * 0.9 &&
         lenIdx > lenPinky * 0.9 && lenMid > lenPinky * 0.9 &&
         distIdxMid > 0.04 && distIdxMid < 0.15;
}

function getTwoFingerPosition(hand) {
  if (!hand || hand.length < 13 || !isTwoFingersExtended(hand)) return null;
  const idx = hand[8], mid = hand[12];
  return { x: (idx.x + mid.x) / 2, y: (idx.y + mid.y) / 2 };
}

function simulateClickAtPosition(normX, normY, w, h) {
  const x = MIRROR_CAMERA ? (1 - normX) * w : normX * w;
  const y = normY * h;
  const el = document.elementFromPoint(x, y);
  if (el) {
    ["mousedown", "mouseup", "click"].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mousedown" ? 1 : 0 }));
    });
  }
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function eraseAtPosition(eraseX, eraseY, radius = 0.07) {
  const r2 = radius * radius;
  shapes = shapes.filter((sh) => {
    let dx, dy;
    if (sh.type === "circle") { dx = sh.cx - eraseX; dy = sh.cy - eraseY; }
    else if (sh.type === "rect") { dx = sh.x - eraseX; dy = sh.y - eraseY; }
    else if (sh.type === "line") { dx = (sh.x1 + sh.x2) / 2 - eraseX; dy = (sh.y1 + sh.y2) / 2 - eraseY; }
    else return true;
    return dx * dx + dy * dy > r2;
  });
  const newStrokes = [];
  for (const stroke of strokes) {
    const pts = stroke.points || stroke;
    const color = stroke.color || drawColor;
    const segments = [];
    let seg = [];
    for (const pt of pts) {
      const d2 = (pt.x - eraseX) ** 2 + (pt.y - eraseY) ** 2;
      if (d2 < r2) {
        if (seg.length > 1) segments.push({ points: seg, color });
        seg = [];
      } else seg.push(pt);
    }
    if (seg.length > 1) segments.push({ points: seg, color });
    segments.forEach((s) => newStrokes.push(s));
  }
  strokes = newStrokes;
}

function drawStrokesToCanvas(w, h) {
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, w, h);
  const sx = (x) => (MIRROR_CAMERA ? (1 - x) * w : x * w);
  const lw = drawLineWidth || 4;
  const lwGlow = Math.max(lw * 4, 18);
  const lwMid = Math.max(lw * 2, 10);

  shapes.forEach((sh) => {
    const color = sh.color || drawColor;
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
      dctx.strokeRect(x - rw / 2, y - rh / 2, rw, rh);
    } else if (sh.type === "line") {
      dctx.beginPath();
      dctx.moveTo(sx(sh.x1), sh.y1 * h);
      dctx.lineTo(sx(sh.x2), sh.y2 * h);
      dctx.stroke();
    }
  });

  const allStrokes = [...strokes, currentStroke.points.length > 0 ? currentStroke : null].filter(Boolean);
  allStrokes.forEach((stroke) => {
    const pts = stroke.points || stroke;
    const color = stroke.color || drawColor;
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

  if (window.drawCursor) {
    const cx = sx(window.drawCursor.x);
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
}

function resizeCanvas() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
}

function detectLoop() {
  if (!stream || !video.srcObject) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  if (video.readyState < 2) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  const w = drawCanvas.width;
  const h = drawCanvas.height;
  const t = performance.now();
  if (t <= lastVideoTime) {
    loopId = requestAnimationFrame(detectLoop);
    return;
  }
  lastVideoTime = t;

  let handLandmarks = [];
  if (handLandmarker) {
    try {
      const handRes = handLandmarker.detectForVideo(video, t);
      handLandmarks = handRes.landmarks || [];
    } catch (_) {}
  }

  let cursorPos = null;
  let twoFingerPos = null;
  let handIdx = -1;
  for (let i = 0; i < handLandmarks.length; i++) {
    cursorPos = getPinchCursorPosition(handLandmarks[i]);
    if (cursorPos) { handIdx = i; break; }
  }
  if (!cursorPos) {
    for (let i = 0; i < handLandmarks.length; i++) {
      twoFingerPos = getTwoFingerPosition(handLandmarks[i]);
      if (twoFingerPos) break;
    }
  }

  if (twoFingerPos && !cursorPos) {
    fingerLostFrames = 0;
    wasPinching = false;
    currentStroke = { points: [], color: drawColor };
    if (!wasTwoFingersClick) {
      wasTwoFingersClick = true;
      simulateClickAtPosition(twoFingerPos.x, twoFingerPos.y, w, h);
    }
    window.drawCursor = null;
  } else if (cursorPos) {
    wasTwoFingersClick = false;
    window.drawCursor = cursorPos;
    const isPinch = handLandmarks[handIdx] && isIndexThumbPinch(handLandmarks[handIdx]);
    if (isPinch) {
      fingerLostFrames = 0;
      if (drawShape === "circle" || drawShape === "rect" || drawShape === "line") {
        if (!wasPinching && cursorPos.x >= 0 && cursorPos.x <= 1 && cursorPos.y >= 0 && cursorPos.y <= 1) {
          const cx = cursorPos.x, cy = cursorPos.y;
          if (drawShape === "circle") shapes.push({ type: "circle", cx, cy, r: 0.04, color: drawColor });
          else if (drawShape === "rect") shapes.push({ type: "rect", x: cx, y: cy, w: 0.1, h: 0.06, color: drawColor });
          else if (drawShape === "line") shapes.push({ type: "line", x1: cx - 0.04, y1: cy, x2: cx + 0.04, y2: cy, color: drawColor });
        }
      } else {
        const pts = currentStroke.points;
        const last = pts[pts.length - 1];
        const dx = last ? cursorPos.x - last.x : 0;
        const dy = last ? cursorPos.y - last.y : 0;
        const dist = Math.hypot(dx, dy);
        const maxJump = 0.15;
        if (dist > maxJump && last) {
          if (pts.length > 1) strokes.push({ points: [...pts], color: currentStroke.color });
          currentStroke = { points: [], color: drawColor };
        } else if (cursorPos.x >= 0 && cursorPos.x <= 1 && cursorPos.y >= 0 && cursorPos.y <= 1) {
          if (!last || dist > 0.002) {
            currentStroke.points.push({ x: cursorPos.x, y: cursorPos.y });
            currentStroke.color = currentStroke.color || drawColor;
          }
        }
      }
      wasPinching = true;
    } else {
      wasPinching = false;
      fingerLostFrames++;
      if (fingerLostFrames >= 2 && currentStroke.points.length > 0) {
        strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor });
        currentStroke = { points: [], color: drawColor };
      }
    }
  } else {
    window.drawCursor = null;
    wasPinching = false;
    wasTwoFingersClick = false;
    fingerLostFrames++;
    if (fingerLostFrames >= 2 && currentStroke.points.length > 0) {
      strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor });
      currentStroke = { points: [], color: drawColor };
    }
  }

  drawStrokesToCanvas(w, h);

  if (previewCanvas && video.videoWidth > 0) {
    const pw = 100, ph = 75;
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
  }

  loopId = requestAnimationFrame(detectLoop);
}

async function init() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    video.srcObject = stream;
    await video.play();

    let wait = 0;
    while ((video.videoWidth === 0 || video.videoHeight === 0) && wait < 60) {
      await new Promise((r) => setTimeout(r, 50));
      wait++;
    }

    const vision = await FilesetResolver.forVisionTasks(WASM);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.2,
      minHandPresenceConfidence: 0.2,
      minTrackingConfidence: 0.2,
    });

    previewCanvas.width = 100;
    previewCanvas.height = 75;

    lastVideoTime = -1;
    detectLoop();
  } catch (err) {
    console.error("Kamera hatası:", err);
    alert("Kamera başlatılamadı. Lütfen izin verin.");
  }

  document.getElementById("toolbarToggle").addEventListener("click", () => {
    document.getElementById("toolbar").classList.toggle("expanded");
  });

  document.getElementById("toolbarColor").addEventListener("input", (e) => {
    drawColor = e.target.value;
  });

  document.getElementById("toolbarSize").addEventListener("input", (e) => {
    drawLineWidth = parseInt(e.target.value, 10);
    document.getElementById("toolbarSizeVal").textContent = drawLineWidth;
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    strokes = [];
    shapes = [];
    currentStroke = { points: [], color: drawColor };
  });

  document.querySelectorAll(".shape-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".shape-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      drawShape = btn.dataset.shape || "free";
    });
  });
}

init();
