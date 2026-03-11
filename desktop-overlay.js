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
let wasToolbarPinch = false;
let wasTwoFingersClick = false;
let shapeInProgress = null;

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
  return distIdx > 0.06 && distMid < 0.18 && distRing < 0.18 && distPinky < 0.18;
}

function isIndexThumbPinch(hand) {
  if (!hand || hand.length < 9) return false;
  const idxTip = hand[8], thumbTip = hand[4];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (d(idxTip, thumbTip) >= 0.06) return false;
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

// ТОЛЬКО полностью выпрямленные указательный и средний (ластик)
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
  const minExtended = 0.07;
  const tipToPipIdx = d(idxTip, idxPip);
  const tipToPipMid = d(midTip, midPip);
  return lenIdx >= minExtended && lenMid >= minExtended &&
         tipToPipIdx > 0.03 && tipToPipMid > 0.03 &&
         lenIdx > lenRing * 1.2 && lenMid > lenRing * 1.2 &&
         lenIdx > lenPinky * 1.2 && lenMid > lenPinky * 1.2 &&
         distIdxMid > 0.04 && distIdxMid < 0.15;
}

function getTwoFingerPosition(hand) {
  if (!hand || hand.length < 13 || !isTwoFingersExtended(hand)) return null;
  const idx = hand[8], mid = hand[12];
  return { x: (idx.x + mid.x) / 2, y: (idx.y + mid.y) / 2 };
}

function getThumbIndexSize(hand) {
  if (!hand || hand.length < 9) return null;
  const thumb = hand[4], idx = hand[8];
  const dx = idx.x - thumb.x, dy = idx.y - thumb.y;
  const dist = Math.hypot(dx, dy);
  return { center: { x: (thumb.x + idx.x) / 2, y: (thumb.y + idx.y) / 2 }, size: dist, dx, dy };
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
      } else seg.push(pt);
    }
    if (seg.length > 1) segments.push({ points: seg, color, lineWidth: lw });
    segments.forEach((s) => newStrokes.push(s));
  }
  strokes = newStrokes;
}

function drawStrokesToCanvas(w, h) {
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, w, h);
  const sx = (x) => (MIRROR_CAMERA ? (1 - x) * w : x * w);
  const defLw = drawLineWidth || 4;

  shapes.forEach((sh) => {
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
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

  if (shapeInProgress) {
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
    if (sp.type === "circle") {
      dctx.beginPath();
      dctx.arc(cx, cy, Math.max(rad, 4), 0, Math.PI * 2);
      dctx.stroke();
    } else if (sp.type === "rect" || sp.type === "ellipse") {
      dctx.beginPath();
      dctx.arc(startPx, startPy, 6, 0, Math.PI * 2);
      dctx.fillStyle = drawColor;
      dctx.globalAlpha = 0.5;
      dctx.fill();
      dctx.globalAlpha = 1;
      dctx.stroke();
      if (sp.type === "rect") dctx.strokeRect(px1, py1, rw, rh);
      else { dctx.beginPath(); dctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2); dctx.stroke(); }
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
    shapeInProgress = null;
    currentStroke = { points: [], color: drawColor };
    if (!wasTwoFingersClick) {
      wasTwoFingersClick = true;
      simulateClickAtPosition(twoFingerPos.x, twoFingerPos.y, w, h);
    }
    window.drawCursor = null;
  } else if (cursorPos) {
    wasTwoFingersClick = false;
    window.drawCursor = cursorPos;
    const overToolbar = MIRROR_CAMERA ? cursorPos.x > 0.88 : cursorPos.x < 0.12;
    const isPinch = handLandmarks[handIdx] && isIndexThumbPinch(handLandmarks[handIdx]);
    const tiCenter = handLandmarks[handIdx] && getThumbIndexSize(handLandmarks[handIdx])?.center;
    const pinchPos = tiCenter && tiCenter.x >= 0 && tiCenter.x <= 1 && tiCenter.y >= 0 && tiCenter.y <= 1 ? tiCenter : cursorPos;
    if (isPinch && overToolbar) {
      if (!wasToolbarPinch) { wasToolbarPinch = true; simulateClickAtPosition(cursorPos.x, cursorPos.y, w, h); }
    } else { wasToolbarPinch = false; }
    if (isPinch && !overToolbar) {
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
    wasToolbarPinch = false;
    shapeInProgress = null;
    wasTwoFingersClick = false;
    fingerLostFrames++;
    if (fingerLostFrames >= 2 && currentStroke.points.length > 0) {
      strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
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
