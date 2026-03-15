/**
 * Система отслеживания движений в реальном времени
 * MediaPipe Tasks Vision — камера, руки, поза, лицо, рисование
 */

import {
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.mjs";

import { supabase, getShareBaseUrl } from "./supabase-config.js";
import { uploadPdfToSupabase } from "./supabase-pdf.js";
import { savePageStrokes, deleteStrokesForPage, fetchStrokes, subscribeStrokes } from "./supabase-strokes.js";

let PPTXViewer = null;
(async () => {
  const urls = [
    "https://esm.run/pptxviewjs@1.1.8",
    "https://cdn.jsdelivr.net/npm/pptxviewjs@1.1.8/+esm"
  ];
  for (const url of urls) {
    try {
      const m = await import(url);
      PPTXViewer = m.PPTXViewer ?? m.default?.PPTXViewer ?? m.default;
      if (PPTXViewer) break;
    } catch (e) {
      console.warn("PPTX load failed from", url, e);
    }
  }
})();

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

const MIN_VIS = 0.15;
const MIRROR_CAMERA = true;

const PERFORMANCE_MODE = true;
const DETECT_EVERY_N_FRAMES = PERFORMANCE_MODE ? 2 : 1;
const VIDEO_WIDTH = PERFORMANCE_MODE ? 1280 : 1920;
const VIDEO_HEIGHT = PERFORMANCE_MODE ? 720 : 1080;

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
const fpsEl = document.getElementById("fps");
const modeToggle = document.getElementById("modeToggle");
const modeCameraBtn = document.getElementById("modeCameraBtn");
const modeWhiteSheetBtn = document.getElementById("modeWhiteSheetBtn");
const modeBlackSheetBtn = document.getElementById("modeBlackSheetBtn");
const modePdfBtn = document.getElementById("modePdfBtn");
const modePptxBtn = document.getElementById("modePptxBtn");
const cameraWrapper = document.getElementById("cameraWrapper");
const previewCanvas = document.getElementById("previewCanvas");
const pdfContainer = document.getElementById("pdfContainer");
const pdfCanvas = document.getElementById("pdfCanvas");
const pdfDrawCanvas = document.getElementById("pdfDrawCanvas");
const pdfPageWrap = document.getElementById("pdfPageWrap");
const pdfFileInput = document.getElementById("pdfFileInput");
const pdfUploadZone = document.getElementById("pdfUploadZone");
const pdfUploadGroup = document.getElementById("pdfUploadGroup");
const pdfOverlay = document.getElementById("pdfOverlay");
const pdfPrevBtn = document.getElementById("pdfPrevBtn");
const pdfNextBtn = document.getElementById("pdfNextBtn");
const pdfPageInfo = document.getElementById("pdfPageInfo");
const pdfClearBtn = document.getElementById("pdfClearBtn");
const pdfCopyLinkBtn = document.getElementById("pdfCopyLinkBtn");
const canvasShareGroup = document.getElementById("canvasShareGroup");
const canvasShareBtn = document.getElementById("canvasShareBtn");
const canvasCopyLinkBtn = document.getElementById("canvasCopyLinkBtn");
const shareUrlRow = document.getElementById("shareUrlRow");
const shareUrlInput = document.getElementById("shareUrlInput");
const shareUrlSaveBtn = document.getElementById("shareUrlSaveBtn");
const pptxContainer = document.getElementById("pptxContainer");
const pptxCanvas = document.getElementById("pptxCanvas");
const pptxDrawCanvas = document.getElementById("pptxDrawCanvas");
const pptxSlideWrap = document.getElementById("pptxSlideWrap");
const pptxFileInput = document.getElementById("pptxFileInput");
const pptxUploadZone = document.getElementById("pptxUploadZone");
const pptxUploadGroup = document.getElementById("pptxUploadGroup");
const pptxOverlay = document.getElementById("pptxOverlay");
const pptxPrevBtn = document.getElementById("pptxPrevBtn");
const pptxNextBtn = document.getElementById("pptxNextBtn");
const pptxPageInfo = document.getElementById("pptxPageInfo");
const pptxClearBtn = document.getElementById("pptxClearBtn");

// State
let poseLandmarker = null;
let faceLandmarker = null;
let handLandmarker = null;
let stream = null;
let loopId = null;
let lastVideoTime = -1;
let frameCount = 0;
let lastFpsTime = performance.now();
let eyesClosedFrames = 0;
let eyesOpenFrames = 0;
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
let blackSheetMode = false;
let wasToolbarPinch = false;
let shapeInProgress = null;
let smoothedCursor = null;
let smoothedPinch = null;
let smoothedErasePos = null;
const CURSOR_SMOOTH = 0.45;
const ERASE_SMOOTH = 0.5;
const GESTURE_LOCK_FRAMES = 3;
let framesSinceDraw = 999;
let framesSinceErase = 999;

const GESTURE_STATE = { IDLE: "idle", DRAWING: "drawing", ERASING: "erasing" };
let gestureState = GESTURE_STATE.IDLE;
let smoothedThumbIndexDist = 0.2;
let pinchReleaseFrames = 0;
let twoFingerHeldFrames = 0;
const PINCH_START_THRESHOLD = 0.07;
const PINCH_RELEASE_THRESHOLD = 0.1;
const PINCH_RELEASE_FRAMES = 4;
const DIST_SMOOTH_ALPHA = 0.6;
const FINGER_LOST_THRESHOLD = 6;
const MIN_STROKE_DIST = 0.002;
let cachedLm = null;
let cachedEyesClosed = false;
let cachedHandLandmarks = [];
let preferredHand = (localStorage.getItem("preferredHand") || "right").toLowerCase(); // "left" | "right"
let lastStrokesVersion = 0;
let strokesVersion = 0;

// PDF state
let pdfMode = false;
let pdfDoc = null;
let pdfPageNum = 1;
let pdfTotalPages = 0;
let pdfStrokes = [];
let pdfShapes = [];
let pdfStrokesByPage = {};
let pdfShapesByPage = {};
let pdfCurrentStroke = { points: [], color: "#00ff9f" };
let pdfZoomScale = 1;
let pdfIsDrawing = false;
let currentPdfShareToken = null;
let currentCanvasShareToken = null;
let canvasRealtimeUnsubscribe = null;
let pdfRealtimeUnsubscribe = null;
let pdfRealtimeBroadcast = null;
let pdfRealtimeBroadcastProgress = null;
let pdfRemoteCurrentStroke = null;
let lastGestureBroadcastProgress = 0;
let lastEraseSaveTime = 0;
let lastEraseEndTime = 0;

// PPTX state
let pptxMode = false;
let pptxViewer = null;
let pptxPageNum = 1;
let pptxTotalPages = 0;
let pptxStrokes = [];
let pptxShapes = [];
let pptxStrokesByPage = {};
let pptxShapesByPage = {};
let pptxCurrentStroke = { points: [], color: "#00ff9f" };
let pptxIsDrawing = false;
let pptxAspectRatio = 16 / 9;

const OBJECT_COLORS = ["#00ff9f", "#ff6b9d", "#6b9dff", "#ffd93d", "#6bcb77", "#4d96ff"];
let objectIdCounter = 0;

function cloneStroke(stroke) {
  if (!stroke) return stroke;
  const points = Array.isArray(stroke.points) ? stroke.points.map((p) => ({ x: p.x, y: p.y })) : [];
  return { ...stroke, points };
}

function cloneShape(shape) {
  return shape ? { ...shape } : shape;
}

function clonePageLayer(strokesArr = [], shapesArr = []) {
  return {
    strokes: strokesArr.map(cloneStroke),
    shapes: shapesArr.map(cloneShape)
  };
}

function savePdfPageState() {
  if (!pdfDoc) return;
  const pageLayer = clonePageLayer(pdfStrokes, pdfShapes);
  if (pdfCurrentStroke.points.length > 1) pageLayer.strokes.push(cloneStroke(pdfCurrentStroke));
  pdfStrokesByPage[pdfPageNum] = pageLayer;
}

async function savePdfStrokesAndBroadcast(pageNum, strokes, skipBroadcast = false) {
  if (!currentPdfShareToken) return;
  const ok = await savePageStrokes(currentPdfShareToken, pageNum, strokes);
  if (ok && pdfRealtimeBroadcast && !skipBroadcast) pdfRealtimeBroadcast(pageNum, strokes);
}

function loadPdfPageState() {
  const saved = pdfStrokesByPage[pdfPageNum];
  pdfStrokes = saved ? (saved.strokes || []).map(cloneStroke) : [];
  pdfShapes = saved ? (saved.shapes || []).map(cloneShape) : [];
  pdfCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
}

function savePptxPageState() {
  if (!pptxViewer) return;
  const pageLayer = clonePageLayer(pptxStrokes, pptxShapes);
  if (pptxCurrentStroke.points.length > 1) pageLayer.strokes.push(cloneStroke(pptxCurrentStroke));
  pptxStrokesByPage[pptxPageNum] = pageLayer;
}

function syncCurrentDocumentPageState() {
  if (pdfMode && pdfDoc) {
    pdfStrokesByPage[pdfPageNum] = clonePageLayer(pdfStrokes, pdfShapes);
  } else if (pptxMode && pptxViewer) {
    pptxStrokesByPage[pptxPageNum] = clonePageLayer(pptxStrokes, pptxShapes);
  }
}

function loadPptxPageState() {
  const saved = pptxStrokesByPage[pptxPageNum];
  pptxStrokes = saved ? (saved.strokes || []).map(cloneStroke) : [];
  pptxShapes = saved ? (saved.shapes || []).map(cloneShape) : [];
  pptxCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
}

function eraseLayerAtPosition(strokesArr, shapesArr, eraseX, eraseY, radius = 0.07) {
  const r2 = radius * radius;
  const nextShapes = shapesArr.filter((sh) => {
    let dx, dy;
    if (sh.type === "circle") { dx = sh.cx - eraseX; dy = sh.cy - eraseY; }
    else if (sh.type === "rect" || sh.type === "ellipse") { dx = (sh.x + sh.w / 2) - eraseX; dy = (sh.y + sh.h / 2) - eraseY; }
    else if (sh.type === "line" || sh.type === "arrow") { dx = (sh.x1 + sh.x2) / 2 - eraseX; dy = (sh.y1 + sh.y2) / 2 - eraseY; }
    else if (sh.type === "triangle") { dx = (sh.x1 + sh.x2 + sh.x3) / 3 - eraseX; dy = (sh.y1 + sh.y2 + sh.y3) / 3 - eraseY; }
    else return true;
    return dx * dx + dy * dy > r2;
  });
  const nextStrokes = [];
  for (const stroke of strokesArr) {
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
    for (const s of segments) nextStrokes.push({ points: s.points, color: s.color, lineWidth: s.lineWidth });
  }
  return { strokes: nextStrokes, shapes: nextShapes };
}

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
    hand.forEach((p, i) => {
      if (!p) return;
      const pt = toPx(p, w, h);
      const isTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = getFingerColor(i);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isTip ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

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
  const minExtended = 0.04;
  const minVGap = 0.05;
  const tipToPipIdx = d(idxTip, idxPip);
  const tipToPipMid = d(midTip, midPip);
  return lenIdx >= minExtended && lenMid >= minExtended &&
         tipToPipIdx > 0.02 && tipToPipMid > 0.02 &&
         lenIdx > lenRing * 1.05 && lenMid > lenRing * 1.05 &&
         lenIdx > lenPinky * 1.05 && lenMid > lenPinky * 1.05 &&
         distIdxMid > minVGap && distIdxMid < 0.32;
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
  const rect = (pdfMode && pdfDrawCanvas)
    ? pdfDrawCanvas.getBoundingClientRect()
    : (pptxMode && pptxDrawCanvas)
      ? pptxDrawCanvas.getBoundingClientRect()
      : output.getBoundingClientRect();
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
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
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
  ctx.fillStyle = "#00ff9f";
  lm.forEach((p) => {
    if ((p?.visibility ?? 1) > MIN_VIS) {
      const pt = toPx(p, w, h);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
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

// Thumb-index distance (for hysteresis)
function getThumbIndexDistance(hand) {
  if (!hand || hand.length < 9) return Infinity;
  const idxTip = hand[8], thumbTip = hand[4];
  return Math.hypot(idxTip.x - thumbTip.x, idxTip.y - thumbTip.y);
}

// Legacy pinch check (toolbar etc.) — uses raw threshold
function isIndexThumbPinch(hand) {
  return getThumbIndexDistance(hand) < PINCH_START_THRESHOLD;
}

function getPinchCursorPosition(hand) {
  if (!hand || hand.length < 9) return null;
  if (isTwoFingersExtended(hand)) return null;
  const idxTip = hand[8];
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
        if (nearest) {
          nearest.grabbed = true;
          nearest.x = gx;
          nearest.y = gy;
          nearest.flying = false;
          nearest.vx = 0;
          nearest.vy = 0;
          lastGrabPos = { x: gx, y: gy };
          grabHistory.length = 0;
          grabHistory.push({ x: gx, y: gy });
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

/** Stroke noktalarına hafif yumuşatma — çizim daha düzgün görünsün */
function smoothStrokePoints(pts, alpha = 0.25) {
  if (!pts || pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) { out.push({ x: pts[i].x, y: pts[i].y }); continue; }
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1];
    out.push({
      x: (1 - alpha) * curr.x + (alpha / 2) * (prev.x + next.x),
      y: (1 - alpha) * curr.y + (alpha / 2) * (prev.y + next.y)
    });
  }
  return out;
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
  dctx.lineCap = "round";
  dctx.lineJoin = "round";
  allStrokes.forEach((stroke) => {
    const rawPts = stroke.points || stroke;
    const pts = smoothStrokePoints(rawPts);
    const color = stroke.color || drawColor;
    const lw = stroke.lineWidth ?? defLw;
    if (pts.length < 2) return;
    dctx.beginPath();
    dctx.moveTo(sx(pts[0].x), pts[0].y * h);
    for (let i = 1; i < pts.length; i++) dctx.lineTo(sx(pts[i].x), pts[i].y * h);
    dctx.strokeStyle = hexToRgba(color, 0.25);
    dctx.lineWidth = Math.max(lw * 2.5, 12);
    dctx.stroke();
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
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
  const next = eraseLayerAtPosition(strokes, shapes, eraseX, eraseY, radius);
  strokes = next.strokes;
  shapes = next.shapes;
}

function toDocNormX(x) {
  return MIRROR_CAMERA ? (1 - x) : x;
}

function drawCursorDot(ctx, w, h, useDocX = false) {
  if (!window.drawCursor || !drawMode) return;
  const normX = useDocX ? toDocNormX(window.drawCursor.x) : window.drawCursor.x;
  const cx = normX * w;
  const cy = window.drawCursor.y * h;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.shadowColor = drawColor;
  ctx.shadowBlur = 6;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = drawColor;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function updateDocumentOverlays() {
  if (pdfOverlay) pdfOverlay.style.display = (pdfMode && !pdfDoc) ? "flex" : "none";
  if (pptxOverlay) pptxOverlay.style.display = (pptxMode && !pptxViewer) ? "flex" : "none";
}

function isCanvasFullscreenMode() {
  const app = document.querySelector(".app");
  return !!document.fullscreenElement && document.fullscreenElement === app;
}

function setWrapperAspect(width, height) {
  if (!cameraWrapper) return;
  if (!width || !height) return;
  if (isCanvasFullscreenMode()) {
    cameraWrapper.style.aspectRatio = "";
    return;
  }
  cameraWrapper.style.aspectRatio = `${width} / ${height}`;
}

function restoreCameraAspect() {
  if (!cameraWrapper) return;
  const w = output?.width || video?.videoWidth || 0;
  const h = output?.height || video?.videoHeight || 0;
  if (w > 0 && h > 0) cameraWrapper.style.aspectRatio = `${w} / ${h}`;
}

// ========== PDF РЕЖИМ ==========
async function renderPdfPage(retry = 0) {
  if (!pdfDoc || !pdfCanvas || !pdfDrawCanvas || !pdfPageWrap) return;
  const page = await pdfDoc.getPage(pdfPageNum);
  const container = pdfContainer;
  let maxW = container.clientWidth || 0;
  let maxH = container.clientHeight || 0;
  if ((maxW <= 0 || maxH <= 0) && retry < 10) {
    requestAnimationFrame(() => renderPdfPage(retry + 1));
    return;
  }
  maxW = maxW || 800;
  maxH = maxH || 600;
  const viewport = page.getViewport({ scale: 1 });
  const fitW = maxW / viewport.width;
  const fitH = maxH / viewport.height;
  const isPortraitPage = viewport.height > viewport.width;
  const baseScale = isCanvasFullscreenMode()
    ? Math.max(0.1, Math.min(fitW, fitH))
    : Math.max(0.1, isPortraitPage ? Math.min(fitW, fitH) : fitW);
  const scale = baseScale * pdfZoomScale;
  const scaledViewport = page.getViewport({ scale });
  const w = Math.floor(scaledViewport.width);
  const h = Math.floor(scaledViewport.height);
  setWrapperAspect(w, h);
  pdfCanvas.width = w;
  pdfCanvas.height = h;
  pdfDrawCanvas.width = w;
  pdfDrawCanvas.height = h;
  const ctx = pdfCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  await page.render({
    canvasContext: ctx,
    viewport: scaledViewport,
  }).promise;
  pdfDrawCanvas.width = pdfDrawCanvas.width;
  drawStrokesToPdfCanvas(w, h);
}

function drawStrokesToPdfCanvas(w, h) {
  if (!pdfDrawCanvas) return;
  const dctx = pdfDrawCanvas.getContext("2d");
  dctx.clearRect(0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
  const defLw = drawLineWidth || 4;
  pdfShapes.forEach((sh) => {
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      dctx.beginPath();
      dctx.arc(sh.cx * w, sh.cy * h, sh.r * Math.min(w, h), 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "rect") {
      dctx.strokeRect(sh.x * w, sh.y * h, sh.w * w, sh.h * h);
    } else if (sh.type === "line") {
      dctx.beginPath();
      dctx.moveTo(sh.x1 * w, sh.y1 * h);
      dctx.lineTo(sh.x2 * w, sh.y2 * h);
      dctx.stroke();
    } else if (sh.type === "ellipse") {
      const cx = (sh.x + sh.w / 2) * w, cy = (sh.y + sh.h / 2) * h;
      const rx = (sh.w / 2) * w, ry = (sh.h / 2) * h;
      dctx.beginPath();
      dctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "arrow") {
      const x1 = sh.x1 * w, y1 = sh.y1 * h, x2 = sh.x2 * w, y2 = sh.y2 * h;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const arrowLen = Math.min(len * 0.3, 20);
      dctx.beginPath();
      dctx.moveTo(x1, y1);
      dctx.lineTo(x2, y2);
      dctx.moveTo(x2 - ux * arrowLen + uy * arrowLen * 0.4, y2 - uy * arrowLen - ux * arrowLen * 0.4);
      dctx.lineTo(x2, y2);
      dctx.lineTo(x2 - ux * arrowLen - uy * arrowLen * 0.4, y2 - uy * arrowLen + ux * arrowLen * 0.4);
      dctx.stroke();
    }
  });
  const allStrokes = [...pdfStrokes, pdfCurrentStroke.points.length > 0 ? pdfCurrentStroke : null].filter(Boolean);
  allStrokes.forEach((stroke) => {
    const rawPts = stroke.points || stroke;
    const pts = smoothStrokePoints(rawPts);
    const color = stroke.color || drawColor;
    const lw = stroke.lineWidth ?? defLw;
    if (pts.length < 2) return;
    dctx.beginPath();
    dctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) dctx.lineTo(pts[i].x * w, pts[i].y * h);
    dctx.strokeStyle = hexToRgba(color, 0.25);
    dctx.lineWidth = Math.max(lw * 2.5, 12);
    dctx.stroke();
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.stroke();
  });
  if (pdfRemoteCurrentStroke?.points?.length >= 2) {
    const rawPts = pdfRemoteCurrentStroke.points;
    const pts = smoothStrokePoints(rawPts);
    const color = pdfRemoteCurrentStroke.color || drawColor;
    const lw = pdfRemoteCurrentStroke.lineWidth ?? defLw;
    dctx.beginPath();
    dctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) dctx.lineTo(pts[i].x * w, pts[i].y * h);
    dctx.strokeStyle = hexToRgba(color, 0.25);
    dctx.lineWidth = Math.max(lw * 2.5, 12);
    dctx.stroke();
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.stroke();
  }
  drawCursorDot(dctx, w, h, true);
}

async function loadPdfFromShareToken(shareToken) {
  if (!shareToken || !supabase) return false;
  try {
    const { data, error } = await supabase.rpc("get_pdf_by_share_token", { token: shareToken });
    if (error || !data?.[0]?.storage_path) throw new Error("PDF bulunamadı");
    const { data: urlData } = supabase.storage.from("pdfs").getPublicUrl(data[0].storage_path);
    const pdfUrl = urlData?.publicUrl;
    if (!pdfUrl) throw new Error("PDF URL alınamadı");
    pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
    currentPdfShareToken = shareToken;
    pdfTotalPages = pdfDoc.numPages;
    pdfPageNum = 1;
    pdfStrokesByPage = {};
    pdfShapesByPage = {};
    pdfStrokes = [];
    pdfShapes = [];
    pdfCurrentStroke = { points: [], color: drawColor };
    const pages = await fetchStrokes(shareToken);
    if (pages?.length) {
      for (const row of pages) {
        const p = row.page_num;
        if (!pdfStrokesByPage[p]) pdfStrokesByPage[p] = { strokes: [], shapes: [] };
        for (const s of row.strokes || []) {
          pdfStrokesByPage[p].strokes.push({
            points: s.points || [],
            color: s.color || drawColor,
            lineWidth: s.lineWidth ?? drawLineWidth,
          });
        }
      }
    }
    if (cameraWrapper) cameraWrapper.classList.add("pdf-loaded");
    if (pdfPageInfo) pdfPageInfo.textContent = `1 / ${pdfTotalPages}`;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pdfTotalPages <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = pdfTotalPages <= 1;
    if (pdfClearBtn) pdfClearBtn.disabled = false;
    if (drawBtn) drawBtn.disabled = false;
    if (clearDrawBtn) clearDrawBtn.disabled = false;
    if (pdfCopyLinkBtn) {
      const base = getShareBaseUrl();
      pdfCopyLinkBtn.dataset.link = `${base}/index.html?id=${shareToken}`;
      pdfCopyLinkBtn.style.display = "inline-flex";
      pdfCopyLinkBtn.disabled = false;
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
      if (shareUrlRow) {
        shareUrlRow.style.display = isLocalhost ? "flex" : "none";
        if (shareUrlInput) shareUrlInput.value = localStorage.getItem("shareBaseUrl") || "";
      }
    }
    pdfMode = true;
    whiteSheetMode = false;
    blackSheetMode = false;
    pptxMode = false;
    cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pptx-mode", "pptx-loaded");
    cameraWrapper?.classList.add("pdf-mode");
    modeCameraBtn?.classList.remove("active");
    modeWhiteSheetBtn?.classList.remove("active");
    modeBlackSheetBtn?.classList.remove("active");
    modePdfBtn?.classList.add("active");
    modePptxBtn?.classList.remove("active");
    if (pdfUploadGroup) pdfUploadGroup.style.display = "flex";
    if (stopBtn) stopBtn.style.display = "none";
    if (modePdfBtn) modePdfBtn.style.display = "none";
    const pdfZoomGroup = document.getElementById("pdfZoomGroup");
    if (pdfZoomGroup) pdfZoomGroup.style.display = "flex";
    if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
    loadPdfPageState();
    await renderPdfPage();
    updateDocumentOverlays();
    pdfRealtimeUnsubscribe?.();
    pdfRealtimeBroadcast = null;
    pdfRealtimeBroadcastProgress = null;
    const sub = subscribeStrokes(shareToken, (payload) => {
      if (payload?.type === "progress") {
        if (payload.pageNum === pdfPageNum) {
          pdfRemoteCurrentStroke = payload.stroke;
          drawStrokesToPdfCanvas(pdfDrawCanvas?.width || 1, pdfDrawCanvas?.height || 1);
        }
        return;
      }
      if (gestureState === "erasing") return;
      const row = payload?.new || payload?.newRecord || payload?.record;
      if (!row || row.share_token !== shareToken) return;
      const p = row.page_num;
      const incomingStrokes = (row.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      const recentlyErased = lastEraseEndTime > 0 && Date.now() - lastEraseEndTime < 1200;
      if (p === pdfPageNum && recentlyErased) return;
      pdfRemoteCurrentStroke = null;
      if (!pdfStrokesByPage[p]) pdfStrokesByPage[p] = { strokes: [], shapes: [] };
      pdfStrokesByPage[p].strokes = incomingStrokes;
      if (p === pdfPageNum) {
        pdfStrokes = pdfStrokesByPage[p].strokes || [];
        drawStrokesToPdfCanvas(pdfDrawCanvas?.width || 1, pdfDrawCanvas?.height || 1);
      }
    });
    pdfRealtimeUnsubscribe = sub?.unsubscribe || sub;
    pdfRealtimeBroadcast = sub?.broadcast;
    pdfRealtimeBroadcastProgress = sub?.broadcastProgress;
    return true;
  } catch (err) {
    console.error("PDF yükleme hatası:", err);
    alert("PDF açılamadı: " + (err.message || "Bilinmeyen hata"));
    return false;
  }
}

async function loadPdfFromFile(file) {
  if (!file || file.type !== "application/pdf") return;
  try {
    const buf = await file.arrayBuffer();
    const data = new Uint8Array(buf);
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfTotalPages = pdfDoc.numPages;
    pdfPageNum = 1;
    pdfStrokesByPage = {};
    pdfShapesByPage = {};
    pdfStrokes = [];
    pdfShapes = [];
    pdfCurrentStroke = { points: [], color: drawColor };
    if (cameraWrapper) cameraWrapper.classList.add("pdf-loaded");
    if (pdfPageInfo) pdfPageInfo.textContent = `1 / ${pdfTotalPages}`;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pdfTotalPages <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = pdfTotalPages <= 1;
    if (pdfClearBtn) pdfClearBtn.disabled = false;
    if (drawBtn) drawBtn.disabled = false;
    if (clearDrawBtn) clearDrawBtn.disabled = false;
    await renderPdfPage();
    updateDocumentOverlays();
  } catch (err) {
    console.error("Ошибка загрузки PDF:", err);
    alert("Не удалось загрузить PDF: " + (err.message || "Неизвестная ошибка"));
  }
}

function setupPdfDrawing() {
  if (!pdfDrawCanvas) return;
  const getNorm = (e) => {
    const rect = pdfDrawCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height
    };
  };
  const onStart = (e) => {
    if (!pdfMode || !pdfDoc) return;
    e.preventDefault();
    pdfIsDrawing = true;
    const p = getNorm(e);
    pdfCurrentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth };
  };
  let lastBroadcastProgress = 0;
  const onMove = (e) => {
    if (!pdfIsDrawing || !pdfCurrentStroke.points.length) return;
    e.preventDefault();
    const p = getNorm(e);
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      pdfCurrentStroke.points.push({ x: p.x, y: p.y });
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      const now = Date.now();
      if (currentPdfShareToken && pdfRealtimeBroadcastProgress && (now - lastBroadcastProgress >= 50 || pdfCurrentStroke.points.length % 5 === 0)) {
        lastBroadcastProgress = now;
        pdfRealtimeBroadcastProgress(pdfPageNum, pdfCurrentStroke);
      }
    }
  };
  const onEnd = (e) => {
    if (!pdfIsDrawing) return;
    e.preventDefault();
    pdfIsDrawing = false;
    if (pdfCurrentStroke.points.length > 1) {
      pdfStrokes.push({ ...pdfCurrentStroke });
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
    }
    pdfRemoteCurrentStroke = null;
    pdfCurrentStroke = { points: [], color: drawColor };
  };
  pdfDrawCanvas.addEventListener("mousedown", onStart);
  pdfDrawCanvas.addEventListener("mousemove", onMove);
  pdfDrawCanvas.addEventListener("mouseup", onEnd);
  pdfDrawCanvas.addEventListener("mouseleave", onEnd);
  pdfDrawCanvas.addEventListener("touchstart", onStart, { passive: false });
  pdfDrawCanvas.addEventListener("touchmove", onMove, { passive: false });
  pdfDrawCanvas.addEventListener("touchend", onEnd, { passive: false });
}

function setupCanvasDrawing() {
  if (!drawCanvas) return;
  const getNorm = (e) => {
    const rect = drawCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    return { x: MIRROR_CAMERA ? 1 - nx : nx, y: ny };
  };
  let canvasIsDrawing = false;
  const onStart = (e) => {
    if (pdfMode || pptxMode) return;
    e.preventDefault();
    canvasIsDrawing = true;
    const p = getNorm(e);
    currentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth };
  };
  const onMove = (e) => {
    if (!canvasIsDrawing || !currentStroke.points.length) return;
    e.preventDefault();
    const p = getNorm(e);
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      currentStroke.points.push({ x: p.x, y: p.y });
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    }
  };
  const onEnd = (e) => {
    if (!canvasIsDrawing) return;
    e.preventDefault();
    canvasIsDrawing = false;
    if (currentStroke.points.length > 1) {
      strokes.push({ ...currentStroke });
      if (currentCanvasShareToken && supabase) {
        savePageStrokes(currentCanvasShareToken, CANVAS_PAGE, strokes);
      }
    }
    currentStroke = { points: [], color: drawColor };
  };
  drawCanvas.addEventListener("mousedown", onStart);
  drawCanvas.addEventListener("mousemove", onMove);
  drawCanvas.addEventListener("mouseup", onEnd);
  drawCanvas.addEventListener("mouseleave", onEnd);
  drawCanvas.addEventListener("touchstart", onStart, { passive: false });
  drawCanvas.addEventListener("touchmove", onMove, { passive: false });
  drawCanvas.addEventListener("touchend", onEnd, { passive: false });
}

function clearPdf() {
  pdfDoc = null;
  pdfPageNum = 1;
  pdfTotalPages = 0;
  pdfStrokes = [];
  pdfShapes = [];
  pdfStrokesByPage = {};
  pdfShapesByPage = {};
  pdfCurrentStroke = { points: [], color: drawColor };
  if (cameraWrapper) cameraWrapper.classList.remove("pdf-loaded");
  if (pdfPageInfo) pdfPageInfo.textContent = "-";
  if (pdfPrevBtn) pdfPrevBtn.disabled = true;
  if (pdfNextBtn) pdfNextBtn.disabled = true;
  if (pdfClearBtn) pdfClearBtn.disabled = true;
  if (pdfCopyLinkBtn) {
    pdfCopyLinkBtn.style.display = "none";
    pdfCopyLinkBtn.disabled = true;
    delete pdfCopyLinkBtn.dataset.link;
  }
  currentPdfShareToken = null;
  currentCanvasShareToken = null;
  canvasRealtimeUnsubscribe?.();
  canvasRealtimeUnsubscribe = null;
  pdfZoomScale = 1;
  pdfRealtimeUnsubscribe?.();
  pdfRealtimeUnsubscribe = null;
  pdfRealtimeBroadcast = null;
  pdfRealtimeBroadcastProgress = null;
  pdfRemoteCurrentStroke = null;
  const pdfZoomGroup = document.getElementById("pdfZoomGroup");
  if (pdfZoomGroup) pdfZoomGroup.style.display = "none";
  if (pdfCanvas) {
    const ctx = pdfCanvas.getContext("2d");
    ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  }
  if (pdfDrawCanvas) {
    const dctx = pdfDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
  }
  if (drawCanvas) {
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }
  strokes = [];
  shapes = [];
  currentStroke = { points: [], color: drawColor };
  if (pdfFileInput) pdfFileInput.value = "";
  updateDocumentOverlays();
}

const CANVAS_PAGE = 0;
async function loadCanvasFromShareToken(shareToken) {
  if (!shareToken || !supabase) return false;
  try {
    const pages = await fetchStrokes(shareToken);
    const row = pages?.find((r) => r.page_num === CANVAS_PAGE);
    const loadedStrokes = (row?.strokes || []).map((s) => ({
      points: s.points || [],
      color: s.color || drawColor,
      lineWidth: s.lineWidth ?? drawLineWidth,
    }));
    strokes = loadedStrokes;
    shapes = [];
    currentStroke = { points: [], color: drawColor };
    currentCanvasShareToken = shareToken;
    whiteSheetMode = false;
    blackSheetMode = false;
    pdfMode = false;
    pptxMode = false;
    cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode", "pptx-mode", "pptx-loaded");
    modeCameraBtn?.classList.add("active");
    modeWhiteSheetBtn?.classList.remove("active");
    modeBlackSheetBtn?.classList.remove("active");
    modePdfBtn?.classList.remove("active");
    if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
    if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
    if (canvasShareGroup) canvasShareGroup.style.display = "flex";
    if (stopBtn) stopBtn.style.display = "";
    if (modePdfBtn) modePdfBtn.style.display = "";
    if (canvasCopyLinkBtn) {
      canvasCopyLinkBtn.dataset.link = `${getShareBaseUrl()}/index.html?canvas=${shareToken}`;
      canvasCopyLinkBtn.style.display = "inline-flex";
      canvasCopyLinkBtn.disabled = false;
    }
    canvasRealtimeUnsubscribe?.();
    const sub = subscribeStrokes(shareToken, (payload) => {
      const row = payload?.new || payload?.newRecord || payload?.record;
      if (!row || row.share_token !== shareToken || row.page_num !== CANVAS_PAGE) return;
      const incoming = (row.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      strokes = incoming;
      if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    });
    canvasRealtimeUnsubscribe = sub?.unsubscribe || sub;
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    updateDocumentOverlays();
    return true;
  } catch (err) {
    console.error("Canvas load error:", err);
    return false;
  }
}

async function createCanvasShare() {
  if (!supabase) { alert("Сервис недоступен"); return; }
  const token = crypto.randomUUID().replace(/-/g, "");
  const ok = await savePageStrokes(token, CANVAS_PAGE, strokes);
  if (!ok) { alert("Не удалось создать сессию"); return; }
  currentCanvasShareToken = token;
  if (canvasCopyLinkBtn) {
    const link = `${getShareBaseUrl()}/index.html?canvas=${token}`;
    canvasCopyLinkBtn.dataset.link = link;
    canvasCopyLinkBtn.style.display = "inline-flex";
    canvasCopyLinkBtn.disabled = false;
    try {
      await navigator.clipboard.writeText(link);
      const orig = canvasCopyLinkBtn.textContent;
      canvasCopyLinkBtn.textContent = "Скопировано!";
      setTimeout(() => { canvasCopyLinkBtn.textContent = orig; }, 1500);
    } catch (_) {}
  }
  canvasRealtimeUnsubscribe?.();
  const sub = subscribeStrokes(token, (payload) => {
    const row = payload?.new || payload?.newRecord || payload?.record;
    if (!row || row.share_token !== token || row.page_num !== CANVAS_PAGE) return;
    const incoming = (row.strokes || []).map((s) => ({
      points: s.points || [],
      color: s.color || drawColor,
      lineWidth: s.lineWidth ?? drawLineWidth,
    }));
    strokes = incoming;
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  });
  canvasRealtimeUnsubscribe = sub?.unsubscribe || sub;
}

// ========== PPTX РЕЖИМ ==========
function drawStrokesToPptxCanvas(w, h) {
  if (!pptxDrawCanvas) return;
  const dctx = pptxDrawCanvas.getContext("2d");
  dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  const defLw = drawLineWidth || 4;
  pptxShapes.forEach((sh) => {
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      dctx.beginPath();
      dctx.arc(sh.cx * w, sh.cy * h, sh.r * Math.min(w, h), 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "rect") {
      dctx.strokeRect(sh.x * w, sh.y * h, sh.w * w, sh.h * h);
    } else if (sh.type === "line") {
      dctx.beginPath();
      dctx.moveTo(sh.x1 * w, sh.y1 * h);
      dctx.lineTo(sh.x2 * w, sh.y2 * h);
      dctx.stroke();
    } else if (sh.type === "ellipse") {
      const cx = (sh.x + sh.w / 2) * w, cy = (sh.y + sh.h / 2) * h;
      const rx = (sh.w / 2) * w, ry = (sh.h / 2) * h;
      dctx.beginPath();
      dctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sh.type === "arrow") {
      const x1 = sh.x1 * w, y1 = sh.y1 * h, x2 = sh.x2 * w, y2 = sh.y2 * h;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const arrowLen = Math.min(len * 0.3, 20);
      dctx.beginPath();
      dctx.moveTo(x1, y1);
      dctx.lineTo(x2, y2);
      dctx.moveTo(x2 - ux * arrowLen + uy * arrowLen * 0.4, y2 - uy * arrowLen - ux * arrowLen * 0.4);
      dctx.lineTo(x2, y2);
      dctx.lineTo(x2 - ux * arrowLen - uy * arrowLen * 0.4, y2 - uy * arrowLen + ux * arrowLen * 0.4);
      dctx.stroke();
    }
  });
  const allStrokes = [...pptxStrokes, pptxCurrentStroke.points.length > 0 ? pptxCurrentStroke : null].filter(Boolean);
  allStrokes.forEach((stroke) => {
    const rawPts = stroke.points || stroke;
    const pts = smoothStrokePoints(rawPts);
    const color = stroke.color || drawColor;
    const lw = stroke.lineWidth ?? defLw;
    if (pts.length < 2) return;
    dctx.beginPath();
    dctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) dctx.lineTo(pts[i].x * w, pts[i].y * h);
    dctx.strokeStyle = hexToRgba(color, 0.25);
    dctx.lineWidth = Math.max(lw * 2.5, 12);
    dctx.stroke();
    dctx.strokeStyle = color;
    dctx.lineWidth = lw;
    dctx.stroke();
  });
  drawCursorDot(dctx, w, h, true);
}

async function renderPptxSlide() {
  if (!pptxViewer || !pptxCanvas || !pptxDrawCanvas) return;
  const container = pptxContainer;
  const maxW = container?.clientWidth || 800;
  const inferred = pptxViewer.getSlideSize?.() || pptxViewer.getPresentationSize?.() || pptxViewer.slideSize || pptxViewer.presentationSize;
  if (inferred && Number.isFinite(inferred.width) && Number.isFinite(inferred.height) && inferred.width > 0 && inferred.height > 0) {
    pptxAspectRatio = inferred.width / inferred.height;
  }
  let targetW = maxW;
  let targetH = Math.max(1, Math.round(targetW / pptxAspectRatio));
  setWrapperAspect(targetW, targetH);
  pptxCanvas.width = targetW;
  pptxCanvas.height = targetH;
  pptxDrawCanvas.width = targetW;
  pptxDrawCanvas.height = targetH;
  await pptxViewer.goToSlide(pptxPageNum - 1);
  await pptxViewer.render();
  drawStrokesToPptxCanvas(targetW, targetH);
}

async function loadPptxFromFile(file) {
  const valid = file && (file.name?.toLowerCase().endsWith(".pptx") || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  if (!valid) return;
  for (let i = 0; i < 50 && !PPTXViewer; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!PPTXViewer) {
    alert("Не удалось загрузить презентацию: библиотека недоступна");
    return;
  }
  try {
    if (!pptxViewer) {
      pptxViewer = new PPTXViewer({ canvas: pptxCanvas });
    }
    await pptxViewer.loadFile(file);
    pptxTotalPages = pptxViewer.getSlideCount?.() ?? 1;
    pptxPageNum = 1;
    pptxStrokesByPage = {};
    pptxShapesByPage = {};
    pptxStrokes = [];
    pptxShapes = [];
    pptxCurrentStroke = { points: [], color: drawColor };
    if (cameraWrapper) cameraWrapper.classList.add("pptx-loaded");
    if (pptxPageInfo) pptxPageInfo.textContent = `1 / ${pptxTotalPages}`;
    if (pptxPrevBtn) pptxPrevBtn.disabled = pptxTotalPages <= 1;
    if (pptxNextBtn) pptxNextBtn.disabled = pptxTotalPages <= 1;
    if (pptxClearBtn) pptxClearBtn.disabled = false;
    if (drawBtn) drawBtn.disabled = false;
    if (clearDrawBtn) clearDrawBtn.disabled = false;
    await renderPptxSlide();
    updateDocumentOverlays();
  } catch (err) {
    console.error("Ошибка загрузки PPTX:", err);
    alert("Не удалось загрузить презентацию: " + (err.message || "Неизвестная ошибка"));
  }
}

function setupPptxDrawing() {
  if (!pptxDrawCanvas) return;
  const getNorm = (e) => {
    const rect = pptxDrawCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  };
  const onStart = (e) => {
    if (!pptxMode || !pptxViewer) return;
    e.preventDefault();
    pptxIsDrawing = true;
    const p = getNorm(e);
    pptxCurrentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth };
  };
  const onMove = (e) => {
    if (!pptxIsDrawing || !pptxCurrentStroke.points.length) return;
    e.preventDefault();
    const p = getNorm(e);
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      pptxCurrentStroke.points.push({ x: p.x, y: p.y });
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    }
  };
  const onEnd = (e) => {
    if (!pptxIsDrawing) return;
    e.preventDefault();
    pptxIsDrawing = false;
    if (pptxCurrentStroke.points.length > 1) pptxStrokes.push({ ...pptxCurrentStroke });
    pptxCurrentStroke = { points: [], color: drawColor };
  };
  pptxDrawCanvas.addEventListener("mousedown", onStart);
  pptxDrawCanvas.addEventListener("mousemove", onMove);
  pptxDrawCanvas.addEventListener("mouseup", onEnd);
  pptxDrawCanvas.addEventListener("mouseleave", onEnd);
  pptxDrawCanvas.addEventListener("touchstart", onStart, { passive: false });
  pptxDrawCanvas.addEventListener("touchmove", onMove, { passive: false });
  pptxDrawCanvas.addEventListener("touchend", onEnd, { passive: false });
}

function clearPptx() {
  try {
    pptxViewer?.dispose?.();
  } catch (_) {}
  pptxViewer = null;
  pptxPageNum = 1;
  pptxTotalPages = 0;
  pptxStrokes = [];
  pptxShapes = [];
  pptxStrokesByPage = {};
  pptxShapesByPage = {};
  pptxCurrentStroke = { points: [], color: drawColor };
  if (cameraWrapper) cameraWrapper.classList.remove("pptx-loaded");
  if (pptxPageInfo) pptxPageInfo.textContent = "-";
  if (pptxPrevBtn) pptxPrevBtn.disabled = true;
  if (pptxNextBtn) pptxNextBtn.disabled = true;
  if (pptxClearBtn) pptxClearBtn.disabled = true;
  if (pptxCanvas) {
    const ctx = pptxCanvas.getContext("2d");
    ctx.clearRect(0, 0, pptxCanvas.width, pptxCanvas.height);
  }
  if (pptxDrawCanvas) {
    const dctx = pptxDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  }
  if (drawCanvas) {
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }
  strokes = [];
  shapes = [];
  currentStroke = { points: [], color: drawColor };
  if (pptxFileInput) pptxFileInput.value = "";
  updateDocumentOverlays();
}

// ========== ОСНОВНОЙ ЦИКЛ ==========
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

      // 4. El - 21 landmark (sadece seçilen el: sol/sağ)
      handLandmarks = [];
      if (handLandmarker) {
        try {
          const handRes = handLandmarker.detectForVideo(video, t);
          const rawLm = handRes.landmarks || [];
          const handedness = handRes.handedness || [];
          handLandmarks = [];
          for (let i = 0; i < rawLm.length; i++) {
            const h = handedness[i];
            const label = (h?.[0]?.categoryName || h?.[0]?.display_name || (typeof h === "string" ? h : "") || "").toLowerCase();
            if (label === preferredHand) {
              handLandmarks.push(rawLm[i]);
            }
          }
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
      let activeStrokes = strokes;
      let activeShapes = shapes;
      let activeCurrentStroke = currentStroke;
      let activeRedraw = () => drawStrokesToCanvas(w, h);

      if (pdfMode && pdfDoc) {
        activeStrokes = pdfStrokes;
        activeShapes = pdfShapes;
        activeCurrentStroke = pdfCurrentStroke;
        activeRedraw = () => drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      } else if (pptxMode && pptxViewer) {
        activeStrokes = pptxStrokes;
        activeShapes = pptxShapes;
        activeCurrentStroke = pptxCurrentStroke;
        activeRedraw = () => drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      }
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
      let twoFingerHandIdx = -1;
      if (!cursorPos) {
        for (let i = 0; i < handLandmarks.length; i++) {
          twoFingerPos = getTwoFingerPosition(handLandmarks[i]);
          if (twoFingerPos) {
            twoFingerHandIdx = i;
            break;
          }
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
      } else if (twoFingerPos && twoFingerHandIdx >= 0) {
        if (twoFingerPos) {
          const { clientX, clientY } = normToClient(twoFingerPos.x, twoFingerPos.y, w, h);
          updateGestureCursor(clientX, clientY, true);
        } else {
          updateGestureCursor(0, 0, false);
        }
      } else {
        wasToolbarPinch = false;
        updateGestureCursor(0, 0, false);
      }

      // Önce framesSinceDraw/Erase artır (her frame)
      framesSinceDraw++;
      framesSinceErase++;

      if (overToolbar) {
        // пропускаем рисование/стирание — только панель
      } else if ((gestureState === "erasing" && twoFingerPos) || (twoFingerPos && !cursorPos && framesSinceDraw >= GESTURE_LOCK_FRAMES)) {
        /* Silgi: erasing modunda twoFingerPos varsa öncelik ver (ekran sıçramasını önler); yoksa yeni silme moduna gir */
        if (gestureState !== "erasing") {
          gestureState = "erasing";
          drawToolbar?.classList.remove("expanded");
          fingerLostFrames = 0;
          wasPinching = false;
          shapeInProgress = null;
          activeCurrentStroke.points = [];
          activeCurrentStroke.color = drawColor;
          smoothedCursor = null;
          smoothedPinch = null;
          smoothedErasePos = { x: twoFingerPos.x, y: twoFingerPos.y };
        }
        framesSinceErase = 0;
        pinchReleaseFrames = 0;
        if (!smoothedErasePos) smoothedErasePos = { x: twoFingerPos.x, y: twoFingerPos.y };
        else {
          smoothedErasePos.x = smoothedErasePos.x * (1 - ERASE_SMOOTH) + twoFingerPos.x * ERASE_SMOOTH;
          smoothedErasePos.y = smoothedErasePos.y * (1 - ERASE_SMOOTH) + twoFingerPos.y * ERASE_SMOOTH;
        }
        window.drawCursor = null;
        const eraseX = (pdfMode && pdfDoc) || (pptxMode && pptxViewer) ? toDocNormX(smoothedErasePos.x) : smoothedErasePos.x;
        const erased = eraseLayerAtPosition(activeStrokes, activeShapes, eraseX, smoothedErasePos.y, 0.09);
        activeStrokes = erased.strokes;
        activeShapes = erased.shapes;
        if (pdfMode && pdfDoc) { pdfStrokes = erased.strokes; pdfShapes = erased.shapes; }
        else if (pptxMode && pptxViewer) { pptxStrokes = erased.strokes; pptxShapes = erased.shapes; }
        else { strokes = erased.strokes; shapes = erased.shapes; }
        const now = Date.now();
        if (pdfMode && currentPdfShareToken && (now - lastEraseSaveTime >= 200)) {
          lastEraseSaveTime = now;
          savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes, true);
        } else if (currentCanvasShareToken && (now - lastEraseSaveTime >= 200)) {
          lastEraseSaveTime = now;
          savePageStrokes(currentCanvasShareToken, CANVAS_PAGE, strokes);
        }
        activeRedraw();
      } else if (cursorPos) {
        drawToolbar?.classList.remove("expanded");
        if (gestureState === "erasing") {
          if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes, true);
          gestureState = "idle";
          smoothedErasePos = null;
          lastEraseEndTime = Date.now();
        }
        if (!smoothedCursor) smoothedCursor = { x: cursorPos.x, y: cursorPos.y };
        else {
          smoothedCursor.x = smoothedCursor.x * (1 - CURSOR_SMOOTH) + cursorPos.x * CURSOR_SMOOTH;
          smoothedCursor.y = smoothedCursor.y * (1 - CURSOR_SMOOTH) + cursorPos.y * CURSOR_SMOOTH;
        }
        window.drawCursor = smoothedCursor;
        const hand = handLandmarks[handIdx];
        const rawDist = hand ? getThumbIndexDistance(hand) : 1;
        if (gestureState === "idle" && rawDist < PINCH_START_THRESHOLD) {
          smoothedThumbIndexDist = rawDist;
        } else {
          smoothedThumbIndexDist = smoothedThumbIndexDist * (1 - DIST_SMOOTH_ALPHA) + rawDist * DIST_SMOOTH_ALPHA;
        }
        let isPinchActive = false;
        if (gestureState === "drawing") {
          if (smoothedThumbIndexDist > PINCH_RELEASE_THRESHOLD) {
            pinchReleaseFrames++;
            if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) {
              if (activeCurrentStroke.points.length > 1) {
                const stroke = { points: [...activeCurrentStroke.points], color: activeCurrentStroke.color || drawColor, lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth };
                activeStrokes.push(stroke);
                if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
              }
              activeCurrentStroke.points = [];
              activeCurrentStroke.color = drawColor;
              activeCurrentStroke.lineWidth = drawLineWidth;
              gestureState = "idle";
              pinchReleaseFrames = 0;
              smoothedCursor = null;
              smoothedPinch = null;
            }
          } else {
            pinchReleaseFrames = 0;
            isPinchActive = true;
          }
        } else {
          pinchReleaseFrames = 0;
          if (smoothedThumbIndexDist < PINCH_START_THRESHOLD && framesSinceErase >= GESTURE_LOCK_FRAMES) {
            gestureState = "drawing";
            activeCurrentStroke.points = [];
            isPinchActive = true;
          }
        }
        const tiCenter = hand && getThumbIndexSize(hand)?.center;
        let pinchPos;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        if (tiCenter && tiCenter.x >= -0.05 && tiCenter.x <= 1.05 && tiCenter.y >= -0.05 && tiCenter.y <= 1.05) {
          if (!smoothedPinch) smoothedPinch = { x: tiCenter.x, y: tiCenter.y };
          else {
            smoothedPinch.x = smoothedPinch.x * (1 - CURSOR_SMOOTH) + tiCenter.x * CURSOR_SMOOTH;
            smoothedPinch.y = smoothedPinch.y * (1 - CURSOR_SMOOTH) + tiCenter.y * CURSOR_SMOOTH;
          }
          pinchPos = smoothedPinch;
        } else {
          smoothedPinch = null;
          pinchPos = smoothedCursor;
        }
        if (isPinchActive && framesSinceErase >= GESTURE_LOCK_FRAMES) {
          framesSinceDraw = 0;
          fingerLostFrames = 0;
          const drawCursorX = (pdfMode && pdfDoc) || (pptxMode && pptxViewer) ? toDocNormX(smoothedCursor.x) : smoothedCursor.x;
          const drawPinchX = (pdfMode && pdfDoc) || (pptxMode && pptxViewer) ? toDocNormX(pinchPos.x) : pinchPos.x;
          if (["circle","rect","line","ellipse","triangle","arrow"].includes(drawShape)) {
            if (pinchPos) {
              const px = clamp01(drawPinchX), py = clamp01(pinchPos.y);
              if (!shapeInProgress) shapeInProgress = { start: { x: px, y: py }, end: { x: px, y: py }, type: drawShape };
              else shapeInProgress.end = { x: px, y: py };
            }
          } else {
            const pts = activeCurrentStroke.points;
            const last = pts[pts.length - 1];
            const dx = last ? drawCursorX - last.x : 0;
            const dy = last ? smoothedCursor.y - last.y : 0;
            const dist = Math.hypot(dx, dy);
            const cx = clamp01(drawCursorX), cy = clamp01(smoothedCursor.y);
            if (!last || dist > MIN_STROKE_DIST) {
              activeCurrentStroke.points.push({ x: cx, y: cy });
              activeCurrentStroke.color = activeCurrentStroke.color || drawColor;
              activeCurrentStroke.lineWidth = activeCurrentStroke.lineWidth ?? drawLineWidth;
              const now = Date.now();
              if (pdfMode && currentPdfShareToken && pdfRealtimeBroadcastProgress && activeCurrentStroke.points.length >= 2 && (now - lastGestureBroadcastProgress >= 50 || activeCurrentStroke.points.length % 5 === 0)) {
                lastGestureBroadcastProgress = now;
                pdfRealtimeBroadcastProgress(pdfPageNum, activeCurrentStroke);
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
                activeShapes.push({ type: "circle", cx, cy, r: Math.max(diag / 2, minSize / 2), color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "rect") {
                activeShapes.push({ type: "rect", x: x1, y: y1, w, h, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "line") {
                activeShapes.push({ type: "line", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "ellipse") {
                activeShapes.push({ type: "ellipse", x: x1, y: y1, w, h, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "triangle") {
                activeShapes.push({ type: "triangle", x1: s.x, y1: s.y, x2: e.x, y2: e.y, x3: s.x, y3: e.y, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "arrow") {
                activeShapes.push({ type: "arrow", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              }
            }
            shapeInProgress = null;
          }
          wasPinching = false;
          fingerLostFrames++;
          if (fingerLostFrames >= FINGER_LOST_THRESHOLD && activeCurrentStroke.points.length > 0) {
            const stroke = { points: [...activeCurrentStroke.points], color: activeCurrentStroke.color || drawColor, lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth };
            activeStrokes.push(stroke);
            if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
            activeCurrentStroke.points = [];
            activeCurrentStroke.color = drawColor;
            smoothedCursor = null;
            smoothedPinch = null;
          }
        }
      } else {
        if (gestureState === "erasing" && pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes, true);
        if (gestureState === "erasing") lastEraseEndTime = Date.now();
        window.drawCursor = null;
        wasPinching = false;
        shapeInProgress = null;
        gestureState = "idle";
        smoothedErasePos = null;
        pinchReleaseFrames = 0;
        fingerLostFrames++;
        if (fingerLostFrames >= FINGER_LOST_THRESHOLD && activeCurrentStroke.points.length > 0) {
          const stroke = { points: [...activeCurrentStroke.points], color: activeCurrentStroke.color || drawColor, lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth };
          activeStrokes.push(stroke);
          if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
          activeCurrentStroke.points = [];
          activeCurrentStroke.color = drawColor;
          smoothedCursor = null;
          smoothedPinch = null;
        }
      }

      if (pdfMode && pdfDoc) {
        pdfStrokes = activeStrokes;
        pdfShapes = activeShapes;
        pdfCurrentStroke = activeCurrentStroke;
      } else if (pptxMode && pptxViewer) {
        pptxStrokes = activeStrokes;
        pptxShapes = activeShapes;
        pptxCurrentStroke = activeCurrentStroke;
      } else {
        strokes = activeStrokes;
        shapes = activeShapes;
        currentStroke = activeCurrentStroke;
      }
      syncCurrentDocumentPageState();
    } else {
      window.drawCursor = null;
      smoothedCursor = null;
      smoothedPinch = null;
      updateGestureCursor(0, 0, false);
    }
    if (pdfMode && pdfDoc) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
    else if (pptxMode && pptxViewer) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    else drawStrokesToCanvas(w, h);

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
    } else {
      eyeOverlay.className = "eye-overlay eyes-open";
      eyesOpenFrames++;
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

// ========== ЗАПУСК КАМЕРЫ ==========
async function startCamera() {
  try {
    errorMessage.classList.remove("visible");
    startBtn.disabled = true;
    startBtn.textContent = "Запуск...";

    if (window.location.protocol === "file:") {
      throw new Error("FILE_PROTOCOL");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Ваш браузер не поддерживает камеру. Используйте Chrome или Firefox.");
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
      throw new Error("Не удалось воспроизвести видео. Обновите страницу и попробуйте снова.");
    }

    // Ожидание размеров видео (макс 3 с)
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
    if (pdfMode && pdfDoc) setTimeout(() => scheduleDocRefitStable(), 150);
    if (modeWhiteSheetBtn) modeWhiteSheetBtn.disabled = false;
    drawBtn.disabled = false;
    clearDrawBtn.disabled = false;
    objectsBtn.disabled = false;
    addObjBtn.disabled = false;
    removeObjBtn.disabled = false;
    startBtn.textContent = "Запустить камеру";

    lastVideoTime = -1;
    detectLoop();

    // Загрузка моделей в фоне — камера работает сразу
    if (!poseLandmarker) {
      (async () => {
        try {
          const vision = await FilesetResolver.forVisionTasks(WASM);
          poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.25,
            minTrackingConfidence: 0.25,
          });
          faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
          });
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.2,
            minHandPresenceConfidence: 0.2,
            minTrackingConfidence: 0.2,
          });
        } catch (modelErr) {
          console.error("Ошибка загрузки модели:", modelErr);
        }
      })();
    }
  } catch (err) {
    console.error("Ошибка камеры:", err);
    startBtn.textContent = "Запустить камеру";
    startBtn.disabled = false;
    let msg = "Нет доступа к камере. ";
    if (err.message === "FILE_PROTOCOL") {
      msg = "Открытие по file:// не работает. Запустите 'python3 -m http.server 8000' и откройте http://localhost:8000";
    } else if (err.message?.includes("Ваш браузер")) {
      msg = err.message;
    } else {
      const s = (err.message || "").toLowerCase();
      if (err.name === "NotAllowedError" || s.includes("permission") || s.includes("denied")) {
        msg = "Разрешение камеры отклонено. Нажмите на значок замка/камеры в адресной строке, выберите «Разрешить» и обновите страницу.";
      } else if (err.name === "NotFoundError") {
        msg = "Камера не найдена. Попробуйте другое устройство.";
      } else if (err.name === "NotReadableError" || s.includes("not readable")) {
        msg = "Камера может использоваться другим приложением. Закройте другие программы.";
      } else if (s.includes("overconstrained") || s.includes("constraint")) {
        msg = "Настройки камеры не поддерживаются. Попробуйте другой браузер.";
      } else {
        msg = "Ошибка: " + (err.message || err.name || "Неизвестная ошибка");
      }
    }
    errorMessage.textContent = msg;
    errorMessage.classList.add("visible");
    cameraOverlay.classList.remove("hidden");
  }
}

// ========== ОСТАНОВКА КАМЕРЫ ==========
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
  objectsBtn.textContent = "🔮 Объекты";
  strokes = [];
  shapes = [];
  currentStroke = { points: [], color: drawColor };
  const ctx = output.getContext("2d");
  ctx.clearRect(0, 0, output.width, output.height);
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

// ========== ОБРАБОТЧИКИ СОБЫТИЙ ==========
const fullscreenBtn = document.getElementById("fullscreenBtn");
const exitFullscreenBtn = document.getElementById("exitFullscreenBtn");
function toggleCanvasFullscreen() {
  const app = document.querySelector(".app");
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  app?.classList.add("canvas-fullscreen");
  app?.requestFullscreen?.().catch(() => {
    app?.classList.remove("canvas-fullscreen");
  });
}
fullscreenBtn?.addEventListener("click", toggleCanvasFullscreen);
exitFullscreenBtn?.addEventListener("click", toggleCanvasFullscreen);

const handLeftBtn = document.getElementById("handLeftBtn");
const handRightBtn = document.getElementById("handRightBtn");
handLeftBtn?.addEventListener("click", () => {
  preferredHand = "left";
  localStorage.setItem("preferredHand", "left");
  handLeftBtn?.classList.add("active");
  handRightBtn?.classList.remove("active");
});
handRightBtn?.addEventListener("click", () => {
  preferredHand = "right";
  localStorage.setItem("preferredHand", "right");
  handRightBtn?.classList.add("active");
  handLeftBtn?.classList.remove("active");
});
if (handLeftBtn && handRightBtn) {
  handLeftBtn.classList.toggle("active", preferredHand === "left");
  handRightBtn.classList.toggle("active", preferredHand === "right");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.querySelector(".app.canvas-fullscreen")) toggleCanvasFullscreen();
    else if (document.fullscreenElement) document.exitFullscreen?.();
  }
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    document.querySelector(".app")?.classList.remove("canvas-fullscreen");
  }
  scheduleDocRefitStable();
});

modeCameraBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  whiteSheetMode = false;
  blackSheetMode = false;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode", "pdf-loaded", "pptx-mode", "pptx-loaded");
  modeCameraBtn?.classList.add("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (canvasShareGroup) canvasShareGroup.style.display = "flex";
  if (stopBtn) stopBtn.style.display = "";
  if (modePdfBtn) modePdfBtn.style.display = "";
  restoreCameraAspect();
  updateDocumentOverlays();
});

modeWhiteSheetBtn?.addEventListener("click", () => {
  whiteSheetMode = true;
  blackSheetMode = false;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pdf-loaded", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("white-sheet-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.add("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (canvasShareGroup) canvasShareGroup.style.display = "flex";
  if (stopBtn) stopBtn.style.display = "";
  if (modePdfBtn) modePdfBtn.style.display = "";
  restoreCameraAspect();
  updateDocumentOverlays();
});

modeBlackSheetBtn?.addEventListener("click", () => {
  whiteSheetMode = true;
  blackSheetMode = true;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("pdf-mode", "pdf-loaded", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("white-sheet-mode", "black-sheet-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.add("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (canvasShareGroup) canvasShareGroup.style.display = "flex";
  if (stopBtn) stopBtn.style.display = "";
  if (modePdfBtn) modePdfBtn.style.display = "";
  restoreCameraAspect();
  updateDocumentOverlays();
});

modePdfBtn?.addEventListener("click", () => {
  whiteSheetMode = false;
  blackSheetMode = false;
  pdfMode = true;
  pptxMode = false;
  currentCanvasShareToken = null;
  canvasRealtimeUnsubscribe?.();
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("pdf-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.add("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "flex";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (canvasShareGroup) canvasShareGroup.style.display = "none";
  if (stopBtn) stopBtn.style.display = "none";
  if (modePdfBtn) modePdfBtn.style.display = "none";
  if (pdfDoc) {
    loadPdfPageState();
    cameraWrapper?.classList.add("pdf-loaded");
    renderPdfPage();
  }
  updateDocumentOverlays();
});

modePptxBtn?.addEventListener("click", () => {
  whiteSheetMode = false;
  blackSheetMode = false;
  pdfMode = false;
  pptxMode = true;
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode", "pdf-loaded");
  cameraWrapper?.classList.add("pptx-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.add("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "flex";
  if (canvasShareGroup) canvasShareGroup.style.display = "none";
  if (stopBtn) stopBtn.style.display = "";
  if (modePdfBtn) modePdfBtn.style.display = "none";
  if (pptxViewer) {
    loadPptxPageState();
    cameraWrapper?.classList.add("pptx-loaded");
    renderPptxSlide();
  }
  updateDocumentOverlays();
});

showSkeletonCheck.addEventListener("change", () => {
  showSkeleton = showSkeletonCheck.checked;
});

toolbarTrigger?.addEventListener("click", () => {
  drawToolbar?.classList.toggle("expanded");
});

toolbarColor?.addEventListener("input", () => {
  drawColor = toolbarColor.value;
  if (pdfMode && pdfDoc) pdfCurrentStroke.color = drawColor;
  else if (pptxMode && pptxViewer) pptxCurrentStroke.color = drawColor;
  else currentStroke.color = drawColor;
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
    if (pdfMode && pdfDoc) pdfCurrentStroke.color = c;
    else if (pptxMode && pptxViewer) pptxCurrentStroke.color = c;
    else currentStroke.color = c;
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
  if (!drawMode) {
    if (pdfMode && pdfDoc && pdfCurrentStroke.points.length > 0) {
      const stroke = { points: [...pdfCurrentStroke.points], color: pdfCurrentStroke.color || drawColor, lineWidth: pdfCurrentStroke.lineWidth ?? drawLineWidth };
      pdfStrokes.push(stroke);
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
      pdfCurrentStroke = { points: [], color: drawColor };
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
    } else if (pptxMode && pptxViewer && pptxCurrentStroke.points.length > 0) {
      pptxStrokes.push({ points: [...pptxCurrentStroke.points], color: pptxCurrentStroke.color || drawColor, lineWidth: pptxCurrentStroke.lineWidth ?? drawLineWidth });
      pptxCurrentStroke = { points: [], color: drawColor };
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    } else if (currentStroke.points.length > 0) {
      strokes.push({ points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth });
      currentStroke = { points: [], color: drawColor };
    }
  }
});

clearDrawBtn.addEventListener("click", () => {
  if (pdfMode && pdfDrawCanvas) {
    if (currentPdfShareToken) {
      deleteStrokesForPage(currentPdfShareToken, pdfPageNum);
    }
    pdfStrokes = [];
    pdfShapes = [];
    pdfStrokesByPage[pdfPageNum] = { strokes: [], shapes: [] };
    pdfCurrentStroke = { points: [], color: drawColor };
    const dctx = pdfDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
  } else if (pptxMode && pptxDrawCanvas) {
    pptxStrokes = [];
    pptxShapes = [];
    pptxStrokesByPage[pptxPageNum] = { strokes: [], shapes: [] };
    pptxCurrentStroke = { points: [], color: drawColor };
    const dctx = pptxDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  } else {
    strokes = [];
    shapes = [];
    currentStroke = { points: [], color: drawColor };
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, CANVAS_PAGE, []);
  }
  syncCurrentDocumentPageState();
});

objectsBtn?.addEventListener("click", () => {
  objectsMode = !objectsMode;
  objectsBtn.classList.toggle("active", objectsMode);
  objectsBtn.textContent = objectsMode ? "🔮 Закрыть объекты" : "🔮 Объекты";
});

addObjBtn?.addEventListener("click", () => {
  const x = 0.2 + Math.random() * 0.6;
  const y = 0.25 + Math.random() * 0.4;
  VIRTUAL_OBJECTS.push(createObject(x, y));
});

removeObjBtn?.addEventListener("click", () => {
  if (VIRTUAL_OBJECTS.length > 0) {
    const last = VIRTUAL_OBJECTS.pop();
    if (last?.grabbed) lastGrabPos = null;
  }
});

startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);

// PDF event listeners
pdfFileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadPdfFromFile(file);
  let uploadError = null;
  const result = await uploadPdfToSupabase(file, null, (err) => { uploadError = err; });
  if (uploadError) {
    alert("PDF veritabanına kaydedilemedi: " + uploadError);
    console.error("PDF upload hatası:", uploadError);
  }
  if (result?.shareId) {
    currentPdfShareToken = result.shareId;
    const strokes = await fetchStrokes(result.shareId);
    if (strokes?.length) {
      for (const row of strokes) {
        const p = row.page_num;
        if (!pdfStrokesByPage[p]) pdfStrokesByPage[p] = { strokes: [], shapes: [] };
        const sd = row.stroke_data || {};
        pdfStrokesByPage[p].strokes.push({
          points: sd.points || [],
          color: sd.color || drawColor,
          lineWidth: sd.lineWidth ?? drawLineWidth,
        });
      }
      loadPdfPageState();
      await renderPdfPage();
    }
  }
  if (result?.link && pdfCopyLinkBtn) {
    pdfCopyLinkBtn.dataset.link = result.link;
    pdfCopyLinkBtn.style.display = "inline-flex";
    pdfCopyLinkBtn.disabled = false;
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(result.link);
    if (shareUrlRow && isLocalhost) {
      shareUrlRow.style.display = "flex";
      if (shareUrlInput) shareUrlInput.value = localStorage.getItem("shareBaseUrl") || "";
    }
    if (errorMessage) {
      errorMessage.textContent = "PDF kaydedildi. Çizimler anlık kaydediliyor.";
      errorMessage.style.color = "var(--accent)";
      errorMessage.classList.add("visible");
      setTimeout(() => { errorMessage.textContent = ""; errorMessage.classList.remove("visible"); }, 3000);
    }
  }
  e.target.value = "";
});

pdfPrevBtn?.addEventListener("click", async () => {
  if (pdfPageNum <= 1 || !pdfDoc) return;
  savePdfPageState();
  pdfPageNum--;
  loadPdfPageState();
  if (pdfPageInfo) pdfPageInfo.textContent = `${pdfPageNum} / ${pdfTotalPages}`;
  pdfPrevBtn.disabled = pdfPageNum <= 1;
  pdfNextBtn.disabled = false;
  await renderPdfPage();
});

pdfNextBtn?.addEventListener("click", async () => {
  if (pdfPageNum >= pdfTotalPages || !pdfDoc) return;
  savePdfPageState();
  pdfPageNum++;
  loadPdfPageState();
  if (pdfPageInfo) pdfPageInfo.textContent = `${pdfPageNum} / ${pdfTotalPages}`;
  pdfNextBtn.disabled = pdfPageNum >= pdfTotalPages;
  pdfPrevBtn.disabled = false;
  await renderPdfPage();
});

pdfClearBtn?.addEventListener("click", () => {
  clearPdf();
});

document.getElementById("zoomInBtn")?.addEventListener("click", () => {
  pdfZoomScale = Math.min(3, pdfZoomScale + 0.25);
  document.getElementById("zoomVal").textContent = Math.round(pdfZoomScale * 100) + "%";
  renderPdfPage();
});
document.getElementById("zoomOutBtn")?.addEventListener("click", () => {
  pdfZoomScale = Math.max(0.5, pdfZoomScale - 0.25);
  document.getElementById("zoomVal").textContent = Math.round(pdfZoomScale * 100) + "%";
  renderPdfPage();
});

canvasShareBtn?.addEventListener("click", () => createCanvasShare());
canvasCopyLinkBtn?.addEventListener("click", async () => {
  const link = canvasCopyLinkBtn?.dataset?.link;
  if (!link) return;
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(link);
  if (isLocalhost) {
    alert("Ссылка на localhost — поделитесь туннельным URL (npm run share).");
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    const orig = canvasCopyLinkBtn.textContent;
    canvasCopyLinkBtn.textContent = "Скопировано!";
    setTimeout(() => { canvasCopyLinkBtn.textContent = orig; }, 1500);
  } catch (e) { console.warn(e); }
});

shareUrlSaveBtn?.addEventListener("click", () => {
  const url = shareUrlInput?.value?.trim() || "";
  if (url && url.startsWith("http")) {
    localStorage.setItem("shareBaseUrl", url.replace(/\/$/, ""));
    if (pdfCopyLinkBtn?.dataset?.link) {
      const id = (pdfCopyLinkBtn.dataset.link.match(/[?&]id=([^&]+)/) || [])[1];
      if (id) pdfCopyLinkBtn.dataset.link = `${url.replace(/\/$/, "")}/index.html?id=${id}`;
    }
    if (shareUrlRow) shareUrlRow.style.display = "none";
  } else {
    localStorage.removeItem("shareBaseUrl");
  }
});

pdfCopyLinkBtn?.addEventListener("click", async () => {
  const link = pdfCopyLinkBtn?.dataset?.link;
  if (!link) return;
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(link);
  if (isLocalhost) {
    alert("Bu link localhost — arkadaşın açamaz.\n\nÖnce yukarıdaki alana tünel URL'ini gir (npm run share sonrası çıkan https://xxx.loca.lt) ve OK'a bas.");
    if (shareUrlRow) shareUrlRow.style.display = "flex";
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    const orig = pdfCopyLinkBtn.textContent;
    pdfCopyLinkBtn.textContent = "Ссылка скопирована!";
    setTimeout(() => { pdfCopyLinkBtn.textContent = orig; }, 1500);
  } catch (e) {
    console.warn("Kopyalama hatası:", e);
  }
});

pptxFileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) loadPptxFromFile(file);
  e.target.value = "";
});

pptxPrevBtn?.addEventListener("click", async () => {
  if (pptxPageNum <= 1 || !pptxViewer) return;
  savePptxPageState();
  pptxPageNum--;
  loadPptxPageState();
  if (pptxPageInfo) pptxPageInfo.textContent = `${pptxPageNum} / ${pptxTotalPages}`;
  pptxPrevBtn.disabled = pptxPageNum <= 1;
  pptxNextBtn.disabled = false;
  await renderPptxSlide();
});

pptxNextBtn?.addEventListener("click", async () => {
  if (pptxPageNum >= pptxTotalPages || !pptxViewer) return;
  savePptxPageState();
  pptxPageNum++;
  loadPptxPageState();
  if (pptxPageInfo) pptxPageInfo.textContent = `${pptxPageNum} / ${pptxTotalPages}`;
  pptxNextBtn.disabled = pptxPageNum >= pptxTotalPages;
  pptxPrevBtn.disabled = false;
  await renderPptxSlide();
});

pptxClearBtn?.addEventListener("click", () => {
  clearPptx();
});

let docRefitRaf = null;
function scheduleDocRefit() {
  if (docRefitRaf) cancelAnimationFrame(docRefitRaf);
  docRefitRaf = requestAnimationFrame(async () => {
    docRefitRaf = null;
    if (pdfMode && pdfDoc) {
      await renderPdfPage();
    } else if (pptxMode && pptxViewer) {
      await renderPptxSlide();
    }
  });
}

function scheduleDocRefitStable() {
  scheduleDocRefit();
  setTimeout(() => scheduleDocRefit(), 120);
}

window.addEventListener("resize", scheduleDocRefit);
if (window.ResizeObserver && cameraWrapper) {
  const observer = new ResizeObserver(() => scheduleDocRefit());
  observer.observe(cameraWrapper);
}

setupPdfDrawing();
setupPptxDrawing();
setupCanvasDrawing();

const urlParams = new URLSearchParams(window.location.search);
const shareId = urlParams.get("id");
const canvasId = urlParams.get("canvas");
const isCameraMode = urlParams.get("mode") === "camera";

if (shareId) {
  loadPdfFromShareToken(shareId).then((ok) => {
    if (ok) {
      modeCameraBtn?.classList.remove("active");
      modePdfBtn?.classList.add("active");
      modeToggle?.querySelectorAll(".btn-mode").forEach((b) => { if (b !== modePdfBtn) b.style.display = "none"; });
      startBtn.style.display = "none";
      stopBtn.style.display = "none";
      modePdfBtn.style.display = "none";
      startCamera();
    }
  });
} else if (canvasId) {
  loadCanvasFromShareToken(canvasId).then((ok) => {
    if (ok) {
      modeToggle?.querySelectorAll(".btn-mode").forEach((b) => { if (b !== modeCameraBtn) b.style.display = "none"; });
      startBtn.style.display = "none";
      stopBtn.style.display = "";
      startCamera();
    } else alert("Не удалось загрузить общий холст");
  });
} else if (isCameraMode) {
  pdfOverlay?.classList.add("hidden");
  modePdfBtn?.classList.remove("active");
  modeCameraBtn?.classList.add("active");
  [modePdfBtn, modePptxBtn].forEach((b) => { if (b) b.style.display = "none"; });
  [modeCameraBtn, modeWhiteSheetBtn, modeBlackSheetBtn].forEach((b) => { if (b) b.style.display = ""; });
  startBtn.style.display = "none";
  stopBtn.style.display = "";
  startCamera();
}
