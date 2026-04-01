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
import { showShareLinkWithQr } from "./share-qr.js";
import { savePageStrokes as _savePageStrokes, deleteStrokesForPage, fetchStrokes, subscribeStrokes, deserializeFillShapes } from "./supabase-strokes.js";
import { getCanvasByShareToken } from "./supabase-canvas.js";

import {
  POSE_MODEL,
  FACE_MODEL,
  HAND_MODEL,
  WASM,
  DETECT_EVERY_N_FRAMES,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  MIN_VIS,
} from "./app/config/mediapipeConstants.js";
import { cloneStroke, cloneShape, clonePageLayer } from "./app/drawing/cloneLayer.js";
import { hexToRgba, parseHex, colorMatch } from "./app/drawing/colorUtils.js";
import { eraseLayerAtPosition } from "./app/drawing/eraseLayer.js";
import {
  pickSelectionInRect,
  selectionUnionBBoxFromSel,
  pointInNormRect,
  applySelectionOffset,
  pointSegDistNorm,
  getActivePinchDepthRel,
  isThumbIndexSpreadGate,
  getOffHandForSelectGate,
  applySelectionScale,
  screenRectFromNormMarquee,
  getSingleSelectedPlacedImage,
  hitTestPlacedImageResizeHandle,
  createPlacedImageResizeStart,
  applyPlacedImageResize,
} from "./app/drawing/selectionNorm.js";
import { trySnapFreehandToShape } from "./app/drawing/sketchHoldSnap.js";
import { tickSketchSnapHold, resetSnapHoldState } from "./app/drawing/sketchSnapHold.js";
import { drawPlacedImageShape, fileToPlacedImageShape, PLACED_IMAGE_READY_EVENT } from "./app/drawing/placedImageShape.js";
import {
  isTwoFingersExtended,
  getTwoFingerPosition,
  isFistClenched,
  getHandGrabPoint,
  getThumbIndexDistance,
  getHandSize,
  getPinchStartThreshold,
  getPinchReleaseThreshold,
  isIndexThumbPinch,
  getPinchCursorPosition,
  getThumbIndexSize,
  stepMiddleThumbTouching,
} from "./app/gestures/handGeometry.js";
import { toPx } from "./app/overlay/coords.js";
import { drawHandLandmarks } from "./app/overlay/handDraw.js";
import { drawPoseSkeleton } from "./app/overlay/poseDraw.js";
import { drawEyeContours, checkEyesClosed } from "./app/overlay/faceDraw.js";

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

const MIRROR_CAMERA = true;

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
let drawToolbarMouseInside = false;
let drawToolbarGestureInside = false;
function updateDrawToolbarOpenState() {
  if (!drawToolbar) return;
  const open = drawToolbarMouseInside || drawToolbarGestureInside;
  const was = drawToolbar.classList.contains("draw-toolbar--open");
  if (!open) {
    drawToolbar.classList.remove("draw-toolbar--open");
    if (was) {
      document.getElementById("colorPopover")?.classList.remove("visible");
      document.getElementById("figuresPopover")?.classList.remove("visible");
      document.getElementById("thicknessPopover")?.classList.remove("visible");
      document.getElementById("opacityPopover")?.classList.remove("visible");
    }
    return;
  }
  drawToolbar.classList.add("draw-toolbar--open");
}
drawToolbar?.addEventListener("mouseenter", () => {
  drawToolbarMouseInside = true;
  updateDrawToolbarOpenState();
});
drawToolbar?.addEventListener("mouseleave", () => {
  if (document.documentElement.classList.contains("force-toolbar-open")) return;
  drawToolbarMouseInside = false;
  const ae = document.activeElement;
  if (ae && drawToolbar.contains(ae)) ae.blur();
  updateDrawToolbarOpenState();
});

function syncTouchDrawLayout() {
  const html = document.documentElement;
  const hasTouch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  const tabletOrNarrow = window.matchMedia("(max-width: 1024px)").matches;
  const phoneBar = window.matchMedia("(max-width: 900px)").matches;
  const forceToolbarOpen = hasTouch && (coarse || noHover || tabletOrNarrow);
  const useBottomToolbar = hasTouch && phoneBar;
  html.classList.toggle("force-toolbar-open", forceToolbarOpen);
  html.classList.toggle("touch-draw-ui", useBottomToolbar);
  if (drawToolbar && forceToolbarOpen) drawToolbar.classList.add("draw-toolbar--open");
}
syncTouchDrawLayout();
window.addEventListener("resize", syncTouchDrawLayout, { passive: true });
window.addEventListener("orientationchange", () => setTimeout(syncTouchDrawLayout, 250));
const toolbarContent = document.getElementById("toolbarContent");
const gestureCursor = document.getElementById("gestureCursor");
const toolbarColor = document.getElementById("toolbarColor");
const objectsBtn = document.getElementById("objectsBtn");
const addObjBtn = document.getElementById("addObjBtn");
const removeObjBtn = document.getElementById("removeObjBtn");
const showSkeletonCheck = document.getElementById("showSkeleton");
const fpsEl = document.getElementById("fps");
const appHeaderTitle = document.getElementById("appHeaderTitle");
const modeToggle = document.getElementById("modeToggle");
const modeCameraBtn = document.getElementById("modeCameraBtn");
const modeWhiteSheetBtn = document.getElementById("modeWhiteSheetBtn");
const modeBlackSheetBtn = document.getElementById("modeBlackSheetBtn");
const modePdfBtn = document.getElementById("modePdfBtn");
const modePptxBtn = document.getElementById("modePptxBtn");
const cameraWrapper = document.getElementById("cameraWrapper");
const whiteSheetBg = document.getElementById("whiteSheetBg");
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
const pdfNavGroup = document.getElementById("pdfNavGroup");
const pdfPageInfo = document.getElementById("pdfPageInfo");
const pdfClearBtn = document.getElementById("pdfClearBtn");
const pdfCopyLinkBtn = document.getElementById("pdfCopyLinkBtn");
const drawingControlsGroup = document.getElementById("drawingControlsGroup");
const canvasSharedToggleBtn = document.getElementById("canvasSharedToggleBtn");
const canvasLinkBtn = document.getElementById("canvasLinkBtn");
const pdfLinkBtn = document.getElementById("pdfLinkBtn");
const gestureControlBtn = document.getElementById("gestureControlBtn");
const cameraControlsGroup = document.getElementById("cameraControlsGroup");
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
const canvasPageNavGroup = document.getElementById("canvasPageNavGroup");
const canvasPrevBtn = document.getElementById("canvasPrevBtn");
const canvasNextBtn = document.getElementById("canvasNextBtn");
const canvasAddPageBtn = document.getElementById("canvasAddPageBtn");
const canvasPageInfo = document.getElementById("canvasPageInfo");

// State
let poseLandmarker = null;
let faceLandmarker = null;
let handLandmarker = null;
let mediaPipeLoadPromise = null;
let stream = null;
let loopId = null;
let cameraStartPromise = null;
let cameraStartEpoch = 0;
let lastVideoTime = -1;
let frameCount = 0;
let lastFpsTime = performance.now();
let eyesClosedFrames = 0;
let eyesOpenFrames = 0;
let drawMode = false;
let objectsMode = false;
let drawColor = "#6c5ce7";
let drawLineWidth = 4;
let drawShape = "free";
let drawToolType = "pen";
let eraserMode = false;
const MIN_SELECT_NORM = 0.012;
let selectMarqueeNorm = null;
let selectState = null;
let selectDragging = false;
let selectDragAnchor = null;
let selectImageResizing = false;
let selectImageResizeStart = null;
/** Tercih dışı el (select + pinch kapısı / derinlik zoom için) — ham detect çıktısı */
let cachedOffHandLandmark = null;
/** Seçili nesneyi tutarken: kapı açıkken aktif el pinch Z referansı */
let selectScaleLastZ = null;
let selectScaleZSmooth = null;
let selectScaleGateMissFrames = 0;
let canvasFadeEnabled = false;
const FADE_DURATION_MS = 1500;
let shapeFill = false;
let canvasBackgroundColor = "#ffffff";
let strokeOpacity = 1;
let fillShapes = [];
let strokes = [];
let historyStack = [];
let historyIndex = -1;
let shapes = [];
let currentStroke = { points: [], color: "#6c5ce7" };
let fingerLostFrames = 0;
let lastDrawHandId = null;
let wasPinching = false;
let wasTwoFingersClick = false;
let showSkeleton = true;
let whiteSheetMode = false;
let blackSheetMode = false;
let gestureControlEnabled = false;
let wasToolbarPinch = false;
let shapeInProgress = null;
let pdfShapeInProgress = null;
let smoothedCursor = null;
let smoothedPinch = null;
let smoothedErasePos = null;
const CURSOR_SMOOTH = 0.45;
const ERASE_SMOOTH = 0.5;
const GESTURE_LOCK_FRAMES = 6;
let framesSinceDraw = 999;
let framesSinceErase = 999;

const GESTURE_STATE = { IDLE: "idle", DRAWING: "drawing", ERASING: "erasing" };
let gestureState = GESTURE_STATE.IDLE;
let smoothedThumbIndexDist = 0.2;
let pinchReleaseFrames = 0;
let twoFingerHeldFrames = 0;
const PINCH_RELEASE_FRAMES = 4;
const DIST_SMOOTH_ALPHA = 0.6;
/** Orta+b başparmak: 2 dokunuş = mod, 3 = kırmızı. 2. dokunuştan sonra kısa süre bekleyip (3. yoksa) mod değişir. */
const MIDDLE_THUMB_DOUBLE_WAIT_MS_MIN = 70;
const MIDDLE_THUMB_DOUBLE_WAIT_MS_MAX = 130;
const MIDDLE_THUMB_DOUBLE_WAIT_FACTOR = 1.1;
const MIDDLE_THUMB_SINGLE_STALE_MS = 720;
const MIDDLE_THUMB_SEQUENCE_WINDOW_MS = 1000;
const MIDDLE_THUMB_MIN_TAP_INTERVAL_MS = 18;
const GESTURE_RED_PEN_HEX = "#e53935";
const GESTURE_MODE_CYCLE_COOLDOWN_MS = 280;
let middleThumbTouchingHyst = false;
let middleThumbWasTouching = false;
let middleThumbTapTimes = [];
let middleThumbGestureTimer = null;
let gestureModeCycleCooldownUntil = 0;
const FINGER_LOST_THRESHOLD = 6;
const MIN_STROKE_DIST = 0.002;
/** Шаг от последней точки ≥ этого (норм.) — «заметное» продолжение; микроточки не продлевают «тишину» для snap */
const FREEHAND_SNAP_SIGNIFICANT_STEP = 0.009;
/** Удержание в конце штриха: круг или линия (логика в sketchSnapHold.js) */
const SKETCH_SNAP_HOLD_MS = 1300;
const SKETCH_SNAP_MIN_POINTS = 6;
const SKETCH_SNAP_POLL_MS = 50;
let gestureSnapHoldState = { holdMs: 0, holdRef: null };
let gestureFreehandSignificantAt = 0;
let gestureSnapHoldFrameAt = 0;
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
let pdfFillShapes = [];
let pdfHistoryStack = [];
let pdfHistoryIndex = -1;
let pdfStrokesByPage = {};
let pdfShapesByPage = {};
let pdfCurrentStroke = { points: [], color: "#6c5ce7" };
let pdfZoomScale = 1;
let pdfIsDrawing = false;
let currentPdfShareToken = null;
/** Paylaşılan PDF/PPTX linkinde öğrenci şifresiyle açıldıysa true — çizim/yazma kapalı */
let sharedDocReadOnly = false;
let pointerPosition = null;
let currentCanvasShareToken = null;
let canvasRealtimeUnsubscribe = null;
let isCanvasDocument = false;
let canvasPageNum = 1;
let canvasTotalPages = 1;
let canvasStrokesByPage = {};
let localStrokes = [];
let localShapes = [];
let localFillShapes = [];
let localHistoryStack = [];
let localHistoryIndex = -1;
let pdfRealtimeUnsubscribe = null;
let pdfRealtimeBroadcast = null;
let pdfRealtimeBroadcastProgress = null;
let pdfRemoteCurrentStroke = null;
/** Защита от гонок realtime: частичный broadcast (только strokes) не затирает shapes/fills; gen отсекает устаревший decode. */
let pdfRemoteApplyGen = {};
let pdfLastRemoteUpdatedAt = {};
let pptxRemoteApplyGen = {};
let pptxLastRemoteUpdatedAt = {};
let canvasRealtimeBroadcastProgress = null;
let canvasRemoteCurrentStroke = null;
let lastCanvasBroadcastProgress = 0;
let lastGestureBroadcastProgress = 0;
let lastEraseEndTime = 0;
let fadeAnimationRaf = null;
/** Ограничиваем частоту перерисовки только из-за анимации исчезновения (без троттлинга самого рисования). */
const FADE_REDRAW_MIN_MS = 1000 / 28;
let lastFadeRedrawWallMs = 0;
function savePageStrokes(...args) {
  return _savePageStrokes(...args);
}

function hasActiveFadeStrokes(strokesArr = [], now = Date.now()) {
  return Array.isArray(strokesArr) && strokesArr.some((s) => s?._ts && (now - s._ts) <= FADE_DURATION_MS);
}

function scheduleFadeTick() {
  if (fadeAnimationRaf) return;
  let hadActive = false;
  const tick = () => {
    fadeAnimationRaf = null;
    if (!canvasFadeEnabled) return;
    const now = Date.now();
    let keepAnimating = false;
    if (pdfMode && pdfDrawCanvas) {
      keepAnimating = hasActiveFadeStrokes(pdfStrokes, now);
      if (keepAnimating || hadActive) {
        if (keepAnimating && now - lastFadeRedrawWallMs < FADE_REDRAW_MIN_MS) {
          hadActive = keepAnimating;
          fadeAnimationRaf = requestAnimationFrame(tick);
          return;
        }
        lastFadeRedrawWallMs = now;
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      }
    } else if (pptxMode && pptxDrawCanvas) {
      keepAnimating = hasActiveFadeStrokes(pptxStrokes, now);
      if (keepAnimating || hadActive) {
        if (keepAnimating && now - lastFadeRedrawWallMs < FADE_REDRAW_MIN_MS) {
          hadActive = keepAnimating;
          fadeAnimationRaf = requestAnimationFrame(tick);
          return;
        }
        lastFadeRedrawWallMs = now;
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      }
    } else if (drawCanvas) {
      keepAnimating = hasActiveFadeStrokes(strokes, now);
      if (keepAnimating || hadActive) {
        if (keepAnimating && now - lastFadeRedrawWallMs < FADE_REDRAW_MIN_MS) {
          hadActive = keepAnimating;
          fadeAnimationRaf = requestAnimationFrame(tick);
          return;
        }
        lastFadeRedrawWallMs = now;
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      }
    }
    hadActive = keepAnimating;
    if (keepAnimating) fadeAnimationRaf = requestAnimationFrame(tick);
  };
  fadeAnimationRaf = requestAnimationFrame(tick);
}

// PPTX state
let pptxMode = false;
let pptxViewer = null;
let pptxPageNum = 1;
let pptxTotalPages = 0;
let pptxStrokes = [];
let pptxShapes = [];
let pptxFillShapes = [];
let pptxHistoryStack = [];
let pptxHistoryIndex = -1;
let pptxStrokesByPage = {};
let pptxShapesByPage = {};
let pptxCurrentStroke = { points: [], color: "#6c5ce7" };
let pptxIsDrawing = false;
let pptxShapeInProgress = null;
let pptxAspectRatio = 16 / 9;
let currentPptxShareToken = null;

const OBJECT_COLORS = ["#6c5ce7", "#00cec9", "#ff6b6b", "#ffd93d", "#55efc4", "#74b9ff"];
let objectIdCounter = 0;

function savePdfPageState() {
  if (!pdfDoc) return;
  const pageLayer = clonePageLayer(pdfStrokes, pdfShapes);
  if (pdfCurrentStroke.points.length > 1) pageLayer.strokes.push(cloneStroke(pdfCurrentStroke));
  pageLayer.fillShapes = pdfFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pdfStrokesByPage[pdfPageNum] = pageLayer;
}

async function savePdfStrokesAndBroadcast(pageNum, strokes, skipBroadcast = false) {
  if (!currentPdfShareToken || sharedDocReadOnly) return;
  const sh = pdfStrokesByPage[pdfPageNum]?.shapes ?? pdfShapes;
  const fsh = pdfStrokesByPage[pdfPageNum]?.fillShapes ?? pdfFillShapes;
  const res = await savePageStrokes(currentPdfShareToken, pageNum, strokes, sh, fsh);
  if (res && pdfRealtimeBroadcast && !skipBroadcast) {
    const ts = typeof res === "object" && res.updated_at ? res.updated_at : undefined;
    pdfRealtimeBroadcast(pageNum, strokes, ts);
  }
}

function loadPdfPageState() {
  clearSelectionToolState();
  const saved = pdfStrokesByPage[pdfPageNum];
  pdfStrokes = saved ? (saved.strokes || []).map(cloneStroke) : [];
  pdfShapes = saved ? (saved.shapes || []).map(cloneShape) : [];
  pdfFillShapes = saved?.fillShapes ? saved.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h })) : [];
  pdfCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
  pdfHistoryStack = [];
  pdfHistoryIndex = -1;
  pushPdfHistory();
}

function savePptxPageState() {
  if (!pptxViewer) return;
  const pageLayer = clonePageLayer(pptxStrokes, pptxShapes);
  if (pptxCurrentStroke.points.length > 1) pageLayer.strokes.push(cloneStroke(pptxCurrentStroke));
  pageLayer.fillShapes = pptxFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pptxStrokesByPage[pptxPageNum] = pageLayer;
}

function tryCommitSketchedShapeFromHold(strokesArr, shapesArr, strokeDraft) {
  if (drawShape !== "free") return false;
  const enriched = { ...strokeDraft, opacity: strokeDraft.opacity != null ? strokeDraft.opacity : strokeOpacity };
  const sh = trySnapFreehandToShape(enriched, shapeFill);
  if (!sh) return false;
  shapesArr.push(sh);
  return true;
}

function pushCanvasHistory() {
  const snapshot = {
    strokes: strokes.map(cloneStroke),
    shapes: shapes.map(cloneShape),
    fillShapes: fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }))
  };
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(snapshot);
  if (historyStack.length > 50) { historyStack.shift(); historyIndex--; }
  else historyIndex = historyStack.length - 1;
}

function pushPdfHistory() {
  const snapshot = {
    strokes: pdfStrokes.map(cloneStroke),
    shapes: pdfShapes.map(cloneShape),
    fillShapes: pdfFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }))
  };
  pdfHistoryStack = pdfHistoryStack.slice(0, pdfHistoryIndex + 1);
  pdfHistoryStack.push(snapshot);
  if (pdfHistoryStack.length > 50) pdfHistoryStack.shift();
  else pdfHistoryIndex = pdfHistoryStack.length - 1;
}

function undoCanvas() {
  if (historyStack.length === 0 || historyIndex < 0) return;
  historyIndex--;
  const s = historyStack[historyIndex];
  strokes = s.strokes.map(cloneStroke);
  shapes = s.shapes.map(cloneShape);
  fillShapes = s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  currentStroke = { points: [], color: drawColor };
  if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
}

function redoCanvas() {
  if (historyStack.length === 0 || historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  const s = historyStack[historyIndex];
  strokes = s.strokes.map(cloneStroke);
  shapes = s.shapes.map(cloneShape);
  fillShapes = s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  currentStroke = { points: [], color: drawColor };
  if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
}

function undoPdf() {
  if (pdfHistoryStack.length === 0 || pdfHistoryIndex < 0) return;
  pdfHistoryIndex--;
  const s = pdfHistoryStack[pdfHistoryIndex];
  pdfStrokes = s.strokes.map(cloneStroke);
  pdfShapes = s.shapes.map(cloneShape);
  pdfFillShapes = s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pdfCurrentStroke = { points: [], color: drawColor };
  if (pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
}

function redoPdf() {
  if (pdfHistoryStack.length === 0 || pdfHistoryIndex >= pdfHistoryStack.length - 1) return;
  pdfHistoryIndex++;
  const s = pdfHistoryStack[pdfHistoryIndex];
  pdfStrokes = s.strokes.map(cloneStroke);
  pdfShapes = s.shapes.map(cloneShape);
  pdfFillShapes = s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pdfCurrentStroke = { points: [], color: drawColor };
  if (pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
}

function pushPptxHistory() {
  const snapshot = {
    strokes: pptxStrokes.map(cloneStroke),
    shapes: pptxShapes.map(cloneShape),
    fillShapes: pptxFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }))
  };
  pptxHistoryStack = pptxHistoryStack.slice(0, pptxHistoryIndex + 1);
  pptxHistoryStack.push(snapshot);
  if (pptxHistoryStack.length > 50) pptxHistoryStack.shift();
  else pptxHistoryIndex = pptxHistoryStack.length - 1;
}

function undoPptx() {
  if (pptxHistoryStack.length === 0 || pptxHistoryIndex < 0) return;
  pptxHistoryIndex--;
  const s = pptxHistoryStack[pptxHistoryIndex];
  pptxStrokes = s.strokes.map(cloneStroke);
  pptxShapes = s.shapes.map(cloneShape);
  pptxFillShapes = (s.fillShapes || []).map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pptxCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
  if (pptxDrawCanvas) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
}

function redoPptx() {
  if (pptxHistoryStack.length === 0 || pptxHistoryIndex >= pptxHistoryStack.length - 1) return;
  pptxHistoryIndex++;
  const s = pptxHistoryStack[pptxHistoryIndex];
  pptxStrokes = s.strokes.map(cloneStroke);
  pptxShapes = s.shapes.map(cloneShape);
  pptxFillShapes = (s.fillShapes || []).map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  pptxCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
  if (pptxDrawCanvas) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
}

function syncCurrentDocumentPageState() {
  if (pdfMode && pdfDoc) {
    const layer = clonePageLayer(pdfStrokes, pdfShapes);
    layer.fillShapes = pdfFillShapes.map((f) => ({
      data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h),
      w: f.w,
      h: f.h,
    }));
    pdfStrokesByPage[pdfPageNum] = layer;
  } else if (pptxMode && pptxViewer) {
    const pageLayer = clonePageLayer(pptxStrokes, pptxShapes);
    pageLayer.fillShapes = pptxFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
    pptxStrokesByPage[pptxPageNum] = pageLayer;
  }
}

function loadPptxPageState() {
  clearSelectionToolState();
  const saved = pptxStrokesByPage[pptxPageNum];
  pptxStrokes = saved ? (saved.strokes || []).map(cloneStroke) : [];
  pptxShapes = saved ? (saved.shapes || []).map(cloneShape) : [];
  pptxFillShapes = saved?.fillShapes ? saved.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h })) : [];
  pptxCurrentStroke = { points: [], color: drawColor, lineWidth: drawLineWidth };
  pptxHistoryStack = [];
  pptxHistoryIndex = -1;
  pushPptxHistory();
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

function normToClient(normX, normY, w, h) {
  const px = MIRROR_CAMERA ? (1 - normX) * w : normX * w;
  const py = normY * h;
  const rect = (pdfMode && pdfDrawCanvas)
    ? pdfDrawCanvas.getBoundingClientRect()
    : (pptxMode && pptxDrawCanvas)
      ? pptxDrawCanvas.getBoundingClientRect()
      : (drawCanvas || output).getBoundingClientRect();
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
  const check = (el) => el && (() => { const r = el.getBoundingClientRect(); return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom; })();
  if (check(drawToolbar)) return true;
  if (colorPopover?.classList.contains("visible") && check(colorPopover)) return true;
  if (figuresPopover?.classList.contains("visible") && check(figuresPopover)) return true;
  const thicknessPopover = document.getElementById("thicknessPopover");
  const opacityPopover = document.getElementById("opacityPopover");
  if (thicknessPopover?.classList.contains("visible") && check(thicknessPopover)) return true;
  if (opacityPopover?.classList.contains("visible") && check(opacityPopover)) return true;
  return false;
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
        const pt = toPx({ x: t.x, y: t.y }, w, h, MIRROR_CAMERA);
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
    const pt = toPx({ x: obj.x, y: obj.y }, w, h, MIRROR_CAMERA);
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

function drawStrokeWithTool(ctx, stroke, sx, h) {
  const pts = smoothStrokePoints(stroke.points || stroke);
  const c = stroke.color || drawColor;
  const lw = stroke.lineWidth ?? drawLineWidth ?? 4;
  const opacity = stroke.opacity ?? 1;
  if (pts.length < 2) return;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(sx(pts[0].x), pts[0].y * h);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i].x), pts[i].y * h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = hexToRgba(c, opacity);
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.restore();
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

function doFloodFill(ctx, x, y, fillColor, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const idx = (Math.floor(y) * w + Math.floor(x)) * 4;
  const [sr, sg, sb] = [data[idx], data[idx + 1], data[idx + 2]];
  const [fr, fg, fb] = parseHex(fillColor);
  const stack = [[Math.floor(x), Math.floor(y)]];
  const seen = new Set();
  const key = (a, b) => b * w + a;
  let n = 0;
  const maxN = w * h;
  while (stack.length && n < maxN) {
    const [px, py] = stack.pop();
    if (px < 0 || px >= w || py < 0 || py >= h || seen.has(key(px, py))) continue;
    const i = (py * w + px) * 4;
    if (!colorMatch([data[i], data[i + 1], data[i + 2]], [sr, sg, sb])) continue;
    seen.add(key(px, py));
    data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
    n++;
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1], [px + 1, py + 1], [px - 1, py - 1], [px + 1, py - 1], [px - 1, py + 1]);
  }
  ctx.putImageData(img, 0, 0);
  return n;
}

function renderToTempForFill(ctx, w, h, opts) {
  const { strokes: st = strokes, shapes: sh = shapes, currentStroke: cs } = opts;
  const sx = (x) => (MIRROR_CAMERA ? (1 - x) * w : x * w);
  const defLw = drawLineWidth || 4;
  ctx.fillStyle = canvasBackgroundColor;
  ctx.fillRect(0, 0, w, h);
  fillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    ctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
  });
  sh.forEach((s) => {
    if (s.type === "image") return;
    const c = s.color || drawColor;
    const lw = s.lineWidth ?? defLw;
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.type === "circle") {
      ctx.beginPath();
      ctx.arc(sx(s.cx), s.cy * h, s.r * Math.min(w, h), 0, Math.PI * 2);
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "rect") {
      const rx = Math.min(sx(s.x), sx(s.x + s.w));
      const ry = Math.min(s.y, s.y + s.h) * h;
      const rw = Math.abs(s.w) * w, rh = Math.abs(s.h) * h;
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4); ctx.fillRect(rx, ry, rw, rh); }
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (s.type === "line") {
      ctx.beginPath();
      ctx.moveTo(sx(s.x1), s.y1 * h);
      ctx.lineTo(sx(s.x2), s.y2 * h);
      ctx.stroke();
    } else if (s.type === "ellipse") {
      const cx = sx(s.x + s.w / 2), cy = (s.y + s.h / 2) * h;
      ctx.beginPath();
      ctx.ellipse(cx, cy, (s.w / 2) * w, (s.h / 2) * h, 0, 0, Math.PI * 2);
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "triangle") {
      ctx.beginPath();
      ctx.moveTo(sx(s.x1), s.y1 * h);
      ctx.lineTo(sx(s.x2), s.y2 * h);
      ctx.lineTo(sx(s.x3), s.y3 * h);
      ctx.closePath();
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "arrow") {
      const x1 = sx(s.x1), y1 = s.y1 * h, x2 = sx(s.x2), y2 = s.y2 * h;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const al = Math.min(len * 0.3, 20);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.moveTo(x2 - ux * al + uy * al * 0.4, y2 - uy * al - ux * al * 0.4);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - ux * al - uy * al * 0.4, y2 - uy * al + ux * al * 0.4);
      ctx.stroke();
    } else if (s.type === "text" && s.text) {
      ctx.fillStyle = hexToRgba(c, s.opacity ?? 1);
      ctx.font = `${s.fontSize || 24}px sans-serif`;
      ctx.fillText(s.text, sx(s.x), s.y * h);
    }
  });
  const allSt = [...st, cs?.points?.length > 0 ? cs : null].filter(Boolean);
  allSt.forEach((stroke) => drawStrokeWithTool(ctx, stroke, sx, h));
  sh.forEach((s) => {
    if (s.type === "image") drawPlacedImageShape(ctx, s, w, h, sx);
  });
}

function doFillAtCanvas(px, py, w, h) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  renderToTempForFill(tctx, w, h, { currentStroke });
  const before = tctx.getImageData(0, 0, w, h);
  const n = doFloodFill(tctx, px, py, drawColor, w, h);
  if (n === 0) return;
  const after = tctx.getImageData(0, 0, w, h);
  const [fr, fg, fb] = parseHex(drawColor);
  const fd = tctx.createImageData(w, h);
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2]) {
      fd.data[i] = fr; fd.data[i + 1] = fg; fd.data[i + 2] = fb; fd.data[i + 3] = 255;
    }
  }
  fillShapes.push({ data: fd, w, h });
  pushCanvasHistory();
}

function renderPdfToTempForFill(ctx, w, h, pdfCanvasEl, opts) {
  const { strokes: st = pdfStrokes, shapes: sh = pdfShapes, currentStroke: cs } = opts;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  pdfFillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    ctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
  });
  const defLw = drawLineWidth || 4;
  sh.forEach((s) => {
    if (s.type === "image") return;
    const c = s.color || drawColor;
    const lw = s.lineWidth ?? defLw;
    const opacity = s.opacity ?? 1;
    ctx.strokeStyle = hexToRgba(c, opacity);
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.type === "circle") {
      ctx.beginPath();
      ctx.arc(s.cx * w, s.cy * h, s.r * Math.min(w, h), 0, Math.PI * 2);
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "rect") {
      const rx = (s.w >= 0 ? s.x : s.x + s.w) * w;
      const ry = (s.h >= 0 ? s.y : s.y + s.h) * h;
      const rw = Math.abs(s.w) * w, rh = Math.abs(s.h) * h;
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fillRect(rx, ry, rw, rh); }
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (s.type === "line") {
      ctx.beginPath();
      ctx.moveTo(s.x1 * w, s.y1 * h);
      ctx.lineTo(s.x2 * w, s.y2 * h);
      ctx.stroke();
    } else if (s.type === "ellipse") {
      const cx = (s.x + s.w / 2) * w, cy = (s.y + s.h / 2) * h;
      ctx.beginPath();
      ctx.ellipse(cx, cy, (s.w / 2) * w, (s.h / 2) * h, 0, 0, Math.PI * 2);
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "triangle") {
      ctx.beginPath();
      ctx.moveTo(s.x1 * w, s.y1 * h);
      ctx.lineTo(s.x2 * w, s.y2 * h);
      ctx.lineTo(s.x3 * w, s.y3 * h);
      ctx.closePath();
      if (s.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
      ctx.stroke();
    } else if (s.type === "arrow") {
      const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const al = Math.min(len * 0.3, 20);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.moveTo(x2 - ux * al + uy * al * 0.4, y2 - uy * al - ux * al * 0.4);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - ux * al - uy * al * 0.4, y2 - uy * al + ux * al * 0.4);
      ctx.stroke();
    } else if (s.type === "text" && s.text) {
      ctx.fillStyle = hexToRgba(c, opacity);
      ctx.font = `${s.fontSize || 24}px sans-serif`;
      ctx.fillText(s.text, s.x * w, s.y * h);
    }
  });
  const allSt = [...st, cs?.points?.length > 0 ? cs : null].filter(Boolean);
  const sxPdf = (x) => x * w;
  allSt.forEach((stroke) => drawStrokeWithTool(ctx, stroke, sxPdf, h));
  sh.forEach((s) => {
    if (s.type === "image") drawPlacedImageShape(ctx, s, w, h, (x) => x * w);
  });
}

function drawShapeToCtx(ctx, sh, w, h, sx) {
  const c = sh.color || drawColor;
  const lw = sh.lineWidth ?? drawLineWidth ?? 4;
  const opacity = sh.opacity ?? 1;
  ctx.strokeStyle = hexToRgba(c, opacity);
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (sh.type === "circle") {
    ctx.beginPath();
    ctx.arc(sx(sh.cx), sh.cy * h, sh.r * Math.min(w, h), 0, Math.PI * 2);
    if (sh.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
    ctx.stroke();
  } else if (sh.type === "rect") {
    const rx = (sh.w >= 0 ? sx(sh.x) : sx(sh.x + sh.w));
    const ry = (sh.h >= 0 ? sh.y : sh.y + sh.h) * h;
    const rw = Math.abs(sh.w) * w, rh = Math.abs(sh.h) * h;
    if (sh.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fillRect(rx, ry, rw, rh); }
    ctx.strokeRect(rx, ry, rw, rh);
  } else if (sh.type === "line") {
    ctx.beginPath();
    ctx.moveTo(sx(sh.x1), sh.y1 * h);
    ctx.lineTo(sx(sh.x2), sh.y2 * h);
    ctx.stroke();
  } else if (sh.type === "ellipse") {
    const cx = sx(sh.x + sh.w / 2), cy = (sh.y + sh.h / 2) * h;
    ctx.beginPath();
    ctx.ellipse(cx, cy, (sh.w / 2) * w, (sh.h / 2) * h, 0, 0, Math.PI * 2);
    if (sh.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
    ctx.stroke();
  } else if (sh.type === "triangle") {
    ctx.beginPath();
    ctx.moveTo(sx(sh.x1), sh.y1 * h);
    ctx.lineTo(sx(sh.x2), sh.y2 * h);
    ctx.lineTo(sx(sh.x3), sh.y3 * h);
    ctx.closePath();
    if (sh.fill) { ctx.fillStyle = hexToRgba(c, 0.4 * opacity); ctx.fill(); }
    ctx.stroke();
  } else if (sh.type === "arrow") {
    const x1 = sx(sh.x1), y1 = sh.y1 * h, x2 = sx(sh.x2), y2 = sh.y2 * h;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const al = Math.min(len * 0.3, 20);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.moveTo(x2 - ux * al + uy * al * 0.4, y2 - uy * al - ux * al * 0.4);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - ux * al - uy * al * 0.4, y2 - uy * al + ux * al * 0.4);
    ctx.stroke();
  } else if (sh.type === "text" && sh.text) {
    ctx.fillStyle = hexToRgba(c, opacity);
    ctx.font = `${sh.fontSize || 24}px sans-serif`;
    ctx.fillText(sh.text, sx(sh.x), sh.y * h);
  } else if (sh.type === "image") {
    drawPlacedImageShape(ctx, sh, w, h, sx);
  }
}

function flattenDarkPixelsForFill(imgData, w, h, seedX, seedY, lumThreshold = 0.35) {
  const d = imgData.data;
  const si = (Math.floor(seedY) * w + Math.floor(seedX)) * 4;
  const [sr, sg, sb] = [d[si], d[si + 1], d[si + 2]];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum < lumThreshold) {
      d[i] = sr; d[i + 1] = sg; d[i + 2] = sb;
    }
  }
}

function doFillAtPdf(px, py, w, h) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  renderPdfToTempForFill(tctx, w, h, pdfCanvas, { currentStroke: pdfCurrentStroke });
  const before = tctx.getImageData(0, 0, w, h);
  const n = doFloodFill(tctx, px, py, drawColor, w, h);
  if (n === 0) return;
  const after = tctx.getImageData(0, 0, w, h);
  const [fr, fg, fb] = parseHex(drawColor);
  const fd = tctx.createImageData(w, h);
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2]) {
      fd.data[i] = fr; fd.data[i + 1] = fg; fd.data[i + 2] = fb; fd.data[i + 3] = 255;
    }
  }
  pdfFillShapes.push({ data: fd, w, h });
  pushPdfHistory();
}

function renderPptxToTempForFill(ctx, w, h, pptxCanvasEl, opts) {
  const { strokes: st = pptxStrokes, shapes: sh = pptxShapes, currentStroke: cs } = opts;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  pptxFillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    ctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
  });
  const sxPptx = (x) => x * w;
  sh.forEach((s) => {
    if (s.type !== "image") drawShapeToCtx(ctx, s, w, h, sxPptx);
  });
  const allSt = [...st, cs?.points?.length > 0 ? cs : null].filter(Boolean);
  allSt.forEach((stroke) => drawStrokeWithTool(ctx, stroke, sxPptx, h));
  sh.forEach((s) => {
    if (s.type === "image") drawPlacedImageShape(ctx, s, w, h, sxPptx);
  });
}

function doFillAtPptx(px, py, w, h) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  renderPptxToTempForFill(tctx, w, h, pptxCanvas, { currentStroke: pptxCurrentStroke });
  const before = tctx.getImageData(0, 0, w, h);
  const n = doFloodFill(tctx, px, py, drawColor, w, h);
  if (n === 0) return;
  const after = tctx.getImageData(0, 0, w, h);
  const [fr, fg, fb] = parseHex(drawColor);
  const fd = tctx.createImageData(w, h);
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2]) {
      fd.data[i] = fr; fd.data[i + 1] = fg; fd.data[i + 2] = fb; fd.data[i + 3] = 255;
    }
  }
  pptxFillShapes.push({ data: fd, w, h });
  pushPptxHistory();
}

// ========== ÇİZİM KATMANI - Modern neon stil ==========
function drawStrokesToCanvas(w, h) {
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, w, h);
  const sx = (x) => (MIRROR_CAMERA ? (1 - x) * w : x * w);

  fillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    dctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
  });

  const defLw = drawLineWidth || 4;

  shapes.forEach((sh) => {
    if (sh.type === "image") return;
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    const fill = !!sh.fill;
    const opacity = sh.opacity ?? 1;
    dctx.strokeStyle = hexToRgba(color, opacity);
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      const cx = sx(sh.cx), cy = sh.cy * h;
      dctx.beginPath();
      dctx.arc(cx, cy, sh.r * Math.min(w, h), 0, Math.PI * 2);
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "rect") {
      const rx = Math.min(sx(sh.x), sx(sh.x + sh.w));
      const ry = Math.min(sh.y, sh.y + sh.h) * h;
      const rw = Math.abs(sh.w) * w, rh = Math.abs(sh.h) * h;
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fillRect(rx, ry, rw, rh); }
      dctx.strokeRect(rx, ry, rw, rh);
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
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "triangle") {
      dctx.beginPath();
      dctx.moveTo(sx(sh.x1), sh.y1 * h);
      dctx.lineTo(sx(sh.x2), sh.y2 * h);
      dctx.lineTo(sx(sh.x3), sh.y3 * h);
      dctx.closePath();
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
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
    } else if (sh.type === "text" && sh.text) {
      dctx.fillStyle = hexToRgba(color, opacity);
      dctx.font = `${sh.fontSize || 24}px sans-serif`;
      dctx.fillText(sh.text, sx(sh.x), sh.y * h);
    }
  });

  // Превью фигуры при pinch+drag (зажать и тянуть по диагонали)
  if (shapeInProgress && drawMode) {
    const sp = shapeInProgress;
    const x1 = Math.min(sp.start.x, sp.end.x), x2 = Math.max(sp.start.x, sp.end.x);
    const y1 = Math.min(sp.start.y, sp.end.y), y2 = Math.max(sp.start.y, sp.end.y);
    const px1 = sx(x1), py1 = y1 * h, px2 = sx(x2), py2 = y2 * h;
    const rw = (x2 - x1) * w, rh = (y2 - y1) * h;
    const rectPx1 = Math.min(sx(sp.start.x), sx(sp.end.x));
    const rectPy1 = Math.min(sp.start.y, sp.end.y) * h;
    const rectRw = Math.abs(sp.end.x - sp.start.x) * w;
    const rectRh = Math.abs(sp.end.y - sp.start.y) * h;
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
      const diagNorm = Math.hypot(sp.end.x - sp.start.x, sp.end.y - sp.start.y);
      const rPx = Math.max((diagNorm / 2) * Math.min(w, h), 4);
      dctx.beginPath();
      dctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sp.type === "rect" || sp.type === "ellipse") {
      if (sp.type === "rect") dctx.strokeRect(rectPx1, rectPy1, rectRw, rectRh);
      else if (sp.type === "ellipse") {
        dctx.beginPath();
        dctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2);
        dctx.stroke();
      }
    } else if (sp.type === "line" || sp.type === "arrow") {
      const x1p = sx(sp.start.x), y1p = sp.start.y * h, x2p = sx(sp.end.x), y2p = sp.end.y * h;
      dctx.beginPath();
      dctx.moveTo(x1p, y1p);
      dctx.lineTo(x2p, y2p);
      dctx.stroke();
      if (sp.type === "arrow") {
        const lenPx = Math.hypot(x2p - x1p, y2p - y1p) || 1;
        const arrowLen = Math.min(lenPx * 0.3, 20);
        const dx = x2p - x1p, dy = y2p - y1p;
        const ux = dx / lenPx, uy = dy / lenPx;
        const ax = x2p - ux * arrowLen + uy * arrowLen * 0.4;
        const ay = y2p - uy * arrowLen - ux * arrowLen * 0.4;
        const bx = x2p - ux * arrowLen - uy * arrowLen * 0.4;
        const by = y2p - uy * arrowLen + ux * arrowLen * 0.4;
        dctx.beginPath();
        dctx.moveTo(ax, ay);
        dctx.lineTo(x2p, y2p);
        dctx.lineTo(bx, by);
        dctx.stroke();
      }
    } else if (sp.type === "triangle") {
      const dx = sp.end.x - sp.start.x, dy = sp.end.y - sp.start.y;
      const len = Math.hypot(dx, dy) || 0.001;
      const mx = (sp.start.x + sp.end.x) / 2, my = (sp.start.y + sp.end.y) / 2;
      const perpLen = len * 0.5;
      const px = mx - (dy / len) * perpLen, py = my + (dx / len) * perpLen;
      dctx.beginPath();
      dctx.moveTo(sx(sp.start.x), sp.start.y * h);
      dctx.lineTo(sx(sp.end.x), sp.end.y * h);
      dctx.lineTo(sx(px), py * h);
      dctx.closePath();
      dctx.stroke();
    } else if (sp.type === "triangle_right") {
      dctx.beginPath();
      dctx.moveTo(sx(sp.end.x), sp.end.y * h);
      dctx.lineTo(sx(sp.start.x), sp.end.y * h);
      dctx.lineTo(sx(sp.end.x), sp.start.y * h);
      dctx.closePath();
      dctx.stroke();
    }
    dctx.setLineDash([]);
  }

  const now = Date.now();
  const allStrokes = [...strokes, currentStroke.points.length > 0 ? currentStroke : null].filter(Boolean);
  allStrokes.forEach((stroke) => {
    if (stroke._ts && canvasFadeEnabled) {
      const age = now - stroke._ts;
      if (age > FADE_DURATION_MS) return;
      const fadeAlpha = Math.max(0, 1 - age / FADE_DURATION_MS);
      dctx.save();
      dctx.globalAlpha = fadeAlpha;
      drawStrokeWithTool(dctx, stroke, sx, h);
      dctx.restore();
    } else {
      drawStrokeWithTool(dctx, stroke, sx, h);
    }
  });

  shapes.forEach((sh) => {
    if (sh.type === "image") drawPlacedImageShape(dctx, sh, w, h, sx);
  });

  if (currentCanvasShareToken && canvasRemoteCurrentStroke?.points?.length >= 2) {
    drawStrokeWithTool(dctx, canvasRemoteCurrentStroke, sx, h);
  }

  if (canvasFadeEnabled) {
    strokes = strokes.filter(s => !s._ts || (now - s._ts) <= FADE_DURATION_MS);
    if (hasActiveFadeStrokes(strokes, now)) scheduleFadeTick();
  }

  drawSelectOverlay(dctx, w, h, sx);

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
  const next = eraseLayerAtPosition(strokes, shapes, eraseX, eraseY, radius, fillShapes, drawColor, drawLineWidth);
  strokes = next.strokes;
  shapes = next.shapes;
  fillShapes = next.fillShapes || fillShapes;
}
function erasePdfAtPosition(eraseX, eraseY, radius = 0.07) {
  const next = eraseLayerAtPosition(pdfStrokes, pdfShapes, eraseX, eraseY, radius, pdfFillShapes, drawColor, drawLineWidth);
  pdfStrokes = next.strokes;
  pdfShapes = next.shapes;
  pdfFillShapes = next.fillShapes || pdfFillShapes;
}
function erasePptxAtPosition(eraseX, eraseY, radius = 0.07) {
  const next = eraseLayerAtPosition(pptxStrokes, pptxShapes, eraseX, eraseY, radius, pptxFillShapes, drawColor, drawLineWidth);
  pptxStrokes = next.strokes;
  pptxShapes = next.shapes;
  pptxFillShapes = next.fillShapes || pptxFillShapes;
}

function clearSelectionToolState() {
  selectMarqueeNorm = null;
  selectState = null;
  selectDragging = false;
  selectDragAnchor = null;
  selectImageResizing = false;
  selectImageResizeStart = null;
  cachedOffHandLandmark = null;
  selectScaleLastZ = null;
  selectScaleZSmooth = null;
  selectScaleGateMissFrames = 0;
}

function applyGestureToolModeCycle() {
  if (sharedDocReadOnly) return;
  let phase = 0;
  if (drawShape === "select") phase = 2;
  else if (canvasFadeEnabled) phase = 1;
  else phase = 0;
  const next = (phase + 1) % 3;
  const ft = document.getElementById("fadeToggle");
  if (next === 0) {
    canvasFadeEnabled = false;
    if (ft) ft.checked = false;
    drawShape = "free";
    eraserMode = false;
    clearSelectionToolState();
    setActiveToolOnly("pen");
  } else if (next === 1) {
    canvasFadeEnabled = true;
    if (ft) ft.checked = true;
    drawShape = "free";
    eraserMode = false;
    clearSelectionToolState();
    setActiveToolOnly("pen");
    scheduleFadeTick();
  } else {
    canvasFadeEnabled = false;
    if (ft) ft.checked = false;
    drawShape = "select";
    eraserMode = false;
    clearSelectionToolState();
    setActiveToolOnly("select");
    colorPopover?.classList.remove("visible");
    figuresPopover?.classList.remove("visible");
    thicknessPopover?.classList.remove("visible");
    opacityPopover?.classList.remove("visible");
  }
  if (pdfMode && pdfDoc && pdfDrawCanvas?.width)
    drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  else if (pptxMode && pptxViewer && pptxDrawCanvas?.width)
    drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
  else if (drawCanvas?.width) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  const label =
    drawShape === "select" ? "Taşı / seç" : canvasFadeEnabled ? "Silinen kalem" : "Kalem";
  showGestureModeHint(`Mod: ${label}`);
}

function showGestureModeHint(message) {
  let el = document.getElementById("gestureModeHint");
  if (!el) {
    el = document.createElement("div");
    el.id = "gestureModeHint";
    el.setAttribute("aria-live", "polite");
    el.className = "gesture-mode-hint";
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "99999",
      left: "50%",
      bottom: "max(1.1rem, env(safe-area-inset-bottom, 0px))",
      transform: "translateX(-50%)",
      maxWidth: "min(92vw, 22rem)",
      padding: "0.55rem 1rem",
      borderRadius: "12px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "0.95rem",
      fontWeight: "600",
      color: "#fafafa",
      background: "rgba(18, 18, 22, 0.9)",
      border: "1px solid rgba(255,255,255,0.12)",
      boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
      pointerEvents: "none",
      textAlign: "center",
    });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = "1";
  el.removeAttribute("hidden");
  if (el._gestureHintHide1) clearTimeout(el._gestureHintHide1);
  if (el._gestureHintHide2) clearTimeout(el._gestureHintHide2);
  el._gestureHintHide1 = setTimeout(() => {
    el.style.opacity = "0";
    el._gestureHintHide2 = setTimeout(() => {
      el.textContent = "";
      el.setAttribute("hidden", "");
    }, 200);
  }, 2400);
}

function clearMiddleThumbGestureTimer() {
  if (middleThumbGestureTimer != null) {
    clearTimeout(middleThumbGestureTimer);
    middleThumbGestureTimer = null;
  }
}

function handleMiddleThumbTapRisingEdge(nowMs) {
  clearMiddleThumbGestureTimer();
  middleThumbTapTimes = middleThumbTapTimes.filter((t) => nowMs - t <= MIDDLE_THUMB_SEQUENCE_WINDOW_MS);
  const last = middleThumbTapTimes[middleThumbTapTimes.length - 1];
  if (last && nowMs - last < MIDDLE_THUMB_MIN_TAP_INTERVAL_MS) return;
  middleThumbTapTimes.push(nowMs);
  if (middleThumbTapTimes.length >= 3) {
    middleThumbTapTimes = [];
    applyGestureRedPen();
    gestureModeCycleCooldownUntil = nowMs + GESTURE_MODE_CYCLE_COOLDOWN_MS;
    return;
  }
  if (middleThumbTapTimes.length === 2) {
    const firstGapMs = Math.max(
      MIDDLE_THUMB_MIN_TAP_INTERVAL_MS,
      middleThumbTapTimes[1] - middleThumbTapTimes[0]
    );
    const adaptiveWaitMs = Math.max(
      MIDDLE_THUMB_DOUBLE_WAIT_MS_MIN,
      Math.min(MIDDLE_THUMB_DOUBLE_WAIT_MS_MAX, Math.round(firstGapMs * MIDDLE_THUMB_DOUBLE_WAIT_FACTOR))
    );
    middleThumbGestureTimer = window.setTimeout(() => {
      middleThumbGestureTimer = null;
      middleThumbTapTimes = [];
      applyGestureToolModeCycle();
      gestureModeCycleCooldownUntil = performance.now() + GESTURE_MODE_CYCLE_COOLDOWN_MS;
    }, adaptiveWaitMs);
    return;
  }
  middleThumbGestureTimer = window.setTimeout(() => {
    middleThumbGestureTimer = null;
    middleThumbTapTimes = [];
  }, MIDDLE_THUMB_SINGLE_STALE_MS);
}

function applyGestureRedPen() {
  if (sharedDocReadOnly) return;
  const red = GESTURE_RED_PEN_HEX;
  if (typeof hexToHsv === "function") {
    const hv = hexToHsv(red);
    colorWheelHue = hv.h;
    colorWheelSat = hv.s;
    colorWheelVal = hv.v;
  }
  if (typeof window.applyColorFromWheel === "function") {
    window.applyColorFromWheel();
  } else {
    drawColor = red;
    if (toolbarColor) toolbarColor.value = drawColor;
    if (colorWheelPreview) colorWheelPreview.style.background = drawColor;
    document.querySelectorAll(".color-preset").forEach((b) => b.classList.remove("active"));
    if (pdfMode && pdfDoc) pdfCurrentStroke.color = drawColor;
    else if (pptxMode && pptxViewer) pptxCurrentStroke.color = drawColor;
    else currentStroke.color = drawColor;
    if (typeof updateThicknessOpacityPreviews === "function") updateThicknessOpacityPreviews();
  }
  showGestureModeHint("Kalem rengi: kırmızı");
}

function drawSelectOverlay(dctx, w, h, sx) {
  const hasSel = selectState && (selectState.strokeIdx.length || selectState.shapeIdx.length);
  if (drawShape !== "select" && !selectMarqueeNorm && !hasSel) return;
  let strokesArr, shapesArr;
  if (pdfMode && pdfDoc) { strokesArr = pdfStrokes; shapesArr = pdfShapes; }
  else if (pptxMode && pptxViewer) { strokesArr = pptxStrokes; shapesArr = pptxShapes; }
  else if (!pdfMode && !pptxMode) { strokesArr = strokes; shapesArr = shapes; }
  else return;
  dctx.save();
  dctx.setLineDash([6, 4]);
  dctx.lineWidth = 2;
  if (selectMarqueeNorm) {
    const m = selectMarqueeNorm;
    const r = screenRectFromNormMarquee(m.x0, m.y0, m.x1, m.y1, w, h, sx);
    dctx.strokeStyle = "rgba(108, 92, 231, 0.95)";
    dctx.strokeRect(r.left, r.top, r.rw, r.rh);
  }
  if (hasSel) {
    const ub = selectionUnionBBoxFromSel(selectState, strokesArr, shapesArr);
    if (ub && (ub.x1 > ub.x0) && (ub.y1 > ub.y0)) {
      const r = screenRectFromNormMarquee(ub.x0, ub.y0, ub.x1, ub.y1, w, h, sx);
      dctx.strokeStyle = "rgba(0, 122, 255, 0.9)";
      dctx.strokeRect(r.left, r.top, r.rw, r.rh);
    }
    const imgSel = getSingleSelectedPlacedImage(selectState, shapesArr);
    if (imgSel) {
      const sh = imgSel.sh;
      const ir = screenRectFromNormMarquee(sh.x, sh.y, sh.x + sh.w, sh.y + sh.h, w, h, sx);
      dctx.setLineDash([]);
      dctx.lineWidth = 1.25;
      dctx.fillStyle = "#fff";
      dctx.strokeStyle = "rgba(0, 122, 255, 0.95)";
      const hs = 5;
      const cxcy = [
        [ir.left, ir.top],
        [ir.left + ir.rw / 2, ir.top],
        [ir.left + ir.rw, ir.top],
        [ir.left + ir.rw, ir.top + ir.rh / 2],
        [ir.left + ir.rw, ir.top + ir.rh],
        [ir.left + ir.rw / 2, ir.top + ir.rh],
        [ir.left, ir.top + ir.rh],
        [ir.left, ir.top + ir.rh / 2],
      ];
      for (const [cx, cy] of cxcy) {
        dctx.beginPath();
        dctx.rect(cx - hs, cy - hs, hs * 2, hs * 2);
        dctx.fill();
        dctx.stroke();
      }
    }
  }
  dctx.setLineDash([]);
  dctx.restore();
}

function selectPointerButtonDown(e) {
  if (e.touches && e.touches.length > 0) return true;
  if (typeof e.buttons === "number") return (e.buttons & 1) !== 0;
  return true;
}

function finalizeSelectGestureEnd() {
  if (drawShape !== "select") return;
  const strokesArr = pdfMode && pdfDoc ? pdfStrokes : (pptxMode && pptxViewer ? pptxStrokes : strokes);
  const shapesArr = pdfMode && pdfDoc ? pdfShapes : (pptxMode && pptxViewer ? pptxShapes : shapes);
  if (selectImageResizing && selectState) {
    selectImageResizing = false;
    selectImageResizeStart = null;
    selectScaleLastZ = null;
    selectScaleZSmooth = null;
    selectScaleGateMissFrames = 0;
    if (pdfMode && pdfDoc) {
      pushPdfHistory();
      savePdfPageState();
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
    } else if (pptxMode && pptxViewer) {
      pushPptxHistory();
      if (currentPptxShareToken) {
        savePptxPageState();
        savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      }
    } else {
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) {
        savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      }
    }
  } else if (selectDragging && selectState) {
    selectDragging = false;
    selectDragAnchor = null;
    selectScaleLastZ = null;
    selectScaleZSmooth = null;
    selectScaleGateMissFrames = 0;
    if (pdfMode && pdfDoc) {
      pushPdfHistory();
      savePdfPageState();
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
    } else if (pptxMode && pptxViewer) {
      pushPptxHistory();
      if (currentPptxShareToken) {
        savePptxPageState();
        savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      }
    } else {
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) {
        savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      }
    }
  } else if (selectMarqueeNorm) {
    const m = selectMarqueeNorm;
    const wN = Math.abs(m.x1 - m.x0), hN = Math.abs(m.y1 - m.y0);
    if (wN >= MIN_SELECT_NORM || hN >= MIN_SELECT_NORM) {
      const rect = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
      const picked = pickSelectionInRect(rect, strokesArr, shapesArr);
      selectState = picked.strokeIdx.length || picked.shapeIdx.length ? picked : null;
    } else selectState = null;
    selectMarqueeNorm = null;
  }
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
  const fadeWrap = document.getElementById("fadeToggleWrap");
  if (fadeWrap) {
    fadeWrap.style.display = (whiteSheetMode || pdfMode || pptxMode) ? "flex" : "none";
  }
}

function updateHeaderTitle() {
  const text = pdfMode ? "DrawFlow — PDF" : "DrawFlow";
  if (appHeaderTitle) appHeaderTitle.textContent = text;
  document.title = text;
}

function isCanvasFullscreenMode() {
  const app = document.querySelector(".app");
  return !!(
    app?.classList.contains("canvas-fullscreen") ||
    (document.fullscreenElement && document.fullscreenElement === app)
  );
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
  const fs = isCanvasFullscreenMode();
  const portraitPdf = viewport.height > viewport.width;
  const section = pdfContainer?.closest(".camera-section");
  const sectionW = Math.max(200, section?.clientWidth || maxW);
  let baseScale;
  if (fs) {
    const fitW = maxW / viewport.width;
    const fitH = maxH / viewport.height;
    baseScale = Math.min(fitW, fitH);
  } else if (portraitPdf) {
    const fitW = maxW / viewport.width;
    const fitH = maxH / viewport.height;
    baseScale = Math.min(fitW, fitH);
  } else {
    baseScale = sectionW / viewport.width;
  }
  baseScale = Math.max(0.1, baseScale);
  const scale = baseScale * pdfZoomScale;
  const scaledViewport = page.getViewport({ scale });
  const w = Math.floor(scaledViewport.width);
  const h = Math.floor(scaledViewport.height);
  if (cameraWrapper) {
    cameraWrapper.style.width = "";
    cameraWrapper.style.height = "";
    cameraWrapper.style.maxWidth = "";
    cameraWrapper.classList.toggle("pdf-landscape-fit", !fs && !portraitPdf);
  }
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
  pdfFillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    dctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
  });
  const defLw = drawLineWidth || 4;
  pdfShapes.forEach((sh) => {
    if (sh.type === "image") return;
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    const fill = !!sh.fill;
    const opacity = sh.opacity ?? 1;
    dctx.strokeStyle = hexToRgba(color, opacity);
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      dctx.beginPath();
      dctx.arc(sh.cx * w, sh.cy * h, sh.r * Math.min(w, h), 0, Math.PI * 2);
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "rect") {
      const rx = (sh.w >= 0 ? sh.x : sh.x + sh.w) * w;
      const ry = (sh.h >= 0 ? sh.y : sh.y + sh.h) * h;
      const rw = Math.abs(sh.w) * w, rh = Math.abs(sh.h) * h;
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fillRect(rx, ry, rw, rh); }
      dctx.strokeRect(rx, ry, rw, rh);
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
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "triangle") {
      dctx.beginPath();
      dctx.moveTo(sh.x1 * w, sh.y1 * h);
      dctx.lineTo(sh.x2 * w, sh.y2 * h);
      dctx.lineTo(sh.x3 * w, sh.y3 * h);
      dctx.closePath();
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
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
    } else if (sh.type === "text" && sh.text) {
      dctx.fillStyle = hexToRgba(color, opacity);
      dctx.font = `${sh.fontSize || 24}px sans-serif`;
      dctx.fillText(sh.text, sh.x * w, sh.y * h);
    }
  });
  if (pdfShapeInProgress && pdfMode) {
    const sp = pdfShapeInProgress;
    const x1 = Math.min(sp.start.x, sp.end.x), x2 = Math.max(sp.start.x, sp.end.x);
    const y1 = Math.min(sp.start.y, sp.end.y), y2 = Math.max(sp.start.y, sp.end.y);
    const px1 = x1 * w, py1 = y1 * h, rw = (x2 - x1) * w, rh = (y2 - y1) * h;
    const rectPx1 = Math.min(sp.start.x, sp.end.x) * w;
    const rectPy1 = Math.min(sp.start.y, sp.end.y) * h;
    const rectRw = Math.abs(sp.end.x - sp.start.x) * w;
    const rectRh = Math.abs(sp.end.y - sp.start.y) * h;
    const cx = px1 + rw / 2, cy = py1 + rh / 2;
    dctx.strokeStyle = drawColor;
    dctx.lineWidth = 2;
    dctx.setLineDash([6, 4]);
    if (sp.type === "circle") {
      const diagNorm = Math.hypot(sp.end.x - sp.start.x, sp.end.y - sp.start.y);
      const rPx = Math.max((diagNorm / 2) * Math.min(w, h), 4);
      dctx.beginPath();
      dctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sp.type === "rect" || sp.type === "ellipse") {
      if (sp.type === "rect") dctx.strokeRect(rectPx1, rectPy1, rectRw, rectRh);
      else { dctx.beginPath(); dctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2); dctx.stroke(); }
    } else if (sp.type === "line" || sp.type === "arrow") {
      const x1p = sp.start.x * w, y1p = sp.start.y * h, x2p = sp.end.x * w, y2p = sp.end.y * h;
      dctx.beginPath();
      dctx.moveTo(x1p, y1p);
      dctx.lineTo(x2p, y2p);
      dctx.stroke();
      if (sp.type === "arrow") {
        const lenPx = Math.hypot(x2p - x1p, y2p - y1p) || 1;
        const arrowLen = Math.min(lenPx * 0.3, 20);
        const dx = x2p - x1p, dy = y2p - y1p;
        const ux = dx / lenPx, uy = dy / lenPx;
        const ax = x2p - ux * arrowLen + uy * arrowLen * 0.4;
        const ay = y2p - uy * arrowLen - ux * arrowLen * 0.4;
        const bx = x2p - ux * arrowLen - uy * arrowLen * 0.4;
        const by = y2p - uy * arrowLen + ux * arrowLen * 0.4;
        dctx.beginPath();
        dctx.moveTo(ax, ay);
        dctx.lineTo(x2p, y2p);
        dctx.lineTo(bx, by);
        dctx.stroke();
      }
    } else if (sp.type === "triangle") {
      const dx = sp.end.x - sp.start.x, dy = sp.end.y - sp.start.y;
      const len = Math.hypot(dx, dy) || 0.001;
      const mx = (sp.start.x + sp.end.x) / 2, my = (sp.start.y + sp.end.y) / 2;
      const perpLen = len * 0.5;
      const px = mx - (dy / len) * perpLen, py = my + (dx / len) * perpLen;
      dctx.beginPath();
      dctx.moveTo(sp.start.x * w, sp.start.y * h);
      dctx.lineTo(sp.end.x * w, sp.end.y * h);
      dctx.lineTo(px * w, py * h);
      dctx.closePath();
      dctx.stroke();
    } else if (sp.type === "triangle_right") {
      dctx.beginPath();
      dctx.moveTo(sp.end.x * w, sp.end.y * h);
      dctx.lineTo(sp.start.x * w, sp.end.y * h);
      dctx.lineTo(sp.end.x * w, sp.start.y * h);
      dctx.closePath();
      dctx.stroke();
    }
    dctx.setLineDash([]);
  }
  const allStrokes = [...pdfStrokes, pdfCurrentStroke.points.length > 0 ? pdfCurrentStroke : null].filter(Boolean);
  const sxPdf = (x) => x * w;
  const now = Date.now();
  allStrokes.forEach((stroke) => {
    if (stroke._ts && canvasFadeEnabled) {
      const age = now - stroke._ts;
      if (age > FADE_DURATION_MS) return;
      const fadeAlpha = Math.max(0, 1 - age / FADE_DURATION_MS);
      dctx.save();
      dctx.globalAlpha = fadeAlpha;
      drawStrokeWithTool(dctx, stroke, sxPdf, h);
      dctx.restore();
    } else {
      drawStrokeWithTool(dctx, stroke, sxPdf, h);
    }
  });
  pdfShapes.forEach((sh) => {
    if (sh.type === "image") drawPlacedImageShape(dctx, sh, w, h, (x) => x * w);
  });
  if (canvasFadeEnabled) {
    pdfStrokes = pdfStrokes.filter(s => !s._ts || (now - s._ts) <= FADE_DURATION_MS);
    if (hasActiveFadeStrokes(pdfStrokes, now)) scheduleFadeTick();
  }
  if (pdfRemoteCurrentStroke?.points?.length >= 2) {
    drawStrokeWithTool(dctx, pdfRemoteCurrentStroke, sxPdf, h);
  }
  drawSelectOverlay(dctx, w, h, sxPdf);
  drawCursorDot(dctx, w, h, true);
  drawPointerOnCanvas(pdfDrawCanvas);
}

function drawPointerOnCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx || !pointerPosition) return;
  const x = pointerPosition.x * canvas.width;
  const y = pointerPosition.y * canvas.height;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 68, 68, 0.35)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#FF4444";
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function applySharedDocViewerMode(on) {
  sharedDocReadOnly = !!on;
  document.body.classList.toggle("shared-doc-viewer", on);
  if (on) {
    drawMode = false;
    drawBtn?.classList.remove("active");
    if (pdfDrawCanvas) {
      pdfDrawCanvas.style.pointerEvents = "none";
      pdfDrawCanvas.style.cursor = "default";
    }
    if (pptxDrawCanvas) {
      pptxDrawCanvas.style.pointerEvents = "none";
      pptxDrawCanvas.style.cursor = "default";
    }
    setTimeout(() => {
      if (!document.fullscreenElement) toggleCanvasFullscreen();
    }, 450);
  } else {
    if (pdfDrawCanvas && pdfMode) {
      pdfDrawCanvas.style.pointerEvents = "auto";
      pdfDrawCanvas.style.cursor = "crosshair";
    }
    if (pptxDrawCanvas && pptxMode) {
      pptxDrawCanvas.style.pointerEvents = "auto";
      pptxDrawCanvas.style.cursor = "crosshair";
    }
  }
  const imgIn = document.getElementById("imageImportInput");
  if (imgIn) imgIn.disabled = on;
}

async function loadPdfFromShareToken(shareToken, password = null) {
  if (!shareToken || !supabase) return false;
  try {
    const { data, error } = await supabase.rpc("get_pdf_by_share_token", { token: shareToken, pwd: password || null });
    if (error) throw new Error("PDF bulunamadı");
    const row = data?.[0];
    if (!row) throw new Error("PDF bulunamadı");
    if (row.needs_password === true) {
      return { needsPassword: true };
    }
    const accessMode = row.access_mode || "editor";
    const storagePath = row.storage_path;
    if (!storagePath) throw new Error("PDF bulunamadı");
    const { data: urlData } = supabase.storage.from("pdfs").getPublicUrl(storagePath);
    const pdfUrl = urlData?.publicUrl;
    if (!pdfUrl) throw new Error("PDF URL alınamadı");
    pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
    currentPdfShareToken = shareToken;
    pdfTotalPages = pdfDoc.numPages;
    pdfPageNum = 1;
    pdfStrokesByPage = {};
    pdfShapesByPage = {};
    pdfFillShapes = [];
    pdfStrokes = [];
    pdfShapes = [];
    pdfCurrentStroke = { points: [], color: drawColor };
    const pages = await fetchStrokes(shareToken);
    if (pages?.length) {
      for (const row of pages) {
        const p = row.page_num;
        if (!pdfStrokesByPage[p]) pdfStrokesByPage[p] = { strokes: [], shapes: [], fillShapes: [] };
        for (const s of row.strokes || []) {
          pdfStrokesByPage[p].strokes.push({
            points: s.points || [],
            color: s.color || drawColor,
            lineWidth: s.lineWidth ?? drawLineWidth,
          });
        }
        pdfStrokesByPage[p].shapes = (row.shapes || []).map(cloneShape);
        pdfStrokesByPage[p].fillShapes = await deserializeFillShapes(row.fill_shapes || []);
      }
    }
    if (cameraWrapper) cameraWrapper.classList.add("pdf-loaded");
    if (pdfPageInfo) pdfPageInfo.textContent = `1 / ${pdfTotalPages}`;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pdfTotalPages <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = pdfTotalPages <= 1;
    if (pdfClearBtn) pdfClearBtn.disabled = false;
    if (drawBtn) drawBtn.disabled = false;
    if (clearDrawBtn) clearDrawBtn.disabled = false;
    const base = getShareBaseUrl();
    const pdfLink = `${base}/index.html?id=${shareToken}`;
    if (pdfLinkBtn) {
      pdfLinkBtn.dataset.link = pdfLink;
      pdfLinkBtn.style.display = "inline-flex";
    }
    const exportBtn = document.getElementById("exportDocBtn");
    if (exportBtn) exportBtn.style.display = "inline-flex";
    if (canvasLinkBtn) canvasLinkBtn.style.display = "none";
    if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
    if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
    pdfMode = true;
    whiteSheetMode = false;
    blackSheetMode = false;
    pptxMode = false;
    cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pptx-mode", "pptx-loaded");
    cameraWrapper?.classList.add("pdf-mode");
    if (pdfNavGroup) pdfNavGroup.style.display = "flex";
    const pdfZoomGroup = document.getElementById("pdfZoomGroup");
    if (pdfZoomGroup) pdfZoomGroup.style.display = "flex";
    loadPdfPageState();
    await renderPdfPage();
    updateDocumentOverlays();
    updateHeaderTitle();
    pdfRealtimeUnsubscribe?.();
    pdfRealtimeBroadcast = null;
    pdfRealtimeBroadcastProgress = null;
    pdfRemoteApplyGen = {};
    pdfLastRemoteUpdatedAt = {};
    const sub = subscribeStrokes(shareToken, (payload) => {
      if (payload?.event === "pointer_position") {
        const { x, y } = payload.payload || {};
        if (typeof x === "number" && typeof y === "number") {
          pointerPosition = { x, y };
          if (pdfMode && pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        }
        return;
      }
      if (payload?.event === "pointer_hidden") {
        pointerPosition = null;
        if (pdfMode && pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
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
      const u = row.updated_at;
      if (typeof u === "string") {
        const prev = pdfLastRemoteUpdatedAt[p];
        if (typeof prev === "string" && u < prev) return;
        pdfLastRemoteUpdatedAt[p] = u;
      }
      pdfRemoteCurrentStroke = null;
      if (!pdfStrokesByPage[p]) pdfStrokesByPage[p] = { strokes: [], shapes: [], fillShapes: [] };
      pdfStrokesByPage[p].strokes = incomingStrokes;
      if (row.shapes !== undefined) {
        pdfStrokesByPage[p].shapes = (row.shapes || []).map(cloneShape);
      }
      const gen = (pdfRemoteApplyGen[p] = (pdfRemoteApplyGen[p] || 0) + 1);
      const flushPdfLiveFromStore = () => {
        if (p !== pdfPageNum || !pdfDrawCanvas) return;
        const layer = pdfStrokesByPage[p];
        const oldPdfStrokes = pdfStrokes;
        pdfStrokes = (layer.strokes || []).map(cloneStroke);
        for (let i = 0; i < Math.min(pdfStrokes.length, oldPdfStrokes.length); i++) {
          if (oldPdfStrokes[i]._ts) pdfStrokes[i]._ts = oldPdfStrokes[i]._ts;
        }
        pdfShapes = (layer.shapes || []).map(cloneShape);
        pdfFillShapes = (layer.fillShapes || []).map((f) => ({
          data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h),
          w: f.w,
          h: f.h,
        }));
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      };
      if (row.fill_shapes !== undefined) {
        deserializeFillShapes(row.fill_shapes || []).then((fs) => {
          if (pdfRemoteApplyGen[p] !== gen) return;
          pdfStrokesByPage[p].fillShapes = fs;
          if (p === pdfPageNum) {
            const oldPdfStrokes = pdfStrokes;
            pdfStrokes = (pdfStrokesByPage[p].strokes || []).map(cloneStroke);
            for (let i = 0; i < Math.min(pdfStrokes.length, oldPdfStrokes.length); i++) {
              if (oldPdfStrokes[i]._ts) pdfStrokes[i]._ts = oldPdfStrokes[i]._ts;
            }
            pdfShapes = (pdfStrokesByPage[p].shapes || []).map(cloneShape);
            pdfFillShapes = pdfStrokesByPage[p].fillShapes || [];
            drawStrokesToPdfCanvas(pdfDrawCanvas?.width || 1, pdfDrawCanvas?.height || 1);
          }
        });
        flushPdfLiveFromStore();
      } else {
        flushPdfLiveFromStore();
      }
    });
    pdfRealtimeUnsubscribe = sub?.unsubscribe || sub;
    pdfRealtimeBroadcast = sub?.broadcast;
    pdfRealtimeBroadcastProgress = sub?.broadcastProgress;
    setTimeout(() => scheduleDocRefitStable(), 100);
    applySharedDocViewerMode(accessMode === "viewer");
    return true;
  } catch (err) {
    console.error("PDF yükleme hatası:", err);
    sharedDocReadOnly = false;
    document.body.classList.remove("shared-doc-viewer");
    alert("PDF açılamadı: " + (err.message || "Bilinmeyen hata"));
    return false;
  }
}

async function loadPptxFromShareToken(shareToken, password = null) {
  if (!shareToken || !supabase) return false;
  try {
    const { data, error } = await supabase.rpc("get_pdf_by_share_token", { token: shareToken, pwd: password || null });
    if (error) throw new Error("Документ не найден");
    const row = data?.[0];
    if (!row) throw new Error("Документ не найден");
    if (row.needs_password === true) return { needsPassword: true };
    const accessMode = row.access_mode || "editor";
    const storagePath = row.storage_path;
    if (!storagePath) throw new Error("Документ не найден");
    const { data: urlData } = supabase.storage.from("pdfs").getPublicUrl(storagePath);
    const fileUrl = urlData?.publicUrl;
    if (!fileUrl) throw new Error("URL недоступен");
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error("Не удалось загрузить файл");
    const blob = await resp.blob();
    const fileName = row.file_name || storagePath.split("/").pop() || "presentation.pptx";
    const file = new File([blob], fileName, { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    for (let i = 0; i < 50 && !PPTXViewer; i++) await new Promise((r) => setTimeout(r, 100));
    if (!PPTXViewer) throw new Error("Библиотека презентаций недоступна");
    if (!pptxViewer) pptxViewer = new PPTXViewer({ canvas: pptxCanvas });
    await pptxViewer.loadFile(file);
    currentPptxShareToken = shareToken;
    pptxTotalPages = pptxViewer.getSlideCount?.() ?? 1;
    pptxPageNum = 1;
    pptxStrokesByPage = {};
    pptxShapesByPage = {};
    pptxStrokes = [];
    pptxShapes = [];
    pptxFillShapes = [];
    pptxCurrentStroke = { points: [], color: drawColor };
    const pages = await fetchStrokes(shareToken);
    if (pages?.length) {
      for (const r of pages) {
        const p = r.page_num;
        if (!pptxStrokesByPage[p]) pptxStrokesByPage[p] = { strokes: [], shapes: [], fillShapes: [] };
        for (const s of r.strokes || []) {
          pptxStrokesByPage[p].strokes.push({
            points: s.points || [],
            color: s.color || drawColor,
            lineWidth: s.lineWidth ?? drawLineWidth,
          });
        }
        pptxStrokesByPage[p].shapes = (r.shapes || []).map(cloneShape);
        pptxStrokesByPage[p].fillShapes = await deserializeFillShapes(r.fill_shapes || []);
      }
    }
    pdfMode = false;
    whiteSheetMode = false;
    blackSheetMode = false;
    pptxMode = true;
    cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode");
    cameraWrapper?.classList.add("pptx-mode", "pptx-loaded");
    if (pdfNavGroup) pdfNavGroup.style.display = "flex";
    if (pdfPageInfo) pdfPageInfo.textContent = `1 / ${pptxTotalPages}`;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pptxTotalPages <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = pptxTotalPages <= 1;
    if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
    if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
    if (pdfClearBtn) pdfClearBtn.disabled = false;
    if (drawBtn) drawBtn.disabled = false;
    if (clearDrawBtn) clearDrawBtn.disabled = false;
    const base = getShareBaseUrl();
    const link = `${base}/index.html?id=${shareToken}`;
    if (pdfLinkBtn) { pdfLinkBtn.dataset.link = link; pdfLinkBtn.style.display = "inline-flex"; }
    if (canvasLinkBtn) canvasLinkBtn.style.display = "none";
    const exportBtn = document.getElementById("exportDocBtn");
    if (exportBtn) exportBtn.style.display = "inline-flex";
    if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
    if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
    loadPptxPageState();
    await renderPptxSlide();
    updateDocumentOverlays();
    updateHeaderTitle();
    pptxRemoteApplyGen = {};
    pptxLastRemoteUpdatedAt = {};
    const sub = subscribeStrokes(shareToken, (payload) => {
      if (payload?.type === "progress" && payload.pageNum === pptxPageNum) {
        pptxRemoteCurrentStroke = payload.stroke;
        drawStrokesToPptxCanvas(pptxDrawCanvas?.width || 1, pptxDrawCanvas?.height || 1);
        return;
      }
      if (gestureState === "erasing") return;
      const r = payload?.new || payload?.newRecord || payload?.record;
      if (!r || r.share_token !== shareToken) return;
      const p = r.page_num;
      const incomingStrokes = (r.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      const u = r.updated_at;
      if (typeof u === "string") {
        const prev = pptxLastRemoteUpdatedAt[p];
        if (typeof prev === "string" && u < prev) return;
        pptxLastRemoteUpdatedAt[p] = u;
      }
      if (!pptxStrokesByPage[p]) pptxStrokesByPage[p] = { strokes: [], shapes: [], fillShapes: [] };
      pptxStrokesByPage[p].strokes = incomingStrokes;
      if (r.shapes !== undefined) {
        pptxStrokesByPage[p].shapes = (r.shapes || []).map(cloneShape);
      }
      const gen = (pptxRemoteApplyGen[p] = (pptxRemoteApplyGen[p] || 0) + 1);
      const flushPptxLiveFromStore = () => {
        if (p !== pptxPageNum || !pptxDrawCanvas) return;
        const layer = pptxStrokesByPage[p];
        pptxStrokes = (layer.strokes || []).map(cloneStroke);
        pptxShapes = (layer.shapes || []).map(cloneShape);
        pptxFillShapes = (layer.fillShapes || []).map((f) => ({
          data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h),
          w: f.w,
          h: f.h,
        }));
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      };
      if (r.fill_shapes !== undefined) {
        deserializeFillShapes(r.fill_shapes || []).then((fs) => {
          if (pptxRemoteApplyGen[p] !== gen) return;
          pptxStrokesByPage[p].fillShapes = fs;
          if (p === pptxPageNum) {
            pptxStrokes = (pptxStrokesByPage[p].strokes || []).map(cloneStroke);
            pptxShapes = (pptxStrokesByPage[p].shapes || []).map(cloneShape);
            pptxFillShapes = pptxStrokesByPage[p].fillShapes || [];
            drawStrokesToPptxCanvas(pptxDrawCanvas?.width || 1, pptxDrawCanvas?.height || 1);
          }
        });
        flushPptxLiveFromStore();
      } else {
        flushPptxLiveFromStore();
      }
    });
    pptxRealtimeUnsubscribe = sub?.unsubscribe || sub;
    pptxRealtimeBroadcast = sub?.broadcast;
    pptxRealtimeBroadcastProgress = sub?.broadcastProgress;
    setTimeout(() => scheduleDocRefitStable(), 100);
    applySharedDocViewerMode(accessMode === "viewer");
    return true;
  } catch (err) {
    console.error("PPTX load error:", err);
    sharedDocReadOnly = false;
    document.body.classList.remove("shared-doc-viewer");
    alert("Не удалось загрузить презентацию: " + (err.message || "Неизвестная ошибка"));
    return false;
  }
}

let pptxRealtimeUnsubscribe = null;
let pptxRealtimeBroadcast = null;
let pptxRealtimeBroadcastProgress = null;
let pptxRemoteCurrentStroke = null;

async function savePptxStrokesAndBroadcast(pageNum, strokes, skipBroadcast = false) {
  if (!currentPptxShareToken || sharedDocReadOnly) return;
  const sh = pptxShapes;
  const fsh = pptxFillShapes;
  const res = await savePageStrokes(currentPptxShareToken, pageNum, strokes, sh, fsh);
  if (res && pptxRealtimeBroadcast && !skipBroadcast) {
    const ts = typeof res === "object" && res.updated_at ? res.updated_at : undefined;
    pptxRealtimeBroadcast(pageNum, strokes, ts);
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
    pdfMode = true;
    whiteSheetMode = false;
    pptxMode = false;
    if (cameraWrapper) {
      cameraWrapper.classList.add("pdf-loaded", "pdf-mode");
      cameraWrapper.classList.remove("white-sheet-mode", "black-sheet-mode", "pptx-mode");
    }
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
  let pdfEraserActive = false;
  let pdfEraseDirty = false;
  let pdfLastPtrNorm = null;
  let pdfSnapTimerId = null;
  let pdfSnapHoldState = { holdMs: 0, holdRef: null };
  let pdfFreehandSignificantAt = 0;
  const stopPdfSnapPoll = () => {
    if (pdfSnapTimerId != null) {
      clearInterval(pdfSnapTimerId);
      pdfSnapTimerId = null;
    }
    resetSnapHoldState(pdfSnapHoldState);
  };
  const pollPdfSketchSnap = () => {
    if (!pdfIsDrawing || drawShape !== "free" || !pdfCurrentStroke?.points?.length) return;
    const pts = pdfCurrentStroke.points;
    const ptr = pdfLastPtrNorm;
    if (
      tickSketchSnapHold(pdfSnapHoldState, ptr, pdfFreehandSignificantAt, pts.length, SKETCH_SNAP_MIN_POINTS, SKETCH_SNAP_HOLD_MS, SKETCH_SNAP_POLL_MS)
    ) {
      const draft = { ...pdfCurrentStroke, points: [...pts] };
      if (tryCommitSketchedShapeFromHold(pdfStrokes, pdfShapes, draft)) {
        pushPdfHistory();
        if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
        pdfCurrentStroke = { points: [], color: drawColor };
        pdfIsDrawing = false;
        pdfRemoteCurrentStroke = null;
        stopPdfSnapPoll();
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      }
    }
  };
  const onStart = (e) => {
    if (sharedDocReadOnly) return;
    if (!pdfMode || !pdfDoc) return;
    e.preventDefault();
    const p = getNorm(e);
    if (eraserMode) {
      pdfEraserActive = true;
      pdfEraseDirty = true;
      erasePdfAtPosition(p.x, p.y, 0.08);
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      return;
    }
    if (drawShape === "select") {
      const imgSel = getSingleSelectedPlacedImage(selectState, pdfShapes);
      if (imgSel) {
        const hHit = hitTestPlacedImageResizeHandle(p.x, p.y, imgSel.sh);
        if (hHit) {
          selectImageResizing = true;
          selectImageResizeStart = createPlacedImageResizeStart(imgSel.sh, hHit);
          selectScaleLastZ = null;
          selectScaleZSmooth = null;
          selectScaleGateMissFrames = 0;
          return;
        }
      }
      const ub = selectState ? selectionUnionBBoxFromSel(selectState, pdfStrokes, pdfShapes) : null;
      if (selectState && ub && pointInNormRect(p.x, p.y, ub)) {
        selectDragging = true;
        selectDragAnchor = { x: p.x, y: p.y };
        return;
      }
      selectState = null;
      selectMarqueeNorm = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    if (drawShape === "fill" && fillToolBtn?.classList.contains("active")) {
      doFillAtPdf(p.x * pdfDrawCanvas.width, p.y * pdfDrawCanvas.height, pdfDrawCanvas.width, pdfDrawCanvas.height);
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      return;
    }
    if (drawShape === "text") {
      const textInput = document.getElementById("textInputOverlay");
      if (textInput) {
        const rect = pdfDrawCanvas.getBoundingClientRect();
        const wr = pdfDrawCanvas.closest(".camera-wrapper")?.getBoundingClientRect() || rect;
        const px = (rect.left - wr.left) + p.x * rect.width;
        const py = (rect.top - wr.top) + p.y * rect.height;
        textInput.style.left = px + "px";
        textInput.style.top = py + "px";
        textInput.style.display = "block";
        textInput.value = "";
        textInput.style.color = drawColor;
        textInput.focus();
        textInput.dataset.pendingX = String(p.x);
        textInput.dataset.pendingY = String(p.y);
        textInput.dataset.mode = "pdf";
      }
      return;
    }
    if (["circle", "rect", "line", "ellipse", "triangle", "triangle_right", "arrow"].includes(drawShape)) {
      pdfIsDrawing = true;
      pdfShapeInProgress = { start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, type: drawShape };
      return;
    }
    pdfIsDrawing = true;
    pdfCurrentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth, opacity: strokeOpacity, toolType: drawToolType };
    pdfLastPtrNorm = { x: p.x, y: p.y };
    pdfFreehandSignificantAt = performance.now();
    stopPdfSnapPoll();
    pdfSnapTimerId = setInterval(pollPdfSketchSnap, SKETCH_SNAP_POLL_MS);
  };
  let lastBroadcastProgress = 0;
  const onMove = (e) => {
    const p = getNorm(e);
    if (drawShape === "select") {
      if (selectImageResizing && selectState) {
        const imgSel = getSingleSelectedPlacedImage(selectState, pdfShapes);
        if (imgSel?.sh && selectImageResizeStart) {
          if (!selectPointerButtonDown(e)) return;
          e.preventDefault();
          applyPlacedImageResize(imgSel.sh, selectImageResizeStart, p.x, p.y);
          drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
          return;
        }
      }
      if (selectDragging && selectState) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        const dx = p.x - selectDragAnchor.x;
        const dy = p.y - selectDragAnchor.y;
        selectDragAnchor = { x: p.x, y: p.y };
        applySelectionOffset(selectState, dx, dy, pdfStrokes, pdfShapes);
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        selectMarqueeNorm.x1 = p.x;
        selectMarqueeNorm.y1 = p.y;
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
    }
    if (eraserMode && (pdfEraserActive || e.buttons === 1)) {
      e.preventDefault();
      pdfEraseDirty = true;
      erasePdfAtPosition(p.x, p.y, 0.08);
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      return;
    }
    if (pdfShapeInProgress) {
      e.preventDefault();
      pdfShapeInProgress.end = { x: p.x, y: p.y };
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      return;
    }
    if (!pdfIsDrawing || !pdfCurrentStroke.points.length) return;
    e.preventDefault();
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      pdfLastPtrNorm = { x: p.x, y: p.y };
      const lastPt = pdfCurrentStroke.points[pdfCurrentStroke.points.length - 1];
      const step = lastPt ? Math.hypot(p.x - lastPt.x, p.y - lastPt.y) : 1;
      if (!lastPt || step >= MIN_STROKE_DIST) {
        pdfCurrentStroke.points.push({ x: p.x, y: p.y });
        if (!lastPt || step >= FREEHAND_SNAP_SIGNIFICANT_STEP) pdfFreehandSignificantAt = performance.now();
      }
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      const now = Date.now();
      if (currentPdfShareToken && pdfRealtimeBroadcastProgress && (now - lastBroadcastProgress >= 50 || pdfCurrentStroke.points.length % 5 === 0)) {
        lastBroadcastProgress = now;
        pdfRealtimeBroadcastProgress(pdfPageNum, pdfCurrentStroke);
      }
    }
  };
  const onEnd = (e) => {
    pdfEraserActive = false;
    stopPdfSnapPoll();
    if (pdfEraseDirty) {
      pdfEraseDirty = false;
      pushPdfHistory();
      savePdfPageState();
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
    }
    if (drawShape === "select") {
      e.preventDefault();
      if (selectImageResizing) {
        selectImageResizing = false;
        selectImageResizeStart = null;
        pushPdfHistory();
        savePdfPageState();
        if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
      if (selectDragging) {
        selectDragging = false;
        selectDragAnchor = null;
        pushPdfHistory();
        savePdfPageState();
        if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        const m = selectMarqueeNorm;
        const wN = Math.abs(m.x1 - m.x0), hN = Math.abs(m.y1 - m.y0);
        if (wN >= MIN_SELECT_NORM || hN >= MIN_SELECT_NORM) {
          const rect = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
          const picked = pickSelectionInRect(rect, pdfStrokes, pdfShapes);
          selectState = picked.strokeIdx.length || picked.shapeIdx.length ? picked : null;
        } else selectState = null;
        selectMarqueeNorm = null;
        drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
        return;
      }
    }
    if (pdfShapeInProgress) {
      e.preventDefault();
      const s = pdfShapeInProgress.start, t = pdfShapeInProgress.end;
      const x1 = Math.min(s.x, t.x), x2 = Math.max(s.x, t.x);
      const y1 = Math.min(s.y, t.y), y2 = Math.max(s.y, t.y);
      const sh = { color: drawColor, lineWidth: drawLineWidth, fill: shapeFill, opacity: strokeOpacity };
      if (pdfShapeInProgress.type === "circle") {
        sh.type = "circle";
        sh.cx = (x1 + x2) / 2; sh.cy = (y1 + y2) / 2;
        sh.r = Math.hypot(x2 - x1, y2 - y1) / 2;
      } else if (pdfShapeInProgress.type === "rect") {
        sh.type = "rect"; sh.x = s.x; sh.y = s.y; sh.w = t.x - s.x; sh.h = t.y - s.y;
      } else if (pdfShapeInProgress.type === "line" || pdfShapeInProgress.type === "arrow") {
        sh.type = pdfShapeInProgress.type; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
      } else if (pdfShapeInProgress.type === "ellipse") {
        sh.type = "ellipse"; sh.x = x1; sh.y = y1; sh.w = x2 - x1; sh.h = y2 - y1;
      } else if (pdfShapeInProgress.type === "triangle") {
        const dx = t.x - s.x, dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 0.001;
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        const perpLen = len * 0.5;
        sh.type = "triangle"; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
        sh.x3 = mx - (dy / len) * perpLen; sh.y3 = my + (dx / len) * perpLen;
      } else if (pdfShapeInProgress.type === "triangle_right") {
        sh.type = "triangle"; sh.x1 = t.x; sh.y1 = t.y; sh.x2 = s.x; sh.y2 = t.y; sh.x3 = t.x; sh.y3 = s.y;
      }
      if (sh.type) {
        pdfShapes.push(sh);
        pushPdfHistory();
        if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
      }
      pdfShapeInProgress = null;
      pdfIsDrawing = false;
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      return;
    }
    if (!pdfIsDrawing) return;
    e.preventDefault();
    pdfIsDrawing = false;
    if (pdfCurrentStroke.points.length > 1) {
      const stroke = { ...pdfCurrentStroke };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      pdfStrokes.push(stroke);
      pushPdfHistory();
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
  pdfDrawCanvas.addEventListener("touchcancel", onEnd, { passive: false });
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
  let eraserActive = false;
  let canvasEraseDirty = false;
  let canvasLastPtrNorm = null;
  let canvasSnapTimerId = null;
  let canvasSnapHoldState = { holdMs: 0, holdRef: null };
  let canvasFreehandSignificantAt = 0;
  const stopCanvasSnapPoll = () => {
    if (canvasSnapTimerId != null) {
      clearInterval(canvasSnapTimerId);
      canvasSnapTimerId = null;
    }
    resetSnapHoldState(canvasSnapHoldState);
  };
  const pollCanvasSketchSnap = () => {
    if (!canvasIsDrawing || drawShape !== "free" || !currentStroke?.points?.length) return;
    const pts = currentStroke.points;
    const ptr = canvasLastPtrNorm;
    if (
      tickSketchSnapHold(canvasSnapHoldState, ptr, canvasFreehandSignificantAt, pts.length, SKETCH_SNAP_MIN_POINTS, SKETCH_SNAP_HOLD_MS, SKETCH_SNAP_POLL_MS)
    ) {
      const draft = { ...currentStroke, points: [...pts] };
      if (tryCommitSketchedShapeFromHold(strokes, shapes, draft)) {
        pushCanvasHistory();
        if (currentCanvasShareToken && supabase) {
          savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
        }
        currentStroke = { points: [], color: drawColor };
        canvasIsDrawing = false;
        canvasRemoteCurrentStroke = null;
        stopCanvasSnapPoll();
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      }
    }
  };
  const onStart = (e) => {
    if (pdfMode || pptxMode) return;
    e.preventDefault();
    const p = getNorm(e);
    if (eraserMode) {
      eraserActive = true;
      canvasEraseDirty = true;
      eraseAtPosition(p.x, p.y, 0.08);
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      return;
    }
    if (drawShape === "select") {
      const imgSel = getSingleSelectedPlacedImage(selectState, shapes);
      if (imgSel) {
        const hHit = hitTestPlacedImageResizeHandle(p.x, p.y, imgSel.sh);
        if (hHit) {
          selectImageResizing = true;
          selectImageResizeStart = createPlacedImageResizeStart(imgSel.sh, hHit);
          selectScaleLastZ = null;
          selectScaleZSmooth = null;
          selectScaleGateMissFrames = 0;
          return;
        }
      }
      const ub = selectState ? selectionUnionBBoxFromSel(selectState, strokes, shapes) : null;
      if (selectState && ub && pointInNormRect(p.x, p.y, ub)) {
        selectDragging = true;
        selectDragAnchor = { x: p.x, y: p.y };
        return;
      }
      selectState = null;
      selectMarqueeNorm = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    if (drawShape === "fill" && fillToolBtn?.classList.contains("active")) {
      const px = MIRROR_CAMERA ? (1 - p.x) * drawCanvas.width : p.x * drawCanvas.width;
      const py = p.y * drawCanvas.height;
      doFillAtCanvas(px, py, drawCanvas.width, drawCanvas.height);
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      return;
    }
    if (drawShape === "text") {
      const textInput = document.getElementById("textInputOverlay");
      if (textInput) {
        const rect = drawCanvas.getBoundingClientRect();
        const wr = drawCanvas.closest(".camera-wrapper")?.getBoundingClientRect() || rect;
        const px = (rect.left - wr.left) + (MIRROR_CAMERA ? 1 - p.x : p.x) * rect.width;
        const py = (rect.top - wr.top) + p.y * rect.height;
        textInput.style.left = px + "px";
        textInput.style.top = py + "px";
        textInput.style.display = "block";
        textInput.value = "";
        textInput.style.color = drawColor;
        textInput.focus();
        textInput.dataset.pendingX = String(p.x);
        textInput.dataset.pendingY = String(p.y);
      }
      return;
    }
    if (["circle", "rect", "line", "ellipse", "triangle", "triangle_right", "arrow"].includes(drawShape)) {
      canvasIsDrawing = true;
      shapeInProgress = { start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, type: drawShape };
      return;
    }
    canvasIsDrawing = true;
    currentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth, opacity: strokeOpacity, toolType: drawToolType };
    canvasLastPtrNorm = { x: p.x, y: p.y };
    canvasFreehandSignificantAt = performance.now();
    stopCanvasSnapPoll();
    canvasSnapTimerId = setInterval(pollCanvasSketchSnap, SKETCH_SNAP_POLL_MS);
  };
  const onMove = (e) => {
    const p = getNorm(e);
    if (drawShape === "select") {
      if (selectImageResizing && selectState) {
        const imgSel = getSingleSelectedPlacedImage(selectState, shapes);
        if (imgSel?.sh && selectImageResizeStart) {
          if (!selectPointerButtonDown(e)) return;
          e.preventDefault();
          applyPlacedImageResize(imgSel.sh, selectImageResizeStart, p.x, p.y);
          drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
          return;
        }
      }
      if (selectDragging && selectState) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        const dx = p.x - selectDragAnchor.x;
        const dy = p.y - selectDragAnchor.y;
        selectDragAnchor = { x: p.x, y: p.y };
        applySelectionOffset(selectState, dx, dy, strokes, shapes);
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        selectMarqueeNorm.x1 = p.x;
        selectMarqueeNorm.y1 = p.y;
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
    }
    if (eraserMode && (eraserActive || e.buttons === 1)) {
      e.preventDefault();
      canvasEraseDirty = true;
      eraseAtPosition(p.x, p.y, 0.08);
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      return;
    }
    if (shapeInProgress) {
      e.preventDefault();
      shapeInProgress.end = { x: p.x, y: p.y };
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      return;
    }
    if (!canvasIsDrawing || !currentStroke.points.length) return;
    e.preventDefault();
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      canvasLastPtrNorm = { x: p.x, y: p.y };
      const lastPt = currentStroke.points[currentStroke.points.length - 1];
      const step = lastPt ? Math.hypot(p.x - lastPt.x, p.y - lastPt.y) : 1;
      if (!lastPt || step >= MIN_STROKE_DIST) {
        currentStroke.points.push({ x: p.x, y: p.y });
        if (!lastPt || step >= FREEHAND_SNAP_SIGNIFICANT_STEP) canvasFreehandSignificantAt = performance.now();
      }
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      const now = Date.now();
      if (currentCanvasShareToken && canvasRealtimeBroadcastProgress && (now - lastCanvasBroadcastProgress >= 50 || currentStroke.points.length % 5 === 0)) {
        lastCanvasBroadcastProgress = now;
        canvasRealtimeBroadcastProgress(getCurrentCanvasPageNum(), currentStroke);
      }
    }
  };
  const onEnd = (e) => {
    eraserActive = false;
    stopCanvasSnapPoll();
    if (canvasEraseDirty) {
      canvasEraseDirty = false;
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) {
        savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      }
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    }
    if (drawShape === "select") {
      e.preventDefault();
      if (selectImageResizing) {
        selectImageResizing = false;
        selectImageResizeStart = null;
        pushCanvasHistory();
        if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
      if (selectDragging) {
        selectDragging = false;
        selectDragAnchor = null;
        pushCanvasHistory();
        if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        const m = selectMarqueeNorm;
        const wN = Math.abs(m.x1 - m.x0), hN = Math.abs(m.y1 - m.y0);
        if (wN >= MIN_SELECT_NORM || hN >= MIN_SELECT_NORM) {
          const rect = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
          const picked = pickSelectionInRect(rect, strokes, shapes);
          selectState = picked.strokeIdx.length || picked.shapeIdx.length ? picked : null;
        } else selectState = null;
        selectMarqueeNorm = null;
        drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
    }
    if (shapeInProgress) {
      e.preventDefault();
      const s = shapeInProgress.start, t = shapeInProgress.end;
      const x1 = Math.min(s.x, t.x), x2 = Math.max(s.x, t.x);
      const y1 = Math.min(s.y, t.y), y2 = Math.max(s.y, t.y);
      const sh = { color: drawColor, lineWidth: drawLineWidth, fill: shapeFill, opacity: strokeOpacity };
      if (shapeInProgress.type === "circle") {
        sh.type = "circle"; sh.cx = (x1 + x2) / 2; sh.cy = (y1 + y2) / 2;
        sh.r = Math.hypot(x2 - x1, y2 - y1) / 2;
      } else if (shapeInProgress.type === "rect") {
        sh.type = "rect"; sh.x = s.x; sh.y = s.y; sh.w = t.x - s.x; sh.h = t.y - s.y;
      } else if (shapeInProgress.type === "line" || shapeInProgress.type === "arrow") {
        sh.type = shapeInProgress.type; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
      } else if (shapeInProgress.type === "ellipse") {
        sh.type = "ellipse"; sh.x = x1; sh.y = y1; sh.w = x2 - x1; sh.h = y2 - y1;
      } else if (shapeInProgress.type === "triangle") {
        const dx = t.x - s.x, dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 0.001;
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        const perpLen = len * 0.5;
        sh.type = "triangle"; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
        sh.x3 = mx - (dy / len) * perpLen; sh.y3 = my + (dx / len) * perpLen;
      } else if (shapeInProgress.type === "triangle_right") {
        sh.type = "triangle"; sh.x1 = t.x; sh.y1 = t.y; sh.x2 = s.x; sh.y2 = t.y; sh.x3 = t.x; sh.y3 = s.y;
      }
      if (sh.type) {
        shapes.push(sh);
        pushCanvasHistory();
        if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      }
      shapeInProgress = null;
      canvasIsDrawing = false;
      drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      return;
    }
    if (!canvasIsDrawing) return;
    e.preventDefault();
    canvasIsDrawing = false;
    if (currentStroke.points.length > 1) {
      const stroke = { ...currentStroke };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      strokes.push(stroke);
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) {
        savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      }
    }
    canvasRemoteCurrentStroke = null;
    currentStroke = { points: [], color: drawColor };
  };
  drawCanvas.addEventListener("mousedown", onStart);
  drawCanvas.addEventListener("mousemove", onMove);
  drawCanvas.addEventListener("mouseup", onEnd);
  drawCanvas.addEventListener("mouseleave", onEnd);
  drawCanvas.addEventListener("touchstart", onStart, { passive: false });
  drawCanvas.addEventListener("touchmove", onMove, { passive: false });
  drawCanvas.addEventListener("touchend", onEnd, { passive: false });
  drawCanvas.addEventListener("touchcancel", onEnd, { passive: false });
}

function clearPdf() {
  pdfDoc = null;
  pdfPageNum = 1;
  pdfTotalPages = 0;
  pdfStrokes = [];
  pdfShapes = [];
  pdfFillShapes = [];
  pdfStrokesByPage = {};
  pdfShapesByPage = {};
  pdfCurrentStroke = { points: [], color: drawColor };
  if (cameraWrapper) {
    cameraWrapper.classList.remove("pdf-loaded", "pdf-landscape-fit");
    cameraWrapper.style.width = "";
    cameraWrapper.style.height = "";
    cameraWrapper.style.maxWidth = "";
  }
  if (pdfPageInfo) pdfPageInfo.textContent = "-";
  if (pdfPrevBtn) pdfPrevBtn.disabled = true;
  if (pdfNextBtn) pdfNextBtn.disabled = true;
  if (pdfClearBtn) pdfClearBtn.disabled = true;
  currentPdfShareToken = null;
  currentCanvasShareToken = null;
  if (pdfCopyLinkBtn) {
    pdfCopyLinkBtn.style.display = "none";
    pdfCopyLinkBtn.disabled = true;
    delete pdfCopyLinkBtn.dataset.link;
  }
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
  fillShapes = [];
  currentStroke = { points: [], color: drawColor };
  if (pdfFileInput) pdfFileInput.value = "";
  updateDocumentOverlays();
}

const CANVAS_PAGE = 0;

function getCurrentCanvasPageNum() {
  return isCanvasDocument ? canvasPageNum : CANVAS_PAGE;
}

async function loadCanvasFromShareToken(shareToken) {
  if (!shareToken || !supabase) return false;
  canvasRemoteCurrentStroke = null;
  isCanvasDocument = false;
  canvasPageNum = 1;
  canvasTotalPages = 1;
  canvasStrokesByPage = {};
  try {
    const pages = await fetchStrokes(shareToken);
    const row = pages?.find((r) => r.page_num === CANVAS_PAGE);
    const loadedStrokes = (row?.strokes || []).map((s) => ({
      points: s.points || [],
      color: s.color || drawColor,
      lineWidth: s.lineWidth ?? drawLineWidth,
    }));
    strokes = loadedStrokes;
    shapes = (row?.shapes || []).map(cloneShape);
    fillShapes = await deserializeFillShapes(row?.fill_shapes || []);
    currentStroke = { points: [], color: drawColor };
    historyStack = [];
    historyIndex = -1;
    pushCanvasHistory();
    currentCanvasShareToken = shareToken;
    whiteSheetMode = true;
    blackSheetMode = false;
    pdfMode = false;
    pptxMode = false;
    cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pptx-mode", "pptx-loaded");
    cameraWrapper?.classList.add("white-sheet-mode");
    modeCameraBtn?.classList.remove("active");
    modeWhiteSheetBtn?.classList.add("active");
    modeBlackSheetBtn?.classList.remove("active");
    modePdfBtn?.classList.remove("active");
    if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
    if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
    if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
    if (stopBtn) stopBtn.style.display = "";
    if (modePdfBtn) modePdfBtn.style.display = "";
    if (canvasLinkBtn) canvasLinkBtn.dataset.link = `${getShareBaseUrl()}/index.html?canvas=${shareToken}`;
    canvasRealtimeUnsubscribe?.();
    canvasRealtimeBroadcastProgress = null;
    const sub = subscribeStrokes(shareToken, (payload) => {
      if (payload?.type === "progress" && payload.pageNum === CANVAS_PAGE) {
        canvasRemoteCurrentStroke = payload.stroke;
        if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
      if (gestureState === "erasing") return;
      const row = payload?.new || payload?.newRecord || payload?.record;
      if (!row || row.share_token !== shareToken || row.page_num !== CANVAS_PAGE) return;
      canvasRemoteCurrentStroke = null;
      const incoming = (row.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      strokes = incoming;
      shapes = (row.shapes || []).map(cloneShape);
      deserializeFillShapes(row.fill_shapes || []).then((fs) => {
        fillShapes = fs;
        if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      });
    });
    canvasRealtimeUnsubscribe = sub?.unsubscribe || sub;
    canvasRealtimeBroadcastProgress = sub?.broadcastProgress || null;
    if (canvasPageNavGroup) canvasPageNavGroup.style.display = "none";
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    updateDocumentOverlays();
    updateHeaderTitle();
    return true;
  } catch (err) {
    console.error("Canvas load error:", err);
    return false;
  }
}

async function saveCurrentCanvasPageToStorage() {
  if (!currentCanvasShareToken || !isCanvasDocument) return;
  canvasStrokesByPage[canvasPageNum] = {
    strokes: strokes.map(cloneStroke),
    shapes: shapes.map(cloneShape),
    fillShapes: fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h })),
  };
  if (supabase) await savePageStrokes(currentCanvasShareToken, canvasPageNum, strokes, shapes, fillShapes);
}

function switchToCanvasPage(pageNum) {
  if (!isCanvasDocument || pageNum < 1 || pageNum > canvasTotalPages) return;
  canvasRemoteCurrentStroke = null;
  clearSelectionToolState();
  saveCurrentCanvasPageToStorage().then(() => {
    canvasPageNum = pageNum;
    const layer = canvasStrokesByPage[canvasPageNum];
    const loadedStrokes = (layer?.strokes || []).map((s) => ({
      points: s.points || [],
      color: s.color || drawColor,
      lineWidth: s.lineWidth ?? drawLineWidth,
    }));
    strokes = loadedStrokes;
    shapes = (layer?.shapes || []).map(cloneShape);
    fillShapes = (layer?.fillShapes || []).map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
    currentStroke = { points: [], color: drawColor };
    historyStack = [];
    historyIndex = -1;
    pushCanvasHistory();
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    if (canvasPageInfo) canvasPageInfo.textContent = `${canvasPageNum} / ${canvasTotalPages}`;
    if (canvasPrevBtn) canvasPrevBtn.disabled = canvasPageNum <= 1;
    if (canvasNextBtn) canvasNextBtn.disabled = canvasPageNum >= canvasTotalPages;
  });
}

async function loadCanvasDocumentWithPages(shareToken) {
  if (!shareToken || !supabase) return false;
  canvasRemoteCurrentStroke = null;
  isCanvasDocument = true;
  try {
    const pages = await fetchStrokes(shareToken);
    const docPages = (pages || []).filter((r) => r.page_num >= 1).sort((a, b) => a.page_num - b.page_num);
    canvasStrokesByPage = {};
    for (const row of docPages) {
      const loaded = (row.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      const loadedShapes = (row.shapes || []).map(cloneShape);
      const loadedFills = await deserializeFillShapes(row.fill_shapes || []);
      canvasStrokesByPage[row.page_num] = { strokes: loaded, shapes: loadedShapes, fillShapes: loadedFills };
    }
    canvasTotalPages = docPages.length >= 1 ? Math.max(...docPages.map((r) => r.page_num)) : 1;
    if (!canvasStrokesByPage[1]) canvasStrokesByPage[1] = { strokes: [], shapes: [], fillShapes: [] };
    canvasPageNum = 1;
    const layer = canvasStrokesByPage[1];
    strokes = (layer?.strokes || []).map((s) => ({ ...s }));
    shapes = (layer?.shapes || []).map(cloneShape);
    fillShapes = (layer?.fillShapes || []).map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
    currentStroke = { points: [], color: drawColor };
    historyStack = [];
    historyIndex = -1;
    pushCanvasHistory();
    currentCanvasShareToken = shareToken;
    whiteSheetMode = true;
    blackSheetMode = false;
    pdfMode = false;
    pptxMode = false;
    cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pptx-mode", "pptx-loaded");
    cameraWrapper?.classList.add("white-sheet-mode");
    modeCameraBtn?.classList.remove("active");
    modeWhiteSheetBtn?.classList.add("active");
    modeBlackSheetBtn?.classList.remove("active");
    modePdfBtn?.classList.remove("active");
    if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
    if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
    if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
    if (stopBtn) stopBtn.style.display = "";
    if (modePdfBtn) modePdfBtn.style.display = "";
    if (canvasLinkBtn) canvasLinkBtn.dataset.link = `${getShareBaseUrl()}/index.html?canvas=${shareToken}`;
    if (canvasPageNavGroup) canvasPageNavGroup.style.display = "flex";
    if (canvasPageInfo) canvasPageInfo.textContent = `1 / ${canvasTotalPages}`;
    if (canvasPrevBtn) canvasPrevBtn.disabled = true;
    if (canvasNextBtn) canvasNextBtn.disabled = canvasTotalPages <= 1;
    canvasRealtimeUnsubscribe?.();
    canvasRealtimeBroadcastProgress = null;
    const sub = subscribeStrokes(shareToken, (payload) => {
      if (payload?.type === "progress" && payload.pageNum === canvasPageNum) {
        canvasRemoteCurrentStroke = payload.stroke;
        if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
        return;
      }
      if (gestureState === "erasing") return;
      const row = payload?.new || payload?.newRecord || payload?.record;
      if (!row || row.share_token !== shareToken || row.page_num < 1) return;
      canvasRemoteCurrentStroke = null;
      const incoming = (row.strokes || []).map((s) => ({
        points: s.points || [],
        color: s.color || drawColor,
        lineWidth: s.lineWidth ?? drawLineWidth,
      }));
      const nextStrokes = incoming.map(cloneStroke);
      const loadedShapes = (row.shapes || []).map(cloneShape);
      const prevLayer = canvasStrokesByPage[row.page_num];
      const prevFills = prevLayer?.fillShapes || [];
      const fillClone = prevFills.map((f) => ({
        data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h),
        w: f.w,
        h: f.h,
      }));
      canvasStrokesByPage[row.page_num] = {
        strokes: nextStrokes,
        shapes: loadedShapes,
        fillShapes: fillClone,
      };
      if (row.page_num === canvasPageNum) {
        strokes = nextStrokes.map(cloneStroke);
        shapes = loadedShapes;
        fillShapes = fillClone.map((f) => ({
          data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h),
          w: f.w,
          h: f.h,
        }));
        if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      }
      if (row.fill_shapes !== undefined) {
        deserializeFillShapes(row.fill_shapes || []).then((loadedFills) => {
          const layer = canvasStrokesByPage[row.page_num];
          if (!layer) return;
          layer.fillShapes = loadedFills;
          if (row.page_num === canvasPageNum) {
            fillShapes = loadedFills;
            if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
          }
        });
      }
    });
    canvasRealtimeUnsubscribe = sub?.unsubscribe || sub;
    canvasRealtimeBroadcastProgress = sub?.broadcastProgress || null;
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
    updateDocumentOverlays();
    updateHeaderTitle();
    return true;
  } catch (err) {
    console.error("Canvas document load error:", err);
    return false;
  }
}

function updateCanvasSharedUI() {
  if (!canvasSharedToggleBtn || !canvasLinkBtn) return;
  canvasSharedToggleBtn.style.display = "none";
  if (isCanvasDocument) {
    canvasLinkBtn.style.display = currentCanvasShareToken ? "inline-flex" : "none";
    return;
  }
  canvasLinkBtn.style.display = !!currentCanvasShareToken ? "inline-flex" : "none";
}

async function createSharedCanvas() {
  if (!supabase) { alert("Сервис недоступен"); return; }
  localStrokes = strokes.map(cloneStroke);
  localShapes = shapes.map(cloneShape);
  localFillShapes = fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  localHistoryStack = historyStack.map((s) => ({
    strokes: s.strokes.map(cloneStroke),
    shapes: s.shapes.map(cloneShape),
    fillShapes: s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }))
  }));
  localHistoryIndex = historyIndex;
  const token = crypto.randomUUID().replace(/-/g, "");
  const saveRes = await savePageStrokes(token, CANVAS_PAGE, [], [], []);
  if (!saveRes) { alert("Не удалось создать сессию"); return; }
  currentCanvasShareToken = token;
  strokes = [];
  shapes = [];
  fillShapes = [];
  historyStack = [];
  historyIndex = -1;
  currentStroke = { points: [], color: drawColor };
  pushCanvasHistory();
  const link = `${getShareBaseUrl()}/index.html?canvas=${token}`;
  if (canvasLinkBtn) canvasLinkBtn.dataset.link = link;
  canvasRealtimeUnsubscribe?.();
  canvasRealtimeBroadcastProgress = null;
  const sub = subscribeStrokes(token, (payload) => {
    if (payload?.type === "progress" && payload.pageNum === CANVAS_PAGE) {
      canvasRemoteCurrentStroke = payload.stroke;
      if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      return;
    }
    if (gestureState === "erasing") return;
    const row = payload?.new || payload?.newRecord || payload?.record;
    if (!row || row.share_token !== token || row.page_num !== CANVAS_PAGE) return;
    canvasRemoteCurrentStroke = null;
    const incoming = (row.strokes || []).map((s) => ({
      points: s.points || [],
      color: s.color || drawColor,
      lineWidth: s.lineWidth ?? drawLineWidth,
    }));
    strokes = incoming;
    if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  });
  canvasRealtimeUnsubscribe = sub?.unsubscribe || sub;
  canvasRealtimeBroadcastProgress = sub?.broadcastProgress || null;
  if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  updateCanvasSharedUI();
}

function deleteSharedCanvas() {
  currentCanvasShareToken = null;
  canvasRealtimeUnsubscribe?.();
  canvasRealtimeUnsubscribe = null;
  canvasRealtimeBroadcastProgress = null;
  canvasRemoteCurrentStroke = null;
  if (canvasLinkBtn) canvasLinkBtn.dataset.link = "";
  strokes = localStrokes.map(cloneStroke);
  shapes = localShapes.map(cloneShape);
  fillShapes = localFillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }));
  historyStack = localHistoryStack.map((s) => ({
    strokes: s.strokes.map(cloneStroke),
    shapes: s.shapes.map(cloneShape),
    fillShapes: s.fillShapes.map((f) => ({ data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), w: f.w, h: f.h }))
  }));
  historyIndex = localHistoryIndex;
  currentStroke = { points: [], color: drawColor };
  if (localHistoryStack.length === 0) pushCanvasHistory();
  if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  updateCanvasSharedUI();
}

async function createOrCopyCanvasLink() {
  if (!currentCanvasShareToken) {
    await createSharedCanvas();
  }
  const link = canvasLinkBtn?.dataset?.link;
  if (link) {
    try {
      await navigator.clipboard.writeText(link);
      const orig = canvasLinkBtn?.textContent;
      if (canvasLinkBtn) canvasLinkBtn.textContent = "Скопировано!";
      setTimeout(() => { if (canvasLinkBtn) canvasLinkBtn.textContent = orig; }, 1500);
    } catch (_) {}
    await showShareLinkWithQr(link);
  }
}

// ========== PPTX РЕЖИМ ==========
function drawStrokesToPptxCanvas(w, h) {
  if (!pptxDrawCanvas) return;
  const dctx = pptxDrawCanvas.getContext("2d");
  dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  pptxFillShapes.forEach((f) => {
    const t = document.createElement("canvas");
    t.width = f.w; t.height = f.h;
    t.getContext("2d").putImageData(f.data, 0, 0);
    dctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
  });
  const defLw = drawLineWidth || 4;
  pptxShapes.forEach((sh) => {
    if (sh.type === "image") return;
    const color = sh.color || drawColor;
    const lw = sh.lineWidth ?? defLw;
    const fill = !!sh.fill;
    const opacity = sh.opacity ?? 1;
    dctx.strokeStyle = hexToRgba(color, opacity);
    dctx.lineWidth = lw;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    if (sh.type === "circle") {
      dctx.beginPath();
      dctx.arc(sh.cx * w, sh.cy * h, sh.r * Math.min(w, h), 0, Math.PI * 2);
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "rect") {
      const rx = (sh.w >= 0 ? sh.x : sh.x + sh.w) * w;
      const ry = (sh.h >= 0 ? sh.y : sh.y + sh.h) * h;
      const rw = Math.abs(sh.w) * w, rh = Math.abs(sh.h) * h;
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fillRect(rx, ry, rw, rh); }
      dctx.strokeRect(rx, ry, rw, rh);
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
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
      dctx.stroke();
    } else if (sh.type === "triangle") {
      dctx.beginPath();
      dctx.moveTo(sh.x1 * w, sh.y1 * h);
      dctx.lineTo(sh.x2 * w, sh.y2 * h);
      dctx.lineTo(sh.x3 * w, sh.y3 * h);
      dctx.closePath();
      if (fill) { dctx.fillStyle = hexToRgba(color, 0.4 * opacity); dctx.fill(); }
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
    } else if (sh.type === "text" && sh.text) {
      dctx.fillStyle = hexToRgba(color, opacity);
      dctx.font = `${sh.fontSize || 24}px sans-serif`;
      dctx.fillText(sh.text, sh.x * w, sh.y * h);
    }
  });
  if (pptxShapeInProgress) {
    const sp = pptxShapeInProgress;
    dctx.strokeStyle = hexToRgba(drawColor, 0.9);
    dctx.lineWidth = drawLineWidth;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    dctx.setLineDash([6, 4]);
    if (sp.type === "circle") {
      const diagNorm = Math.hypot(sp.end.x - sp.start.x, sp.end.y - sp.start.y);
      const rPx = Math.max((diagNorm / 2) * Math.min(w, h), 4);
      const cx = ((sp.start.x + sp.end.x) / 2) * w;
      const cy = ((sp.start.y + sp.end.y) / 2) * h;
      dctx.beginPath();
      dctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      dctx.stroke();
    } else if (sp.type === "rect" || sp.type === "ellipse") {
      const x1 = Math.min(sp.start.x, sp.end.x), x2 = Math.max(sp.start.x, sp.end.x);
      const y1 = Math.min(sp.start.y, sp.end.y), y2 = Math.max(sp.start.y, sp.end.y);
      const rw = Math.max((x2 - x1) * w, 1), rh = Math.max((y2 - y1) * h, 1);
      const cx = ((x1 + x2) / 2) * w, cy = ((y1 + y2) / 2) * h;
      if (sp.type === "rect") dctx.strokeRect(x1 * w, y1 * h, rw, rh);
      else { dctx.beginPath(); dctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2); dctx.stroke(); }
    } else if (sp.type === "line" || sp.type === "arrow") {
      const x1p = sp.start.x * w, y1p = sp.start.y * h, x2p = sp.end.x * w, y2p = sp.end.y * h;
      dctx.beginPath();
      dctx.moveTo(x1p, y1p);
      dctx.lineTo(x2p, y2p);
      dctx.stroke();
    } else if (sp.type === "triangle") {
      const dx = sp.end.x - sp.start.x, dy = sp.end.y - sp.start.y;
      const len = Math.hypot(dx, dy) || 0.001;
      const mx = (sp.start.x + sp.end.x) / 2, my = (sp.start.y + sp.end.y) / 2;
      const perpLen = len * 0.5;
      const px = mx - (dy / len) * perpLen, py = my + (dx / len) * perpLen;
      dctx.beginPath();
      dctx.moveTo(sp.start.x * w, sp.start.y * h);
      dctx.lineTo(sp.end.x * w, sp.end.y * h);
      dctx.lineTo(px * w, py * h);
      dctx.closePath();
      dctx.stroke();
    } else if (sp.type === "triangle_right") {
      dctx.beginPath();
      dctx.moveTo(sp.end.x * w, sp.end.y * h);
      dctx.lineTo(sp.start.x * w, sp.end.y * h);
      dctx.lineTo(sp.end.x * w, sp.start.y * h);
      dctx.closePath();
      dctx.stroke();
    }
    dctx.setLineDash([]);
  }
  const allStrokes = [...pptxStrokes, pptxCurrentStroke.points.length > 0 ? pptxCurrentStroke : null, pptxRemoteCurrentStroke].filter(Boolean);
  const sxPptx = (x) => x * w;
  const now = Date.now();
  allStrokes.forEach((stroke) => {
    if (stroke._ts && canvasFadeEnabled) {
      const age = now - stroke._ts;
      if (age > FADE_DURATION_MS) return;
      const fadeAlpha = Math.max(0, 1 - age / FADE_DURATION_MS);
      dctx.save();
      dctx.globalAlpha = fadeAlpha;
      drawStrokeWithTool(dctx, stroke, sxPptx, h);
      dctx.restore();
    } else {
      drawStrokeWithTool(dctx, stroke, sxPptx, h);
    }
  });
  pptxShapes.forEach((sh) => {
    if (sh.type === "image") drawPlacedImageShape(dctx, sh, w, h, (x) => x * w);
  });
  if (canvasFadeEnabled) {
    pptxStrokes = pptxStrokes.filter((s) => !s._ts || (now - s._ts) <= FADE_DURATION_MS);
    if (hasActiveFadeStrokes(pptxStrokes, now)) scheduleFadeTick();
  }
  drawSelectOverlay(dctx, w, h, sxPptx);
  drawCursorDot(dctx, w, h, true);
}

async function renderPptxSlide() {
  if (!pptxViewer || !pptxCanvas || !pptxDrawCanvas) return;
  const container = pptxContainer;
  const fs = isCanvasFullscreenMode();
  // pptxviewjs centers the slide with Math.min(scaleX, scaleY); canvas aspect must match slide EMU aspect
  // or gutters appear inside the bitmap and ink no longer lines up. Prefer getSlideDimensions() (cx/cy).
  const emu = pptxViewer.getSlideDimensions?.();
  if (emu && Number.isFinite(emu.cx) && Number.isFinite(emu.cy) && emu.cx > 0 && emu.cy > 0) {
    pptxAspectRatio = emu.cx / emu.cy;
  } else {
    const inferred = pptxViewer.getSlideSize?.() || pptxViewer.getPresentationSize?.() || pptxViewer.slideSize || pptxViewer.presentationSize;
    if (inferred && Number.isFinite(inferred.width) && Number.isFinite(inferred.height) && inferred.width > 0 && inferred.height > 0) {
      pptxAspectRatio = inferred.width / inferred.height;
    }
  }
  let targetW, targetH;
  const availW = fs
    ? (cameraWrapper?.clientWidth || container?.clientWidth || window.innerWidth || screen.width)
    : (container?.clientWidth || 800);
  targetW = Math.max(1, Math.ceil(availW));
  targetH = Math.max(1, Math.round(targetW / pptxAspectRatio));
  setWrapperAspect(targetW, targetH);
  pptxCanvas.style.width = "";
  pptxCanvas.style.height = "";
  pptxDrawCanvas.style.width = "";
  pptxDrawCanvas.style.height = "";
  pptxCanvas.width = targetW;
  pptxCanvas.height = targetH;
  pptxDrawCanvas.width = targetW;
  pptxDrawCanvas.height = targetH;
  await pptxViewer.goToSlide(pptxPageNum - 1);
  await pptxViewer.render();
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  let lw = parseFloat(pptxCanvas.style.width);
  let lh = parseFloat(pptxCanvas.style.height);
  if (!(lw > 0 && lh > 0)) {
    lw = Math.max(1, Math.round(pptxCanvas.width / dpr));
    lh = Math.max(1, Math.round(pptxCanvas.height / dpr));
  }
  lw = Math.max(1, Math.round(lw));
  lh = Math.max(1, Math.round(lh));
  if (pptxDrawCanvas.width !== lw || pptxDrawCanvas.height !== lh) {
    pptxDrawCanvas.width = lw;
    pptxDrawCanvas.height = lh;
  }
  drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
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
    if (!pptxViewer) pptxViewer = new PPTXViewer({ canvas: pptxCanvas });
    await pptxViewer.loadFile(file);
    pptxTotalPages = pptxViewer.getSlideCount?.() ?? 1;
    pptxPageNum = 1;
    pptxStrokesByPage = {};
    pptxShapesByPage = {};
    pptxStrokes = [];
    pptxShapes = [];
    pptxFillShapes = [];
    pptxCurrentStroke = { points: [], color: drawColor };
    if (cameraWrapper) cameraWrapper.classList.add("pptx-loaded");
    if (pdfPageInfo) pdfPageInfo.textContent = `1 / ${pptxTotalPages}`;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pptxTotalPages <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = false;
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
  let pptxEraserActive = false;
  let pptxEraseDirty = false;
  let pptxLastPtrNorm = null;
  let pptxSnapTimerId = null;
  let pptxSnapHoldState = { holdMs: 0, holdRef: null };
  let pptxFreehandSignificantAt = 0;
  const stopPptxSnapPoll = () => {
    if (pptxSnapTimerId != null) {
      clearInterval(pptxSnapTimerId);
      pptxSnapTimerId = null;
    }
    resetSnapHoldState(pptxSnapHoldState);
  };
  const pollPptxSketchSnap = () => {
    if (!pptxIsDrawing || drawShape !== "free" || !pptxCurrentStroke?.points?.length) return;
    const pts = pptxCurrentStroke.points;
    const ptr = pptxLastPtrNorm;
    if (
      tickSketchSnapHold(pptxSnapHoldState, ptr, pptxFreehandSignificantAt, pts.length, SKETCH_SNAP_MIN_POINTS, SKETCH_SNAP_HOLD_MS, SKETCH_SNAP_POLL_MS)
    ) {
      const draft = { ...pptxCurrentStroke, points: [...pts] };
      if (tryCommitSketchedShapeFromHold(pptxStrokes, pptxShapes, draft)) {
        pushPptxHistory();
        if (currentPptxShareToken) {
          savePptxPageState();
          savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
        }
        pptxCurrentStroke = { points: [], color: drawColor };
        pptxIsDrawing = false;
        pptxRemoteCurrentStroke = null;
        stopPptxSnapPoll();
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      }
    }
  };
  const onStart = (e) => {
    if (sharedDocReadOnly) return;
    if (!pptxMode || !pptxViewer) return;
    e.preventDefault();
    const p = getNorm(e);
    if (eraserMode) {
      pptxEraserActive = true;
      pptxEraseDirty = true;
      erasePptxAtPosition(p.x, p.y, 0.08);
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      return;
    }
    if (drawShape === "select") {
      const imgSel = getSingleSelectedPlacedImage(selectState, pptxShapes);
      if (imgSel) {
        const hHit = hitTestPlacedImageResizeHandle(p.x, p.y, imgSel.sh);
        if (hHit) {
          selectImageResizing = true;
          selectImageResizeStart = createPlacedImageResizeStart(imgSel.sh, hHit);
          selectScaleLastZ = null;
          selectScaleZSmooth = null;
          selectScaleGateMissFrames = 0;
          return;
        }
      }
      const ub = selectState ? selectionUnionBBoxFromSel(selectState, pptxStrokes, pptxShapes) : null;
      if (selectState && ub && pointInNormRect(p.x, p.y, ub)) {
        selectDragging = true;
        selectDragAnchor = { x: p.x, y: p.y };
        return;
      }
      selectState = null;
      selectMarqueeNorm = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    if (drawShape === "fill" && fillToolBtn?.classList.contains("active")) {
      doFillAtPptx(p.x * pptxDrawCanvas.width, p.y * pptxDrawCanvas.height, pptxDrawCanvas.width, pptxDrawCanvas.height);
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      return;
    }
    if (drawShape === "text") {
      const textInput = document.getElementById("textInputOverlay");
      if (textInput) {
        const rect = pptxDrawCanvas.getBoundingClientRect();
        const wr = pptxDrawCanvas.closest(".camera-wrapper")?.getBoundingClientRect() || rect;
        const px = (rect.left - wr.left) + p.x * rect.width, py = (rect.top - wr.top) + p.y * rect.height;
        textInput.style.left = px + "px";
        textInput.style.top = py + "px";
        textInput.style.display = "block";
        textInput.value = "";
        textInput.style.color = drawColor;
        textInput.focus();
        textInput.dataset.pendingX = String(p.x);
        textInput.dataset.pendingY = String(p.y);
      }
      return;
    }
    if (["circle", "rect", "line", "ellipse", "triangle", "triangle_right", "arrow"].includes(drawShape)) {
      pptxIsDrawing = true;
      pptxShapeInProgress = { start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, type: drawShape };
      return;
    }
    pptxIsDrawing = true;
    pptxCurrentStroke = { points: [{ x: p.x, y: p.y }], color: drawColor, lineWidth: drawLineWidth, opacity: strokeOpacity, toolType: drawToolType };
    pptxLastPtrNorm = { x: p.x, y: p.y };
    pptxFreehandSignificantAt = performance.now();
    stopPptxSnapPoll();
    pptxSnapTimerId = setInterval(pollPptxSketchSnap, SKETCH_SNAP_POLL_MS);
  };
  let lastBroadcastProgress = 0;
  const onMove = (e) => {
    const p = getNorm(e);
    if (drawShape === "select") {
      if (selectImageResizing && selectState) {
        const imgSel = getSingleSelectedPlacedImage(selectState, pptxShapes);
        if (imgSel?.sh && selectImageResizeStart) {
          if (!selectPointerButtonDown(e)) return;
          e.preventDefault();
          applyPlacedImageResize(imgSel.sh, selectImageResizeStart, p.x, p.y);
          drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
          return;
        }
      }
      if (selectDragging && selectState) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        const dx = p.x - selectDragAnchor.x;
        const dy = p.y - selectDragAnchor.y;
        selectDragAnchor = { x: p.x, y: p.y };
        applySelectionOffset(selectState, dx, dy, pptxStrokes, pptxShapes);
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        if (!selectPointerButtonDown(e)) return;
        e.preventDefault();
        selectMarqueeNorm.x1 = p.x;
        selectMarqueeNorm.y1 = p.y;
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
        return;
      }
    }
    if (eraserMode && (pptxEraserActive || e.buttons === 1)) {
      e.preventDefault();
      pptxEraseDirty = true;
      erasePptxAtPosition(p.x, p.y, 0.08);
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      return;
    }
    if (pptxShapeInProgress) {
      e.preventDefault();
      pptxShapeInProgress.end = { x: p.x, y: p.y };
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      return;
    }
    if (!pptxIsDrawing || !pptxCurrentStroke.points.length) return;
    e.preventDefault();
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      pptxLastPtrNorm = { x: p.x, y: p.y };
      const lastPt = pptxCurrentStroke.points[pptxCurrentStroke.points.length - 1];
      const step = lastPt ? Math.hypot(p.x - lastPt.x, p.y - lastPt.y) : 1;
      if (!lastPt || step >= MIN_STROKE_DIST) {
        pptxCurrentStroke.points.push({ x: p.x, y: p.y });
        if (!lastPt || step >= FREEHAND_SNAP_SIGNIFICANT_STEP) pptxFreehandSignificantAt = performance.now();
      }
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      const now = Date.now();
      if (currentPptxShareToken && pptxRealtimeBroadcastProgress && (now - lastBroadcastProgress >= 50 || pptxCurrentStroke.points.length % 5 === 0)) {
        lastBroadcastProgress = now;
        pptxRealtimeBroadcastProgress(pptxPageNum, pptxCurrentStroke);
      }
    }
  };
  const onEnd = (e) => {
    pptxEraserActive = false;
    stopPptxSnapPoll();
    if (pptxEraseDirty) {
      pptxEraseDirty = false;
      pushPptxHistory();
      if (currentPptxShareToken) {
        savePptxPageState();
        savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      }
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    }
    if (drawShape === "select") {
      e.preventDefault();
      if (selectImageResizing) {
        selectImageResizing = false;
        selectImageResizeStart = null;
        pushPptxHistory();
        if (currentPptxShareToken) {
          savePptxPageState();
          savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
        }
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
        return;
      }
      if (selectDragging) {
        selectDragging = false;
        selectDragAnchor = null;
        pushPptxHistory();
        if (currentPptxShareToken) {
          savePptxPageState();
          savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
        }
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
        return;
      }
      if (selectMarqueeNorm) {
        const m = selectMarqueeNorm;
        const wN = Math.abs(m.x1 - m.x0), hN = Math.abs(m.y1 - m.y0);
        if (wN >= MIN_SELECT_NORM || hN >= MIN_SELECT_NORM) {
          const rect = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
          const picked = pickSelectionInRect(rect, pptxStrokes, pptxShapes);
          selectState = picked.strokeIdx.length || picked.shapeIdx.length ? picked : null;
        } else selectState = null;
        selectMarqueeNorm = null;
        drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
        return;
      }
    }
    if (pptxShapeInProgress) {
      e.preventDefault();
      const s = pptxShapeInProgress.start, t = pptxShapeInProgress.end;
      const x1 = Math.min(s.x, t.x), x2 = Math.max(s.x, t.x);
      const y1 = Math.min(s.y, t.y), y2 = Math.max(s.y, t.y);
      const sh = { color: drawColor, lineWidth: drawLineWidth, fill: shapeFill, opacity: strokeOpacity };
      if (pptxShapeInProgress.type === "circle") {
        sh.type = "circle";
        sh.cx = (x1 + x2) / 2; sh.cy = (y1 + y2) / 2;
        sh.r = Math.hypot(x2 - x1, y2 - y1) / 2;
      } else if (pptxShapeInProgress.type === "rect") {
        sh.type = "rect"; sh.x = s.x; sh.y = s.y; sh.w = t.x - s.x; sh.h = t.y - s.y;
      } else if (pptxShapeInProgress.type === "line" || pptxShapeInProgress.type === "arrow") {
        sh.type = pptxShapeInProgress.type; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
      } else if (pptxShapeInProgress.type === "ellipse") {
        sh.type = "ellipse"; sh.x = x1; sh.y = y1; sh.w = x2 - x1; sh.h = y2 - y1;
      } else if (pptxShapeInProgress.type === "triangle") {
        const dx = t.x - s.x, dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 0.001;
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        const perpLen = len * 0.5;
        sh.type = "triangle"; sh.x1 = s.x; sh.y1 = s.y; sh.x2 = t.x; sh.y2 = t.y;
        sh.x3 = mx - (dy / len) * perpLen; sh.y3 = my + (dx / len) * perpLen;
      } else if (pptxShapeInProgress.type === "triangle_right") {
        sh.type = "triangle"; sh.x1 = t.x; sh.y1 = t.y; sh.x2 = s.x; sh.y2 = t.y; sh.x3 = t.x; sh.y3 = s.y;
      }
      if (sh.type) {
        pptxShapes.push(sh);
        pushPptxHistory();
        if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      }
      pptxShapeInProgress = null;
      pptxIsDrawing = false;
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      return;
    }
    if (!pptxIsDrawing) return;
    e.preventDefault();
    pptxIsDrawing = false;
    if (pptxCurrentStroke.points.length > 1) {
      const stroke = { ...pptxCurrentStroke };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      pptxStrokes.push(stroke);
      pushPptxHistory();
      if (currentPptxShareToken) {
        savePptxPageState();
        savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      }
    }
    pptxRemoteCurrentStroke = null;
    pptxCurrentStroke = { points: [], color: drawColor };
  };
  pptxDrawCanvas.addEventListener("mousedown", onStart);
  pptxDrawCanvas.addEventListener("mousemove", onMove);
  pptxDrawCanvas.addEventListener("mouseup", onEnd);
  pptxDrawCanvas.addEventListener("mouseleave", onEnd);
  pptxDrawCanvas.addEventListener("touchstart", onStart, { passive: false });
  pptxDrawCanvas.addEventListener("touchmove", onMove, { passive: false });
  pptxDrawCanvas.addEventListener("touchend", onEnd, { passive: false });
  pptxDrawCanvas.addEventListener("touchcancel", onEnd, { passive: false });
}

function clearPptx() {
  try {
    pptxViewer?.dispose?.();
  } catch (_) {}
  pptxViewer = null;
  currentPptxShareToken = null;
  pptxRealtimeUnsubscribe?.();
  pptxRealtimeUnsubscribe = null;
  pptxPageNum = 1;
  pptxTotalPages = 0;
  pptxStrokes = [];
  pptxShapes = [];
  pptxFillShapes = [];
  pptxStrokesByPage = {};
  pptxShapesByPage = {};
  pptxCurrentStroke = { points: [], color: drawColor };
  pptxShapeInProgress = null;
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

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
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
          if (showSkeleton) drawPoseSkeleton(ctx, lm, w, h, MIRROR_CAMERA, MIN_VIS);
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
            if (showSkeleton) drawEyeContours(ctx, faceRes.faceLandmarks[0], w, h, MIRROR_CAMERA);
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
          cachedOffHandLandmark = null;
          if (drawMode && drawShape === "select" && !embedTrackBothHands) {
            for (let i = 0; i < rawLm.length; i++) {
              const h = handedness[i];
              const label = (h?.[0]?.categoryName || h?.[0]?.display_name || (typeof h === "string" ? h : "") || "").toLowerCase();
              if (label && label !== preferredHand) {
                cachedOffHandLandmark = rawLm[i];
                break;
              }
            }
          }
          handLandmarks = [];
          for (let i = 0; i < rawLm.length; i++) {
            if (embedTrackBothHands) {
              handLandmarks.push(rawLm[i]);
            } else {
              const h = handedness[i];
              const label = (h?.[0]?.categoryName || h?.[0]?.display_name || (typeof h === "string" ? h : "") || "").toLowerCase();
              if (label === preferredHand) {
                handLandmarks.push(rawLm[i]);
              }
            }
          }
          cachedHandLandmarks = handLandmarks;
          if (showSkeleton) drawHandLandmarks(ctx, handLandmarks, w, h, MIRROR_CAMERA);
        } catch (_) {}
      }
    } else {
      lm = cachedLm;
      window.eyesClosed = cachedEyesClosed;
      handLandmarks = cachedHandLandmarks || [];
      if (lm && showSkeleton) drawPoseSkeleton(ctx, lm, w, h, MIRROR_CAMERA, MIN_VIS);
      if (handLandmarks?.length && showSkeleton) drawHandLandmarks(ctx, handLandmarks, w, h, MIRROR_CAMERA);
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
      if (twoFingerPos && !cursorPos) twoFingerHeldFrames = Math.min(10, twoFingerHeldFrames + 1);
      else twoFingerHeldFrames = Math.max(0, twoFingerHeldFrames - 1);

      // 5a. Панель: указательный над полосой слева или панелью = мышь, щепотка = клик
      const overToolbar = cursorPos && (() => {
        const normX = MIRROR_CAMERA ? (1 - cursorPos.x) : cursorPos.x;
        const { clientX, clientY } = normToClient(cursorPos.x, cursorPos.y, w, h);
        return normX < 0.06 || isPointOverToolbar(clientX, clientY);
      })();
      drawToolbarGestureInside = !!overToolbar;

      {
        const nowMs = performance.now();
        const handForMiddle =
          handIdx >= 0
            ? handLandmarks[handIdx]
            : twoFingerHandIdx >= 0
              ? handLandmarks[twoFingerHandIdx]
              : null;
        if (handForMiddle && !overToolbar && !sharedDocReadOnly) {
          const touching = stepMiddleThumbTouching(handForMiddle, middleThumbTouchingHyst);
          middleThumbTouchingHyst = touching;
          if (
            nowMs >= gestureModeCycleCooldownUntil &&
            gestureState !== "drawing" &&
            gestureState !== "erasing" &&
            touching &&
            !middleThumbWasTouching
          ) {
            handleMiddleThumbTapRisingEdge(nowMs);
          }
          middleThumbWasTouching = touching;
        } else {
          middleThumbTouchingHyst = false;
          middleThumbWasTouching = false;
        }
      }

      if (overToolbar) {
        shapeInProgress = null;
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
      } else if ((gestureState === "erasing" && twoFingerPos) || (gestureState === "idle" && twoFingerPos && !cursorPos && framesSinceDraw >= GESTURE_LOCK_FRAMES && twoFingerHeldFrames >= 4)) {
        if (gestureState !== "erasing") {
          gestureState = "erasing";
          fingerLostFrames = 0;
          wasPinching = false;
          shapeInProgress = null;
          activeCurrentStroke.points = [];
          activeCurrentStroke.color = drawColor;
          resetSnapHoldState(gestureSnapHoldState);
          gestureFreehandSignificantAt = 0;
          gestureSnapHoldFrameAt = 0;
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
        const activeFills = pdfMode ? pdfFillShapes : (pptxMode ? pptxFillShapes : fillShapes);
        const erased = eraseLayerAtPosition(activeStrokes, activeShapes, eraseX, smoothedErasePos.y, 0.09, activeFills, drawColor, drawLineWidth);
        activeStrokes = erased.strokes;
        activeShapes = erased.shapes;
        if (pdfMode && pdfDoc) { pdfStrokes = erased.strokes; pdfShapes = erased.shapes; pdfFillShapes = erased.fillShapes || pdfFillShapes; }
        else if (pptxMode && pptxViewer) { pptxStrokes = erased.strokes; pptxShapes = erased.shapes; pptxFillShapes = erased.fillShapes || pptxFillShapes; }
        else { strokes = erased.strokes; shapes = erased.shapes; fillShapes = erased.fillShapes || fillShapes; }
        activeRedraw();
      } else if (cursorPos) {
        if (gestureState === "erasing") {
          if (pdfMode && pdfDoc) {
            pushPdfHistory();
            savePdfPageState();
          } else if (pptxMode && pptxViewer) {
            pushPptxHistory();
            savePptxPageState();
          } else if (!pdfMode && !pptxMode) {
            pushCanvasHistory();
          }
          if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes, true);
          if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes, true);
          if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
            savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
          }
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
        const pinchStart = getPinchStartThreshold(hand);
        const pinchRelease = getPinchReleaseThreshold(hand);
        if (gestureState === "idle" && rawDist < pinchStart) {
          smoothedThumbIndexDist = rawDist;
        } else {
          smoothedThumbIndexDist = smoothedThumbIndexDist * (1 - DIST_SMOOTH_ALPHA) + rawDist * DIST_SMOOTH_ALPHA;
        }
        let isPinchActive = false;
        if (gestureState === "drawing") {
          if (smoothedThumbIndexDist > pinchRelease) {
            pinchReleaseFrames++;
            if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) {
              if (activeCurrentStroke.points.length > 1) {
                const stroke = {
                  points: [...activeCurrentStroke.points],
                  color: activeCurrentStroke.color || drawColor,
                  lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth,
                  opacity: activeCurrentStroke.opacity ?? strokeOpacity,
                };
                if (canvasFadeEnabled) {
                  stroke._ts = Date.now();
                  scheduleFadeTick();
                }
                activeStrokes.push(stroke);
                if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
                if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
                if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
                  savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
                }
              }
              activeCurrentStroke.points = [];
              activeCurrentStroke.color = drawColor;
              activeCurrentStroke.lineWidth = drawLineWidth;
              resetSnapHoldState(gestureSnapHoldState);
              gestureFreehandSignificantAt = 0;
              gestureSnapHoldFrameAt = 0;
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
          if (smoothedThumbIndexDist < pinchStart && framesSinceErase >= GESTURE_LOCK_FRAMES) {
            gestureState = "drawing";
            activeCurrentStroke.points = [];
            resetSnapHoldState(gestureSnapHoldState);
            gestureFreehandSignificantAt = performance.now();
            gestureSnapHoldFrameAt = 0;
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
          if (drawShape === "fill" && fillToolBtn?.classList.contains("active") && pinchPos && !wasPinching) {
            const cw = (pdfMode && pdfDrawCanvas) ? pdfDrawCanvas.width : (pptxMode && pptxDrawCanvas) ? pptxDrawCanvas.width : drawCanvas?.width || output?.width || 1;
            const ch = (pdfMode && pdfDrawCanvas) ? pdfDrawCanvas.height : (pptxMode && pptxDrawCanvas) ? pptxDrawCanvas.height : drawCanvas?.height || output?.height || 1;
            const px = clamp01(drawPinchX) * cw;
            const py = clamp01(pinchPos.y) * ch;
            if (pdfMode && pdfDoc) {
              doFillAtPdf(px, py, cw, ch);
              drawStrokesToPdfCanvas(cw, ch);
            } else if (drawCanvas) {
              const fx = MIRROR_CAMERA ? (1 - clamp01(drawPinchX)) * cw : px;
              doFillAtCanvas(fx, py, cw, ch);
              drawStrokesToCanvas(cw, ch);
            }
          }
          if (drawShape === "select" && pinchPos) {
            const px = clamp01(drawPinchX), py = clamp01(pinchPos.y);
            if (!wasPinching) {
              const ub = selectState ? selectionUnionBBoxFromSel(selectState, activeStrokes, activeShapes) : null;
              if (selectState && ub && pointInNormRect(px, py, ub)) {
                selectDragging = true;
                selectDragAnchor = { x: px, y: py };
                selectMarqueeNorm = null;
                selectScaleLastZ = null;
                selectScaleZSmooth = null;
                selectScaleGateMissFrames = 0;
              } else {
                selectState = null;
                selectDragging = false;
                selectDragAnchor = null;
                selectMarqueeNorm = { x0: px, y0: py, x1: px, y1: py };
              }
            } else if (selectDragging && selectState) {
              const dx = px - selectDragAnchor.x;
              const dy = py - selectDragAnchor.y;
              selectDragAnchor = { x: px, y: py };
              applySelectionOffset(selectState, dx, dy, activeStrokes, activeShapes);
              // Diğer el: başparmak–işaret AÇIK (O/daire); aktif el pinch kameraya göre ileri/geri → büyüt/küçült
              const offHand = getOffHandForSelectGate(handLandmarks, handIdx, embedTrackBothHands, cachedOffHandLandmark);
              const gateOK =
                offHand &&
                offHand.length >= 9 &&
                isThumbIndexSpreadGate(offHand) &&
                hand &&
                hand.length >= 9 &&
                isPinchActive;
              if (gateOK) {
                selectScaleGateMissFrames = 0;
                const gt = offHand[4], gi = offHand[8];
                const midAx = (hand[4].x + hand[8].x) / 2;
                const midAy = (hand[4].y + hand[8].y) / 2;
                const gateDist = pointSegDistNorm(midAx, midAy, gt.x, gt.y, gi.x, gi.y);
                const hsOff = getHandSize(offHand);
                const gateTol = Math.max(0.16, hsOff * 0.85);
                if (gateDist < gateTol) {
                  const zRaw = getActivePinchDepthRel(hand);
                  if (selectScaleZSmooth == null) selectScaleZSmooth = zRaw;
                  else selectScaleZSmooth = selectScaleZSmooth * 0.72 + zRaw * 0.28;
                  const Z_TH = 0.00115;
                  const STEP = 1.04;
                  if (selectScaleLastZ == null) {
                    selectScaleLastZ = selectScaleZSmooth;
                  } else {
                    const dz = selectScaleZSmooth - selectScaleLastZ;
                    // Bileğe göre: pinch kameraya yaklaşınca genelde rel Z azalır → büyüt
                    if (dz > Z_TH) {
                      applySelectionScale(selectState, 1 / STEP, activeStrokes, activeShapes);
                      selectScaleLastZ = selectScaleZSmooth;
                      activeRedraw();
                    } else if (dz < -Z_TH) {
                      applySelectionScale(selectState, STEP, activeStrokes, activeShapes);
                      selectScaleLastZ = selectScaleZSmooth;
                      activeRedraw();
                    }
                  }
                } else {
                  selectScaleGateMissFrames++;
                  if (selectScaleGateMissFrames > 18) {
                    selectScaleLastZ = null;
                    selectScaleZSmooth = null;
                  }
                }
              } else {
                selectScaleGateMissFrames++;
                if (selectScaleGateMissFrames > 18) {
                  selectScaleLastZ = null;
                  selectScaleZSmooth = null;
                }
              }
            } else if (selectMarqueeNorm) {
              selectMarqueeNorm.x1 = px;
              selectMarqueeNorm.y1 = py;
            }
          } else if (["circle","rect","line","ellipse","triangle","triangle_right","arrow"].includes(drawShape)) {
            if (pinchPos) {
              const px = clamp01(drawPinchX), py = clamp01(pinchPos.y);
              if (!shapeInProgress) shapeInProgress = { start: { x: px, y: py }, end: { x: px, y: py }, type: drawShape };
              else shapeInProgress.end = { x: px, y: py };
            }
          } else {
            const cx = clamp01(drawCursorX), cy = clamp01(smoothedCursor.y);
            const lastG = activeCurrentStroke.points[activeCurrentStroke.points.length - 1];
            const gStep = lastG ? Math.hypot(cx - lastG.x, cy - lastG.y) : 1;
            if (!lastG || gStep >= MIN_STROKE_DIST) {
              activeCurrentStroke.points.push({ x: cx, y: cy });
              if (!lastG || gStep >= FREEHAND_SNAP_SIGNIFICANT_STEP) gestureFreehandSignificantAt = performance.now();
            }
            activeCurrentStroke.color = activeCurrentStroke.color || drawColor;
            activeCurrentStroke.lineWidth = activeCurrentStroke.lineWidth ?? drawLineWidth;
            const now = Date.now();
            if (activeCurrentStroke.points.length >= 2 && (now - lastGestureBroadcastProgress >= 50 || activeCurrentStroke.points.length % 5 === 0)) {
              lastGestureBroadcastProgress = now;
              if (pdfMode && currentPdfShareToken && pdfRealtimeBroadcastProgress) {
                pdfRealtimeBroadcastProgress(pdfPageNum, activeCurrentStroke);
              } else if (pptxMode && currentPptxShareToken && pptxRealtimeBroadcastProgress) {
                pptxRealtimeBroadcastProgress(pptxPageNum, activeCurrentStroke);
              } else if (!pdfMode && !pptxMode && currentCanvasShareToken && canvasRealtimeBroadcastProgress) {
                canvasRealtimeBroadcastProgress(getCurrentCanvasPageNum(), activeCurrentStroke);
              }
            }
            const pts = activeCurrentStroke.points;
            const nowP = performance.now();
            const dt = gestureSnapHoldFrameAt ? Math.min(100, Math.max(8, nowP - gestureSnapHoldFrameAt)) : SKETCH_SNAP_POLL_MS;
            gestureSnapHoldFrameAt = nowP;
            if (
              tickSketchSnapHold(gestureSnapHoldState, { x: cx, y: cy }, gestureFreehandSignificantAt, pts.length, SKETCH_SNAP_MIN_POINTS, SKETCH_SNAP_HOLD_MS, dt)
            ) {
              const draft = { ...activeCurrentStroke, points: [...pts] };
              if (tryCommitSketchedShapeFromHold(activeStrokes, activeShapes, draft)) {
                resetSnapHoldState(gestureSnapHoldState);
                gestureSnapHoldFrameAt = 0;
                activeCurrentStroke.points = [];
                activeCurrentStroke.color = drawColor;
                if (pdfMode && pdfDoc) pushPdfHistory();
                else if (pptxMode && pptxViewer) pushPptxHistory();
                else pushCanvasHistory();
                if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
                if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
                if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
                  savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
                }
                activeRedraw();
              }
            }
          }
          wasPinching = true;
        } else {
          if (drawShape === "select" && wasPinching) {
            finalizeSelectGestureEnd();
          }
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
              const fill = shapeFill;
              if (shapeInProgress.type === "circle") {
                activeShapes.push({ type: "circle", cx, cy, r: Math.max(diag / 2, minSize / 2), color: drawColor, lineWidth: lw, fill });
              } else if (shapeInProgress.type === "rect") {
                const rs = shapeInProgress.start, re = shapeInProgress.end;
                activeShapes.push({ type: "rect", x: rs.x, y: rs.y, w: re.x - rs.x, h: re.y - rs.y, color: drawColor, lineWidth: lw, fill });
              } else if (shapeInProgress.type === "line") {
                activeShapes.push({ type: "line", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              } else if (shapeInProgress.type === "ellipse") {
                activeShapes.push({ type: "ellipse", x: x1, y: y1, w, h, color: drawColor, lineWidth: lw, fill });
              } else if (shapeInProgress.type === "triangle") {
                const dx = e.x - s.x, dy = e.y - s.y;
                const len = Math.hypot(dx, dy) || 0.001;
                const mx = (s.x + e.x) / 2, my = (s.y + e.y) / 2;
                const perpLen = len * 0.5;
                const x3 = mx - (dy / len) * perpLen, y3 = my + (dx / len) * perpLen;
                activeShapes.push({ type: "triangle", x1: s.x, y1: s.y, x2: e.x, y2: e.y, x3, y3, color: drawColor, lineWidth: lw, fill });
              } else if (shapeInProgress.type === "triangle_right") {
                activeShapes.push({ type: "triangle", x1: e.x, y1: e.y, x2: s.x, y2: e.y, x3: e.x, y3: s.y, color: drawColor, lineWidth: lw, fill });
              } else if (shapeInProgress.type === "arrow") {
                activeShapes.push({ type: "arrow", x1: s.x, y1: s.y, x2: e.x, y2: e.y, color: drawColor, lineWidth: lw });
              }
            }
            shapeInProgress = null;
          }
          wasPinching = false;
          fingerLostFrames++;
          if (fingerLostFrames >= FINGER_LOST_THRESHOLD && activeCurrentStroke.points.length > 0) {
            const stroke = {
              points: [...activeCurrentStroke.points],
              color: activeCurrentStroke.color || drawColor,
              lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth,
              opacity: activeCurrentStroke.opacity ?? strokeOpacity,
            };
            if (canvasFadeEnabled) {
              stroke._ts = Date.now();
              scheduleFadeTick();
            }
            activeStrokes.push(stroke);
            if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
            if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
            if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
              savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
            }
            activeCurrentStroke.points = [];
            activeCurrentStroke.color = drawColor;
            resetSnapHoldState(gestureSnapHoldState);
            gestureFreehandSignificantAt = 0;
            gestureSnapHoldFrameAt = 0;
            smoothedCursor = null;
            smoothedPinch = null;
          }
        }
      } else {
        if (gestureState === "erasing") {
          if (pdfMode && pdfDoc) {
            pushPdfHistory();
            savePdfPageState();
          } else if (pptxMode && pptxViewer) {
            pushPptxHistory();
            savePptxPageState();
          } else if (!pdfMode && !pptxMode) {
            pushCanvasHistory();
          }
          if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes, true);
          if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes, true);
          if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
            savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
          }
          lastEraseEndTime = Date.now();
        }
        window.drawCursor = null;
        if (drawMode && handLandmarker && drawShape === "select" && (selectMarqueeNorm || selectDragging || selectImageResizing)) {
          finalizeSelectGestureEnd();
        }
        wasPinching = false;
        shapeInProgress = null;
        gestureState = "idle";
        smoothedErasePos = null;
        pinchReleaseFrames = 0;
        fingerLostFrames++;
        if (fingerLostFrames >= FINGER_LOST_THRESHOLD && activeCurrentStroke.points.length > 0) {
          const stroke = {
            points: [...activeCurrentStroke.points],
            color: activeCurrentStroke.color || drawColor,
            lineWidth: activeCurrentStroke.lineWidth ?? drawLineWidth,
            opacity: activeCurrentStroke.opacity ?? strokeOpacity,
          };
          if (canvasFadeEnabled) {
            stroke._ts = Date.now();
            scheduleFadeTick();
          }
          activeStrokes.push(stroke);
          if (pdfMode && currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, activeStrokes);
          if (pptxMode && currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
          if (!pdfMode && !pptxMode && currentCanvasShareToken && supabase) {
            savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
          }
          activeCurrentStroke.points = [];
          activeCurrentStroke.color = drawColor;
          resetSnapHoldState(gestureSnapHoldState);
          gestureFreehandSignificantAt = 0;
          gestureSnapHoldFrameAt = 0;
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
      drawToolbarGestureInside = false;
      window.drawCursor = null;
      smoothedCursor = null;
      smoothedPinch = null;
      updateGestureCursor(0, 0, false);
    }
    updateDrawToolbarOpenState();
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
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = "high";
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
        drawHandLandmarks(pctx, handLandmarks, w, h, MIRROR_CAMERA);
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

async function ensureMediaPipeModelsLoaded() {
  if (poseLandmarker && faceLandmarker && handLandmarker) return;
  if (!mediaPipeLoadPromise) {
    mediaPipeLoadPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM);
      const [p, f, h] = await Promise.all([
        PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.25,
          minTrackingConfidence: 0.25,
        }),
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
        }),
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.2,
          minHandPresenceConfidence: 0.2,
          minTrackingConfidence: 0.2,
        }),
      ]);
      poseLandmarker = p;
      faceLandmarker = f;
      handLandmarker = h;
    })();
  }
  try {
    await mediaPipeLoadPromise;
  } catch (err) {
    mediaPipeLoadPromise = null;
    poseLandmarker = faceLandmarker = handLandmarker = null;
    console.error("Ошибка загрузки модели:", err);
  }
}

async function openCameraStreamWithFallback() {
  const tries = [
    {
      video: {
        facingMode: "user",
        width: { ideal: VIDEO_WIDTH, max: 1920 },
        height: { ideal: VIDEO_HEIGHT, max: 1080 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: "user",
      },
      audio: false,
    },
    {
      video: true,
      audio: false,
    },
  ];
  let lastErr = null;
  for (const c of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Не удалось открыть камеру");
}

// ========== ЗАПУСК КАМЕРЫ ==========
async function startCamera() {
  if (stream?.active && video?.srcObject) return;
  if (cameraStartPromise) return cameraStartPromise;
  const epoch = ++cameraStartEpoch;
  cameraStartPromise = (async () => {
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

      ensureMediaPipeModelsLoaded().catch(() => {});

      stream = await openCameraStreamWithFallback();
      if (epoch !== cameraStartEpoch) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        return;
      }

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
      setTimeout(() => scheduleDocRefitStable(), 150);
      if (modeWhiteSheetBtn) modeWhiteSheetBtn.disabled = false;
      if (drawBtn) drawBtn.disabled = false;
      if (clearDrawBtn) clearDrawBtn.disabled = false;
      objectsBtn.disabled = false;
      addObjBtn.disabled = false;
      removeObjBtn.disabled = false;
      startBtn.textContent = "Запустить камеру";

      lastVideoTime = -1;
      if (gestureControlEnabled) {
        drawMode = true;
        drawBtn?.classList.add("active");
      }
      detectLoop();
    } catch (err) {
      console.error("Ошибка камеры:", err);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      video.srcObject = null;
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
    } finally {
      cameraStartPromise = null;
    }
  })();
  return cameraStartPromise;
}

// ========== ОСТАНОВКА КАМЕРЫ ==========
function stopCamera() {
  cameraStartEpoch++;
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
  const inDrawingMode = whiteSheetMode && !pdfMode && !pptxMode;
  if (!inDrawingMode) {
    if (drawBtn) drawBtn.disabled = true;
    if (clearDrawBtn) clearDrawBtn.disabled = true;
    if (objectsBtn) objectsBtn.disabled = true;
    if (addObjBtn) addObjBtn.disabled = true;
    if (removeObjBtn) removeObjBtn.disabled = true;
    drawMode = false;
    objectsMode = false;
    drawBtn?.classList.remove("active");
    objectsBtn?.classList.remove("active");
  }
  objectsBtn.textContent = "🔮 Объекты";
  if (!inDrawingMode) {
    strokes = [];
    shapes = [];
    currentStroke = { points: [], color: drawColor };
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  } else if (drawCanvas) {
    drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  }
}

// ========== Горячие клавиши (PDF / PPTX / многостраничный холст) ==========
function isTextEntryShortcutTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function shouldIgnoreDrawflowHotkeys(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (isTextEntryShortcutTarget(e.target)) return true;
  if (e.target.closest?.("#shareLinkQrOverlay")) return true;
  const ti = document.getElementById("textInputOverlay");
  if (ti && ti.style.display === "block") return true;
  const pdfPwd = document.getElementById("pdfPasswordOverlay");
  if (pdfPwd && pdfPwd.style.display === "flex") return true;
  const clearM = document.getElementById("clearPageModal");
  if (clearM && clearM.style.display === "flex") return true;
  return false;
}

function tryNavigateCanvasPagePrev() {
  if (!isCanvasDocument || !canvasPageNavGroup || canvasPageNavGroup.style.display === "none") return false;
  if (canvasPrevBtn?.disabled) return false;
  canvasPrevBtn.click();
  return true;
}

function tryNavigateCanvasPageNext() {
  if (!isCanvasDocument || !canvasPageNavGroup || canvasPageNavGroup.style.display === "none") return false;
  if (canvasNextBtn?.disabled) return false;
  canvasNextBtn.click();
  return true;
}

function tryNavigatePdfPptxPrev() {
  const docOk = (pdfMode && pdfDoc) || (pptxMode && pptxViewer);
  if (!docOk) return false;
  if (pdfNavGroup && pdfNavGroup.style.display === "none") return false;
  if (pdfPrevBtn?.disabled) return false;
  pdfPrevBtn.click();
  return true;
}

function tryNavigatePdfPptxNext() {
  const docOk = (pdfMode && pdfDoc) || (pptxMode && pptxViewer);
  if (!docOk) return false;
  if (pdfNavGroup && pdfNavGroup.style.display === "none") return false;
  if (pdfNextBtn?.disabled) return false;
  pdfNextBtn.click();
  return true;
}

function tryNavigateDocPrev() {
  if (tryNavigateCanvasPagePrev()) return true;
  return tryNavigatePdfPptxPrev();
}

function tryNavigateDocNext() {
  if (tryNavigateCanvasPageNext()) return true;
  return tryNavigatePdfPptxNext();
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
    return;
  }

  if (shouldIgnoreDrawflowHotkeys(e)) return;

  if (e.code === "F4") {
    if (sharedDocReadOnly) return;
    const gc = gestureControlBtn;
    if (!gc || gc.offsetParent === null) return;
    e.preventDefault();
    gc.click();
    return;
  }

  const prevKeys = e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp";
  const nextKeys = e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown";
  if (prevKeys) {
    if (tryNavigateDocPrev()) e.preventDefault();
    return;
  }
  if (nextKeys) {
    if (tryNavigateDocNext()) e.preventDefault();
    return;
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
  whiteSheetMode = true;
  blackSheetMode = false;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pdf-loaded", "pdf-landscape-fit", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("white-sheet-mode");
  modeCameraBtn?.classList.add("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
  if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
  if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
  if (modePdfBtn) modePdfBtn.style.display = "";
  if (!gestureControlEnabled) cameraOverlay?.classList.add("hidden");
  restoreCameraAspect();
  scheduleDocRefit();
  updateDocumentOverlays();
  updateCanvasSharedUI();
  updateHeaderTitle();
});

modeWhiteSheetBtn?.addEventListener("click", () => {
  whiteSheetMode = true;
  blackSheetMode = false;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pdf-loaded", "pdf-landscape-fit", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("white-sheet-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.add("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
  if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
  if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
  if (modePdfBtn) modePdfBtn.style.display = "";
  if (!gestureControlEnabled) cameraOverlay?.classList.add("hidden");
  restoreCameraAspect();
  scheduleDocRefit();
  updateDocumentOverlays();
  updateCanvasSharedUI();
  updateHeaderTitle();
});

modeBlackSheetBtn?.addEventListener("click", () => {
  whiteSheetMode = true;
  blackSheetMode = true;
  pdfMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("pdf-mode", "pdf-loaded", "pdf-landscape-fit", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("white-sheet-mode", "black-sheet-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.add("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.remove("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "none";
  if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
  if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
  if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
  if (modePdfBtn) modePdfBtn.style.display = "";
  if (!gestureControlEnabled) cameraOverlay?.classList.add("hidden");
  restoreCameraAspect();
  scheduleDocRefit();
  updateDocumentOverlays();
  updateCanvasSharedUI();
  updateHeaderTitle();
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
  if (drawingControlsGroup) drawingControlsGroup.style.display = "none";
  if (cameraControlsGroup) cameraControlsGroup.style.display = "flex";
  if (modePdfBtn) modePdfBtn.style.display = "none";
  updateHeaderTitle();
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
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode", "pdf-loaded", "pdf-landscape-fit");
  cameraWrapper?.classList.add("pptx-mode");
  modeCameraBtn?.classList.remove("active");
  modeWhiteSheetBtn?.classList.remove("active");
  modeBlackSheetBtn?.classList.remove("active");
  modePdfBtn?.classList.remove("active");
  modePptxBtn?.classList.add("active");
  if (pdfUploadGroup) pdfUploadGroup.style.display = "none";
  if (pptxUploadGroup) pptxUploadGroup.style.display = "flex";
  if (drawingControlsGroup) drawingControlsGroup.style.display = "none";
  if (cameraControlsGroup) cameraControlsGroup.style.display = "flex";
  if (modePdfBtn) modePdfBtn.style.display = "none";
  updateHeaderTitle();
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

const fadeToggle = document.getElementById("fadeToggle");
if (fadeToggle) {
  fadeToggle.checked = canvasFadeEnabled;
  fadeToggle.addEventListener("change", () => {
    canvasFadeEnabled = fadeToggle.checked;
    if (canvasFadeEnabled) scheduleFadeTick();
  });
}

const penToolBtn = document.getElementById("penToolBtn");
const fillToolBtn = document.getElementById("fillToolBtn");
const eraserToolBtn = document.getElementById("eraserToolBtn");
const figuresToolBtn = document.getElementById("figuresToolBtn");
const selectMoveBtn = document.getElementById("selectMoveBtn");
const imageImportBtn = document.getElementById("imageImportBtn");
const imageImportInput = document.getElementById("imageImportInput");
const textToolBtn = document.getElementById("textToolBtn");
const colorPopover = document.getElementById("colorPopover");
const figuresPopover = document.getElementById("figuresPopover");
const thicknessToolBtn = document.getElementById("thicknessToolBtn");
const opacityToolBtn = document.getElementById("opacityToolBtn");
const thicknessPopover = document.getElementById("thicknessPopover");
const opacityPopover = document.getElementById("opacityPopover");

function redrawAfterImageImport() {
  requestAnimationFrame(() => {
    if (pdfMode && pdfDoc && pdfDrawCanvas?.width) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
    else if (pptxMode && pptxViewer && pptxDrawCanvas?.width) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    else if (drawCanvas?.width) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  });
}

async function commitPlacedImageFromFile(file) {
  if (!file || sharedDocReadOnly) return;
  try {
    const sh = await fileToPlacedImageShape(file);
    let shapeIdx = -1;
    if (pdfMode && pdfDoc) {
      pdfShapes.push(sh);
      shapeIdx = pdfShapes.length - 1;
      pushPdfHistory();
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
      scheduleDocRefitStable();
      selectMarqueeNorm = null;
      selectDragging = false;
      selectDragAnchor = null;
      selectState = { strokeIdx: [], shapeIdx: [shapeIdx] };
      drawShape = "select";
      eraserMode = false;
      setActiveToolOnly("select");
      if (pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
      redrawAfterImageImport();
    } else if (pptxMode && pptxViewer) {
      pptxShapes.push(sh);
      shapeIdx = pptxShapes.length - 1;
      pushPptxHistory();
      if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      scheduleDocRefitStable();
      selectMarqueeNorm = null;
      selectDragging = false;
      selectDragAnchor = null;
      selectState = { strokeIdx: [], shapeIdx: [shapeIdx] };
      drawShape = "select";
      eraserMode = false;
      setActiveToolOnly("select");
      if (pptxDrawCanvas) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      redrawAfterImageImport();
    } else {
      shapes.push(sh);
      shapeIdx = shapes.length - 1;
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      scheduleDocRefitStable();
      selectMarqueeNorm = null;
      selectDragging = false;
      selectDragAnchor = null;
      selectState = { strokeIdx: [], shapeIdx: [shapeIdx] };
      drawShape = "select";
      eraserMode = false;
      setActiveToolOnly("select");
      if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
      redrawAfterImageImport();
    }
  } catch (err) {
    console.error("Image import:", err);
    const msg = (err && err.message) || String(err);
    alert("Не удалось вставить изображение: " + msg);
  }
}

window.addEventListener(PLACED_IMAGE_READY_EVENT, () => {
  scheduleDocRefitStable();
  if (pdfMode && pdfDoc && pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  else if (pptxMode && pptxViewer && pptxDrawCanvas) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
  else if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
});

function setActiveToolOnly(tool) {
  penToolBtn?.classList.remove("active");
  fillToolBtn?.classList.remove("active");
  eraserToolBtn?.classList.remove("active");
  textToolBtn?.classList.remove("active");
  figuresToolBtn?.classList.remove("active");
  selectMoveBtn?.classList.remove("active");
  document.querySelectorAll(".shape-btn").forEach((b) => b.classList.remove("active"));
  if (tool === "pen") penToolBtn?.classList.add("active");
  else if (tool === "fill") fillToolBtn?.classList.add("active");
  else if (tool === "eraser") eraserToolBtn?.classList.add("active");
  else if (tool === "text") textToolBtn?.classList.add("active");
  else if (tool === "figures") figuresToolBtn?.classList.add("active");
  else if (tool === "select") selectMoveBtn?.classList.add("active");
}

function applyRemoteMobileUi(p) {
  if (!p) return;
  if (typeof sharedDocReadOnly !== "undefined" && sharedDocReadOnly) return;

  const t = p.tool;
  const c = p.color;

  if (c && typeof c === "string") {
    drawColor = c;
    if (typeof hexToHsv === "function") {
      const hv = hexToHsv(c);
      colorWheelHue = hv.h;
      colorWheelSat = hv.s;
      colorWheelVal = hv.v;
    }
    document.querySelectorAll(".color-preset").forEach((b) => {
      const bc = (b.dataset.color || "").toLowerCase();
      b.classList.toggle("active", bc === c.toLowerCase());
    });
    if (typeof toolbarColor !== "undefined" && toolbarColor) toolbarColor.value = c;
    if (typeof colorWheelPreview !== "undefined" && colorWheelPreview)
      colorWheelPreview.style.background = c;
    if (pdfMode && pdfDoc) pdfCurrentStroke.color = c;
    else if (pptxMode && pptxViewer) pptxCurrentStroke.color = c;
    else currentStroke.color = c;
    if (typeof updateThicknessOpacityPreviews === "function") updateThicknessOpacityPreviews();
  }

  if (t === "pen") {
    colorPopover?.classList.remove("visible");
    figuresPopover?.classList.remove("visible");
    thicknessPopover?.classList.remove("visible");
    opacityPopover?.classList.remove("visible");
    drawShape = "free";
    eraserMode = false;
    clearSelectionToolState();
    setActiveToolOnly("pen");
  } else if (t === "eraser") {
    if (!eraserMode) {
      eraserMode = true;
      clearSelectionToolState();
      setActiveToolOnly("eraser");
    }
    thicknessPopover?.classList.remove("visible");
    opacityPopover?.classList.remove("visible");
    colorPopover?.classList.remove("visible");
  } else if (t === "select") {
    drawShape = "select";
    eraserMode = false;
    clearSelectionToolState();
    setActiveToolOnly("select");
    figuresPopover?.classList.remove("visible");
    colorPopover?.classList.remove("visible");
    thicknessPopover?.classList.remove("visible");
    opacityPopover?.classList.remove("visible");
  } else if (t === "undo") {
    if (pdfMode && pdfDoc) undoPdf();
    else if (pptxMode && pptxViewer) undoPptx();
    else undoCanvas();
  }

  if (pdfMode && pdfDoc && pdfDrawCanvas?.width)
    drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  else if (pptxMode && pptxViewer && pptxDrawCanvas?.width)
    drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
  else if (drawCanvas?.width) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
}

window.addEventListener("drawflow-remote-ui", (ev) => applyRemoteMobileUi(ev.detail));

penToolBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  colorPopover?.classList.toggle("visible");
  figuresPopover?.classList.remove("visible");
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  drawShape = "free";
  eraserMode = false;
  clearSelectionToolState();
  setActiveToolOnly("pen");
});

fillToolBtn?.addEventListener("click", () => {
  drawShape = "fill";
  eraserMode = false;
  clearSelectionToolState();
  setActiveToolOnly("fill");
  figuresPopover?.classList.remove("visible");
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
});

eraserToolBtn?.addEventListener("click", () => {
  eraserMode = !eraserMode;
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
  if (eraserMode) {
    clearSelectionToolState();
    setActiveToolOnly("eraser");
  } else setActiveToolOnly("pen");
});
thicknessToolBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  thicknessPopover?.classList.toggle("visible");
  opacityPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
  figuresPopover?.classList.remove("visible");
});
opacityToolBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  opacityPopover?.classList.toggle("visible");
  thicknessPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
  figuresPopover?.classList.remove("visible");
});
textToolBtn?.addEventListener("click", () => {
  drawShape = "text";
  eraserMode = false;
  clearSelectionToolState();
  setActiveToolOnly("text");
  figuresPopover?.classList.remove("visible");
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
});
selectMoveBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  drawShape = "select";
  eraserMode = false;
  figuresPopover?.classList.remove("visible");
  colorPopover?.classList.remove("visible");
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  setActiveToolOnly("select");
});
figuresToolBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const wasOpen = figuresPopover?.classList.contains("visible");
  figuresPopover?.classList.toggle("visible");
  colorPopover?.classList.remove("visible");
  thicknessPopover?.classList.remove("visible");
  opacityPopover?.classList.remove("visible");
  if (!wasOpen) clearSelectionToolState();
});
imageImportInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  await commitPlacedImageFromFile(file);
});
document.addEventListener("click", (e) => {
  const inPen = penToolBtn?.contains(e.target) || penToolBtn?.closest(".toolbar-pen-group")?.contains(e.target);
  const inColor = colorPopover?.contains(e.target);
  const inFigs = figuresPopover?.contains(e.target) || figuresToolBtn?.contains(e.target);
  const inSelect = selectMoveBtn?.contains(e.target);
  const inImageImport = imageImportBtn?.contains(e.target);
  const inThickness = thicknessPopover?.contains(e.target) || thicknessToolBtn?.contains(e.target) || thicknessToolBtn?.closest(".toolbar-pen-group")?.contains(e.target);
  const inOpacity = opacityPopover?.contains(e.target) || opacityToolBtn?.contains(e.target) || opacityToolBtn?.closest(".toolbar-pen-group")?.contains(e.target);
  if (!inPen && !inColor && !inFigs && !inSelect && !inImageImport && !inThickness && !inOpacity) {
    colorPopover?.classList.remove("visible");
    figuresPopover?.classList.remove("visible");
    thicknessPopover?.classList.remove("visible");
    opacityPopover?.classList.remove("visible");
  }
});

function updateThicknessOpacityPreviews() {
  if (thicknessToolBtn) thicknessToolBtn.style.color = drawColor;
  const td = document.querySelector(".thickness-tool-dot");
  if (td) {
    const px = 3 + (drawLineWidth / 24) * 11;
    td.style.width = px + "px";
    td.style.height = px + "px";
  }
  const od = document.querySelector(".opacity-tool-dot");
  if (od) {
    od.style.background = drawColor;
    od.style.opacity = String(strokeOpacity);
  }
}

function hsvToHex(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return "#" + [r + m, g + m, b + m].map((n) => Math.round(n * 255).toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const v = max, s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6; else if (max === g) h = ((b - r) / d + 2) / 6; else h = ((r - g) / d + 4) / 6; }
  return { h: h * 360, s, v };
}
const colorWheelCanvas = document.getElementById("colorWheelCanvas");
const colorWheelPreview = document.getElementById("colorWheelPreview");
let colorWheelHue = 120, colorWheelSat = 0.8, colorWheelVal = 1;
(function initColorWheel() {
  if (!colorWheelCanvas) return;
  const ctx = colorWheelCanvas.getContext("2d");
  const R = 68;
  const draw = () => {
    const v = colorWheelVal;
    for (let y = 0; y < 140; y++) for (let x = 0; x < 140; x++) {
      const dx = x - 70, dy = y - 70;
      const r = Math.hypot(dx, dy) / R;
      const a = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
      if (r <= 1) {
        ctx.fillStyle = hsvToHex(a, r, v);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  };
  draw();
  colorWheelCanvas.addEventListener("mousedown", (e) => {
    const rect = colorWheelCanvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left - 70) / R, dy = (e.clientY - rect.top - 70) / R;
    const r = Math.min(1, Math.hypot(dx, dy));
    colorWheelHue = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
    colorWheelSat = r;
    applyColorFromWheel();
    const move = (ev) => {
      const dx2 = (ev.clientX - rect.left - 70) / R, dy2 = (ev.clientY - rect.top - 70) / R;
      const r2 = Math.min(1, Math.hypot(dx2, dy2));
      colorWheelHue = (Math.atan2(dy2, dx2) * 180 / Math.PI + 450) % 360;
      colorWheelSat = r2;
      applyColorFromWheel();
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  function applyColorFromWheel() {
    drawColor = hsvToHex(colorWheelHue, colorWheelSat, colorWheelVal);
    if (toolbarColor) toolbarColor.value = drawColor;
    if (colorWheelPreview) colorWheelPreview.style.background = drawColor;
    if (pdfMode && pdfDoc) pdfCurrentStroke.color = drawColor;
    else if (pptxMode && pptxViewer) pptxCurrentStroke.color = drawColor;
    else currentStroke.color = drawColor;
    document.querySelectorAll(".color-preset").forEach((b) => b.classList.remove("active"));
    updateThicknessOpacityPreviews();
  }
  window.applyColorFromWheel = applyColorFromWheel;
  const hv = hexToHsv(drawColor);
  colorWheelHue = hv.h; colorWheelSat = hv.s; colorWheelVal = hv.v;
  if (colorWheelPreview) colorWheelPreview.style.background = drawColor;
  draw();
})();

document.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    clearSelectionToolState();
    document.querySelectorAll(".shape-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    drawShape = btn.dataset.shape || "line";
    setActiveToolOnly("figures");
    figuresPopover?.classList.remove("visible");
  });
});

const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
undoBtn?.addEventListener("click", () => {
  if (pdfMode && pdfDoc) undoPdf();
  else if (pptxMode && pptxViewer) undoPptx();
  else undoCanvas();
});
redoBtn?.addEventListener("click", () => {
  if (pdfMode && pdfDoc) redoPdf();
  else if (pptxMode && pptxViewer) redoPptx();
  else redoCanvas();
});

function isKeyboardUndoRedoTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  const textInput = document.getElementById("textInputOverlay");
  if (textInput && (el === textInput || textInput.contains(el))) return true;
  return false;
}

document.addEventListener(
  "keydown",
  (e) => {
    if (sharedDocReadOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    if (isKeyboardUndoRedoTarget(e.target)) return;
    const code = e.code || "";
    const undoCombo = code === "KeyZ" && !e.shiftKey;
    const redoCombo = (code === "KeyZ" && e.shiftKey) || (code === "KeyY" && !e.shiftKey);
    if (!undoCombo && !redoCombo) return;
    e.preventDefault();
    if (redoCombo) {
      if (pdfMode && pdfDoc) redoPdf();
      else if (pptxMode && pptxViewer) redoPptx();
      else redoCanvas();
    } else {
      if (pdfMode && pdfDoc) undoPdf();
      else if (pptxMode && pptxViewer) undoPptx();
      else undoCanvas();
    }
  },
  true
);

document.querySelectorAll(".color-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const c = btn.dataset.color || "#6c5ce7";
    drawColor = c;
    const hv = hexToHsv(c);
    colorWheelHue = hv.h;
    colorWheelSat = hv.s;
    colorWheelVal = hv.v;
    if (colorWheelCanvas && colorWheelCanvas.getContext) {
      const ctx = colorWheelCanvas.getContext("2d");
      const R = 68;
      const v = colorWheelVal;
      for (let y = 0; y < 140; y++) for (let x = 0; x < 140; x++) {
        const dx = x - 70, dy = y - 70;
        const r = Math.hypot(dx, dy) / R;
        const a = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
        if (r <= 1) {
          ctx.fillStyle = hsvToHex(a, r, v);
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    if (pdfMode && pdfDoc) pdfCurrentStroke.color = c;
    else if (pptxMode && pptxViewer) pptxCurrentStroke.color = c;
    else currentStroke.color = c;
    document.querySelectorAll(".color-preset").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (toolbarColor) toolbarColor.value = c;
    if (colorWheelPreview) colorWheelPreview.style.background = c;
    updateThicknessOpacityPreviews();
  });
});

function applyCanvasBackground() {
  if (whiteSheetBg) whiteSheetBg.style.background = canvasBackgroundColor;
}

const toolbarOpacity = document.getElementById("toolbarOpacity");
const toolbarThickness = document.getElementById("toolbarThickness");
toolbarOpacity?.addEventListener("input", () => {
  strokeOpacity = parseFloat(toolbarOpacity.value) || 1;
  updateThicknessOpacityPreviews();
});
toolbarThickness?.addEventListener("input", () => {
  drawLineWidth = parseInt(toolbarThickness.value, 10) || 4;
  updateThicknessOpacityPreviews();
});

if (toolbarColor) toolbarColor.value = drawColor;
if (toolbarThickness) toolbarThickness.value = drawLineWidth;
if (toolbarOpacity) toolbarOpacity.value = String(strokeOpacity);
updateThicknessOpacityPreviews();
document.querySelectorAll(".color-preset").forEach((b) => {
  b.classList.toggle("active", (b.dataset.color || "").toLowerCase() === drawColor.toLowerCase());
});
document.querySelectorAll(".shape-btn").forEach((b) => {
  b.classList.toggle("active", (b.dataset.shape || "") === drawShape);
});
fillToolBtn?.classList.toggle("active", drawShape === "fill");
textToolBtn?.classList.toggle("active", drawShape === "text");
selectMoveBtn?.classList.toggle("active", drawShape === "select");

const textInputOverlay = document.getElementById("textInputOverlay");
textInputOverlay?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitTextInput();
  } else if (e.key === "Escape") {
    textInputOverlay.style.display = "none";
    textInputOverlay.value = "";
  }
});
textInputOverlay?.addEventListener("blur", () => {
  if (textInputOverlay.value.trim()) commitTextInput();
  else textInputOverlay.style.display = "none";
});
function commitTextInput() {
  if (sharedDocReadOnly) {
    textInputOverlay.style.display = "none";
    textInputOverlay.value = "";
    return;
  }
  const txt = textInputOverlay?.value?.trim();
  const x = parseFloat(textInputOverlay?.dataset.pendingX || "0");
  const y = parseFloat(textInputOverlay?.dataset.pendingY || "0");
  textInputOverlay.style.display = "none";
  textInputOverlay.value = "";
  if (!txt) return;
  const addText = (shapesArr, pushHistory, save) => {
    shapesArr.push({ type: "text", x, y, text: txt, color: drawColor, fontSize: 24 });
    pushHistory?.();
    if (save && currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
  };
  if (pdfMode && pdfDoc) {
    addText(pdfShapes, () => pushPdfHistory(), false);
    if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
    drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  } else if (pptxMode && pptxViewer) {
    addText(pptxShapes, () => pushPptxHistory(), false);
    drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
  } else {
    addText(shapes, () => pushCanvasHistory(), true);
    drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  }
}

drawBtn?.addEventListener("click", () => {
  drawMode = !drawMode;
  drawBtn?.classList.toggle("active", drawMode);
  if (!drawMode) {
    if (pdfMode && pdfDoc && pdfCurrentStroke.points.length > 0) {
      const stroke = { points: [...pdfCurrentStroke.points], color: pdfCurrentStroke.color || drawColor, lineWidth: pdfCurrentStroke.lineWidth ?? drawLineWidth, opacity: pdfCurrentStroke.opacity ?? strokeOpacity };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      pdfStrokes.push(stroke);
      pushPdfHistory();
      if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
      pdfCurrentStroke = { points: [], color: drawColor };
      drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
    } else if (pptxMode && pptxViewer && pptxCurrentStroke.points.length > 0) {
      const stroke = { points: [...pptxCurrentStroke.points], color: pptxCurrentStroke.color || drawColor, lineWidth: pptxCurrentStroke.lineWidth ?? drawLineWidth, opacity: pptxCurrentStroke.opacity ?? strokeOpacity };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      pptxStrokes.push(stroke);
      pushPptxHistory();
      if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
      pptxCurrentStroke = { points: [], color: drawColor };
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
    } else if (currentStroke.points.length > 0) {
      const stroke = { points: [...currentStroke.points], color: currentStroke.color || drawColor, lineWidth: currentStroke.lineWidth ?? drawLineWidth, opacity: currentStroke.opacity ?? strokeOpacity };
      if (canvasFadeEnabled) {
        stroke._ts = Date.now();
        scheduleFadeTick();
      }
      strokes.push(stroke);
      pushCanvasHistory();
      if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
      currentStroke = { points: [], color: drawColor };
    }
  }
});

const clearPageBtn = document.getElementById("clearPageBtn");
const clearPageModal = document.getElementById("clearPageModal");
const clearPageCancel = document.getElementById("clearPageCancel");
const clearPageConfirm = document.getElementById("clearPageConfirm");
clearPageBtn?.addEventListener("click", () => {
  if (clearPageModal) clearPageModal.style.display = "flex";
});
clearPageCancel?.addEventListener("click", () => {
  if (clearPageModal) clearPageModal.style.display = "none";
});
clearPageConfirm?.addEventListener("click", () => {
  if (clearPageModal) clearPageModal.style.display = "none";
  if (pdfMode && pdfDrawCanvas) {
    if (currentPdfShareToken) {
      deleteStrokesForPage(currentPdfShareToken, pdfPageNum);
    }
    pdfStrokes = [];
    pdfShapes = [];
    pdfFillShapes = [];
    pdfStrokesByPage[pdfPageNum] = { strokes: [], shapes: [], fillShapes: [] };
    pdfCurrentStroke = { points: [], color: drawColor };
    const dctx = pdfDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
    if (currentPdfShareToken) savePdfStrokesAndBroadcast(pdfPageNum, pdfStrokes);
  } else if (pptxMode && pptxDrawCanvas) {
    pptxStrokes = [];
    pptxShapes = [];
    pptxFillShapes = [];
    pptxStrokesByPage[pptxPageNum] = { strokes: [], shapes: [], fillShapes: [] };
    pptxCurrentStroke = { points: [], color: drawColor };
    if (currentPptxShareToken) deleteStrokesForPage(currentPptxShareToken, pptxPageNum);
    const dctx = pptxDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  } else {
    strokes = [];
    shapes = [];
    fillShapes = [];
    currentStroke = { points: [], color: drawColor };
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), strokes, shapes, fillShapes);
    if (isCanvasDocument) {
      canvasStrokesByPage[canvasPageNum] = { strokes: [], shapes: [], fillShapes: [] };
    }
  }
  syncCurrentDocumentPageState?.();
  if (pdfMode && pdfDrawCanvas) drawStrokesToPdfCanvas(pdfDrawCanvas.width, pdfDrawCanvas.height);
  else if (pptxMode && pptxDrawCanvas) drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
  else if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
});

clearDrawBtn?.addEventListener("click", () => {
  if (pdfMode && pdfDrawCanvas) {
    if (currentPdfShareToken) {
      deleteStrokesForPage(currentPdfShareToken, pdfPageNum);
    }
    pdfStrokes = [];
    pdfShapes = [];
    pdfFillShapes = [];
    pdfStrokesByPage[pdfPageNum] = { strokes: [], shapes: [], fillShapes: [] };
    pdfCurrentStroke = { points: [], color: drawColor };
    const dctx = pdfDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pdfDrawCanvas.width, pdfDrawCanvas.height);
  } else if (pptxMode && pptxDrawCanvas) {
    pptxStrokes = [];
    pptxShapes = [];
    pptxFillShapes = [];
    pptxStrokesByPage[pptxPageNum] = { strokes: [], shapes: [], fillShapes: [] };
    pptxCurrentStroke = { points: [], color: drawColor };
    if (currentPptxShareToken) deleteStrokesForPage(currentPptxShareToken, pptxPageNum);
    const dctx = pptxDrawCanvas.getContext("2d");
    dctx.clearRect(0, 0, pptxDrawCanvas.width, pptxDrawCanvas.height);
  } else {
    strokes = [];
    shapes = [];
    fillShapes = [];
    currentStroke = { points: [], color: drawColor };
    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    if (currentCanvasShareToken && supabase) savePageStrokes(currentCanvasShareToken, getCurrentCanvasPageNum(), [], [], []);
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

gestureControlBtn?.addEventListener("click", () => {
  gestureControlEnabled = !gestureControlEnabled;
  gestureControlBtn.classList.toggle("active", gestureControlEnabled);
  gestureControlBtn.textContent = gestureControlEnabled ? "✋ Выкл. жесты" : "✋ Управление жестами";
  drawToolbar?.classList.toggle("gestures-active", gestureControlEnabled);
  const handPref = document.getElementById("handPreferenceGroup");
  if (handPref) handPref.style.display = gestureControlEnabled ? "flex" : "none";
  if (gestureControlEnabled) {
    eraserMode = false;
    if (drawShape === "text") drawShape = "free";
    if (drawShape === "fill") setActiveToolOnly("fill");
    else if (drawShape === "select") setActiveToolOnly("select");
    else if (["circle", "rect", "line", "ellipse", "triangle", "triangle_right", "arrow"].includes(drawShape)) setActiveToolOnly("figures");
    else setActiveToolOnly("pen");
    const ot = document.getElementById("cameraOverlayText");
    const oh = document.getElementById("cameraOverlayHint");
    if (ot) ot.textContent = "Запуск камеры...";
    if (oh) oh.textContent = "При запросе разрешения нажмите «Разрешить»";
    cameraOverlay?.classList.remove("hidden");
    startCamera();
  } else {
    stopCamera();
    if ((whiteSheetMode && !pdfMode && !pptxMode) || pdfMode || pptxMode) cameraOverlay?.classList.add("hidden");
  }
});

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
  if (pptxMode && pptxViewer) {
    if (pptxPageNum <= 1) return;
    savePptxPageState();
    if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
    pptxPageNum--;
    loadPptxPageState();
    if (pdfPageInfo) pdfPageInfo.textContent = `${pptxPageNum} / ${pptxTotalPages}`;
    pdfPrevBtn.disabled = pptxPageNum <= 1;
    pdfNextBtn.disabled = false;
    await renderPptxSlide();
    return;
  }
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
  if (pptxMode && pptxViewer) {
    if (pptxPageNum >= pptxTotalPages) return;
    savePptxPageState();
    if (currentPptxShareToken) savePptxStrokesAndBroadcast(pptxPageNum, pptxStrokes);
    pptxPageNum++;
    loadPptxPageState();
    if (pdfPageInfo) pdfPageInfo.textContent = `${pptxPageNum} / ${pptxTotalPages}`;
    pdfNextBtn.disabled = pptxPageNum >= pptxTotalPages;
    pdfPrevBtn.disabled = false;
    await renderPptxSlide();
    return;
  }
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

canvasPrevBtn?.addEventListener("click", () => {
  if (!isCanvasDocument || canvasPageNum <= 1) return;
  switchToCanvasPage(canvasPageNum - 1);
});
canvasNextBtn?.addEventListener("click", () => {
  if (!isCanvasDocument || canvasPageNum >= canvasTotalPages) return;
  switchToCanvasPage(canvasPageNum + 1);
});
canvasAddPageBtn?.addEventListener("click", async () => {
  if (!isCanvasDocument || !currentCanvasShareToken) return;
  await saveCurrentCanvasPageToStorage();
  clearSelectionToolState();
  canvasTotalPages++;
  const newPage = canvasTotalPages;
  canvasStrokesByPage[newPage] = { strokes: [], shapes: [], fillShapes: [] };
  canvasPageNum = newPage;
  strokes = [];
  shapes = [];
  fillShapes = [];
  currentStroke = { points: [], color: drawColor };
  historyStack = [];
  historyIndex = -1;
  pushCanvasHistory();
  if (drawCanvas) drawStrokesToCanvas(drawCanvas.width, drawCanvas.height);
  if (canvasPageInfo) canvasPageInfo.textContent = `${canvasPageNum} / ${canvasTotalPages}`;
  if (canvasPrevBtn) canvasPrevBtn.disabled = false;
  if (canvasNextBtn) canvasNextBtn.disabled = true;
});

canvasSharedToggleBtn?.addEventListener("click", async () => {
  if (currentCanvasShareToken) deleteSharedCanvas();
  else await createSharedCanvas();
});
canvasLinkBtn?.addEventListener("click", () => createOrCopyCanvasLink());

pdfLinkBtn?.addEventListener("click", async () => {
  const link = pdfLinkBtn?.dataset?.link;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    const orig = pdfLinkBtn?.textContent;
    if (pdfLinkBtn) pdfLinkBtn.textContent = "Скопировано!";
    setTimeout(() => { if (pdfLinkBtn) pdfLinkBtn.textContent = orig; }, 1500);
  } catch (e) { console.warn(e); }
  await showShareLinkWithQr(link);
});

document.getElementById("exportDocBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("exportDocBtn");
  if (!btn || (!pdfMode && !pptxMode)) return;
  btn.disabled = true;
  btn.textContent = "...";
  try {
    if (pdfMode && pdfDoc) {
      const { PDFDocument } = await import("https://esm.sh/pdf-lib@1.17.1");
      const outPdf = await PDFDocument.create();
      const PX_TO_PT = 72 / 96;
      const EXPORT_BASE = 1200;
      for (let p = 1; p <= pdfTotalPages; p++) {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const scale = EXPORT_BASE / Math.max(vp.width, vp.height);
        const w = Math.floor(vp.width * scale);
        const h = Math.floor(vp.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }) }).promise;
        const layer = pdfStrokesByPage[p] || { strokes: [], shapes: [], fillShapes: [] };
        layer.fillShapes?.forEach((f) => {
          const t = document.createElement("canvas");
          t.width = f.w; t.height = f.h;
          t.getContext("2d").putImageData(f.data, 0, 0);
          ctx.drawImage(t, 0, 0, f.w, f.h, 0, 0, w, h);
        });
        (layer.shapes || []).forEach((sh) => {
          if (sh.type !== "image") drawShapeToCtx(ctx, sh, w, h, (x) => x * w);
        });
        [...(layer.strokes || []), (p === pdfPageNum && pdfCurrentStroke.points?.length > 1) ? pdfCurrentStroke : null].filter(Boolean).forEach((s) => drawStrokeWithTool(ctx, s, (x) => x * w, h));
        (layer.shapes || []).forEach((sh) => {
          if (sh.type === "image") drawPlacedImageShape(ctx, sh, w, h, (x) => x * w);
        });
        const wPt = w * PX_TO_PT;
        const hPt = h * PX_TO_PT;
        const pngBytes = await new Promise((resolve, reject) => {
          c.toBlob((blob) => {
            if (!blob) reject(new Error("PNG"));
            else blob.arrayBuffer().then(resolve);
          }, "image/png");
        });
        const png = await outPdf.embedPng(pngBytes);
        const pdfPage = outPdf.addPage([wPt, hPt]);
        pdfPage.drawImage(png, { x: 0, y: 0, width: wPt, height: hPt });
      }
      const pdfOut = await outPdf.save();
      const blob = new Blob([pdfOut], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "document-with-drawings.pdf";
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (pptxMode && pptxViewer) {
      const mod = await import("https://esm.sh/pptxgenjs?bundle");
      const PptxGenJS = mod.default;
      const pptx = new PptxGenJS();
      pptx.layout = "LAYOUT_16x9";
      const curPage = pptxPageNum;
      const slideW = 10;
      const slideH = 5.625;
      for (let p = 1; p <= pptxTotalPages; p++) {
        savePptxPageState();
        pptxPageNum = p;
        loadPptxPageState();
        await pptxViewer.goToSlide(p - 1);
        await pptxViewer.render();
        const c = document.createElement("canvas");
        c.width = pptxCanvas.width;
        c.height = pptxCanvas.height;
        c.getContext("2d").drawImage(pptxCanvas, 0, 0);
        const ctx = c.getContext("2d");
        const layer = pptxStrokesByPage[p] || { strokes: [], shapes: [] };
        (layer.shapes || []).forEach((sh) => {
          if (sh.type !== "image") drawShapeToCtx(ctx, sh, c.width, c.height, (x) => x * c.width);
        });
        [...(layer.strokes || []), (p === curPage && pptxCurrentStroke.points?.length > 1) ? pptxCurrentStroke : null].filter(Boolean).forEach((s) => drawStrokeWithTool(ctx, s, (x) => x * c.width, c.height));
        (layer.shapes || []).forEach((sh) => {
          if (sh.type === "image") drawPlacedImageShape(ctx, sh, c.width, c.height, (x) => x * c.width);
        });
        const slide = pptx.addSlide();
        slide.addImage({ data: c.toDataURL("image/png"), x: 0, y: 0, w: slideW, h: slideH });
      }
      pptxPageNum = curPage;
      loadPptxPageState();
      await pptxViewer.goToSlide(curPage - 1);
      await pptxViewer.render();
      drawStrokesToPptxCanvas(pptxDrawCanvas.width, pptxDrawCanvas.height);
      await pptx.writeFile({ fileName: "presentation-with-drawings.pptx" });
    }
  } catch (e) {
    console.error("Export error:", e);
    alert("Ошибка экспорта: " + (e?.message || "Неизвестная ошибка"));
  }
  if (btn) { btn.disabled = false; btn.textContent = "\u2193 Экспорт"; }
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
  await showShareLinkWithQr(link);
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
    } else if (cameraWrapper && output && drawCanvas) {
      const r = cameraWrapper.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const cw = Math.round(r.width);
        const ch = Math.round(r.height);
        if (output.width !== cw || output.height !== ch || drawCanvas.width !== cw || drawCanvas.height !== ch) {
          output.width = cw;
          output.height = ch;
          drawCanvas.width = cw;
          drawCanvas.height = ch;
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const ctx = output.getContext("2d");
            if (MIRROR_CAMERA) {
              ctx.save();
              ctx.scale(-1, 1);
              ctx.drawImage(video, -cw, 0, cw, ch);
              ctx.restore();
            } else {
              ctx.drawImage(video, 0, 0, cw, ch);
            }
          }
          drawStrokesToCanvas(cw, ch);
        }
      }
    }
  });
}

function scheduleDocRefitStable() {
  scheduleDocRefit();
  setTimeout(() => scheduleDocRefit(), 150);
  setTimeout(() => scheduleDocRefit(), 400);
}

window.addEventListener("resize", scheduleDocRefit);
if (window.ResizeObserver && cameraWrapper) {
  const observer = new ResizeObserver(() => scheduleDocRefit());
  observer.observe(cameraWrapper);
}

setupPdfDrawing();
setupPptxDrawing();
setupCanvasDrawing();

pushCanvasHistory();

const urlParams = new URLSearchParams(window.location.search);
const shareId = urlParams.get("id");
const canvasId = urlParams.get("canvas");
const isCameraMode = urlParams.get("mode") === "camera";
/** Страница справки: embed + hands=both — показывать обе руки, не фильтровать по preferredHand */
const embedTrackBothHands = urlParams.get("embed") === "1" && urlParams.get("hands") === "both";

if (shareId) {
  pdfMode = true;
  whiteSheetMode = false;
  blackSheetMode = false;
  pptxMode = false;
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pptx-mode", "pptx-loaded");
  cameraWrapper?.classList.add("pdf-mode");
  if (pdfOverlay) pdfOverlay.style.display = "none";
  const overlayText = document.getElementById("cameraOverlayText");
  const overlayHint = document.getElementById("cameraOverlayHint");
  if (overlayText) overlayText.textContent = "Загрузка документа...";
  if (overlayHint) overlayHint.textContent = "";
  (async () => {
    let loader = loadPdfFromShareToken;
    try {
      const { data } = await supabase.rpc("get_pdf_by_share_token", { token: shareId, pwd: null });
      const row = data?.[0];
      if (row && !row.needs_password) {
        const fn = (row.storage_path || row.file_name || "").toLowerCase();
        if (fn.endsWith(".pptx")) loader = loadPptxFromShareToken;
      }
    } catch (_) {}
    const result = await loader(shareId);
    if (result && typeof result === "object" && result.needsPassword) {
      document.documentElement.classList.remove("pdf-loading");
      cameraOverlay?.classList.add("hidden");
      if (drawingControlsGroup) drawingControlsGroup.style.display = "none";
      const overlay = document.getElementById("pdfPasswordOverlay");
      const input = document.getElementById("pdfPasswordInput");
      const errEl = document.getElementById("pdfPasswordError");
      const submitBtn = document.getElementById("pdfPasswordSubmit");
      if (overlay && input) {
        overlay.style.display = "flex";
        input.value = "";
        if (errEl) errEl.style.display = "none";
        const tryOpen = async () => {
          if (submitBtn) submitBtn.disabled = true;
          const pwd = input?.value?.trim() || null;
          const { data: authData } = await supabase.rpc("get_pdf_by_share_token", { token: shareId, pwd });
          const authRow = authData?.[0];
          const isPptx = authRow && !authRow.needs_password && ((authRow.storage_path || authRow.file_name || "").toLowerCase().endsWith(".pptx"));
          const loadFn = isPptx ? loadPptxFromShareToken : loadPdfFromShareToken;
          const res = await loadFn(shareId, pwd);
          if (submitBtn) submitBtn.disabled = false;
          if (res && typeof res === "object" && res.needsPassword) {
            if (errEl) { errEl.style.display = "block"; errEl.textContent = "Неверный пароль"; }
            return;
          }
          if (res === true) {
            overlay.style.display = "none";
            if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
            if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
            if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
            if (canvasLinkBtn) canvasLinkBtn.style.display = "none";
            if (pdfLinkBtn) pdfLinkBtn.style.display = "inline-flex";
            drawMode = true;
          }
        };
        submitBtn?.addEventListener("click", tryOpen);
        input?.addEventListener("keydown", (e) => { if (e.key === "Enter") tryOpen(); });
      }
      return;
    }
    if (result === true) {
      if (drawingControlsGroup) drawingControlsGroup.style.display = "flex";
      if (cameraControlsGroup) cameraControlsGroup.style.display = "none";
      if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
      if (canvasLinkBtn) canvasLinkBtn.style.display = "none";
      if (pdfLinkBtn) pdfLinkBtn.style.display = "inline-flex";
      requestAnimationFrame(() => document.documentElement.classList.remove("pdf-loading"));
      drawMode = true;
      return;
    }
    document.documentElement.classList.remove("pdf-loading");
  })();
} else if (canvasId) {
  pdfMode = false;
  pptxMode = false;
  whiteSheetMode = false;
  blackSheetMode = false;
  cameraWrapper?.classList.remove("white-sheet-mode", "black-sheet-mode", "pdf-mode", "pptx-mode", "pptx-loaded");
  if (pdfOverlay) pdfOverlay.style.display = "none";
  const overlayText = document.getElementById("cameraOverlayText");
  const overlayHint = document.getElementById("cameraOverlayHint");
  if (overlayText) overlayText.textContent = "Загрузка документа...";
  if (overlayHint) overlayHint.textContent = "";
  cameraOverlay?.classList.remove("hidden");
  (async () => {
    const check = await getCanvasByShareToken(canvasId);
    if (check.needsPassword) {
      cameraOverlay?.classList.add("hidden");
      if (drawingControlsGroup) drawingControlsGroup.style.display = "none";
      const overlay = document.getElementById("pdfPasswordOverlay");
      const input = document.getElementById("pdfPasswordInput");
      const errEl = document.getElementById("pdfPasswordError");
      const submitBtn = document.getElementById("pdfPasswordSubmit");
      const titleEl = document.getElementById("passwordOverlayTitle");
      const descEl = document.getElementById("passwordOverlayDesc");
      if (titleEl) titleEl.textContent = "🔒 Пароль для доступа";
      if (descEl) descEl.textContent = "Этот документ защищён паролем. Введите пароль, чтобы открыть.";
      if (overlay && input) {
        overlay.style.display = "flex";
        input.value = "";
        if (errEl) errEl.style.display = "none";
        const tryOpen = async () => {
          if (submitBtn) submitBtn.disabled = true;
          const pwd = input?.value?.trim() || null;
          const res = await getCanvasByShareToken(canvasId, pwd);
          if (submitBtn) submitBtn.disabled = false;
          if (res.needsPassword) {
            if (errEl) { errEl.style.display = "block"; errEl.textContent = "Неверный пароль"; }
            return;
          }
          if (res.shareToken) {
            overlay.style.display = "none";
            const ok = await loadCanvasDocumentWithPages(res.shareToken);
            if (ok) {
              applyCanvasBackground();
              drawingControlsGroup.style.display = "flex";
              cameraControlsGroup.style.display = "none";
              if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
              if (pdfLinkBtn) pdfLinkBtn.style.display = "none";
              document.getElementById("exportDocBtn")?.style.setProperty("display", "none");
              updateCanvasSharedUI();
              cameraOverlay?.classList.add("hidden");
              drawMode = true;
              scheduleDocRefit();
            } else alert("Не удалось загрузить документ");
          }
        };
        submitBtn?.addEventListener("click", tryOpen);
        input?.addEventListener("keydown", (e) => { if (e.key === "Enter") tryOpen(); });
      }
      return;
    }
    if (check.shareToken) {
      const ok = await loadCanvasDocumentWithPages(check.shareToken);
      if (ok) {
        applyCanvasBackground();
        drawingControlsGroup.style.display = "flex";
        cameraControlsGroup.style.display = "none";
        if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
        if (pdfLinkBtn) pdfLinkBtn.style.display = "none";
        updateCanvasSharedUI();
        cameraOverlay?.classList.add("hidden");
        drawMode = true;
        scheduleDocRefit();
      } else alert("Не удалось загрузить документ");
      return;
    }
    const ok = await loadCanvasFromShareToken(canvasId);
    if (ok) {
      applyCanvasBackground();
      drawingControlsGroup.style.display = "flex";
      cameraControlsGroup.style.display = "none";
      if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
      if (pdfLinkBtn) pdfLinkBtn.style.display = "none";
      updateCanvasSharedUI();
      cameraOverlay?.classList.add("hidden");
      drawMode = true;
      scheduleDocRefit();
    } else alert("Не удалось загрузить общий холст");
  })();
} else if (isCameraMode) {
  const isEmbed = urlParams.get("embed") === "1";
  pdfOverlay?.classList.add("hidden");
  whiteSheetMode = true;
  blackSheetMode = false;
  canvasFadeEnabled = false;
  cameraWrapper?.classList.remove("black-sheet-mode", "pdf-mode", "pptx-mode", "pptx-loaded");
  if (isEmbed) {
    document.documentElement.classList.add("embed-camera-root");
    cameraWrapper?.classList.add("white-sheet-mode", "camera-feed-mode");
    document.querySelector(".app")?.classList.add("embed-camera");
    drawMode = false;
    showSkeleton = true;
    startCamera();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopCamera();
      else startCamera();
    });
    window.addEventListener("message", (e) => {
      if (e.data?.type === "camera-section-collapsed") stopCamera();
    });
  } else {
    cameraWrapper?.classList.add("white-sheet-mode");
  }
  applyCanvasBackground();
  drawingControlsGroup.style.display = isEmbed ? "none" : "flex";
  cameraControlsGroup.style.display = "none";
  if (canvasSharedToggleBtn) canvasSharedToggleBtn.style.display = "none";
  if (pdfLinkBtn) pdfLinkBtn.style.display = "none";
  cameraOverlay?.classList.add("hidden");
  if (!isEmbed) drawMode = true;
  updateDocumentOverlays();
  if (!isEmbed) updateCanvasSharedUI();
  updateHeaderTitle();
  scheduleDocRefit();
}

if (urlParams.get("embed") === "1") {
  const dashLink = document.querySelector('a[href="/dashboard.html"]');
  if (dashLink) dashLink.target = "_top";
}

(function scheduleMediaPipePrefetch() {
  const run = () => ensureMediaPipeModelsLoaded().catch(() => {});
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(run, { timeout: 12000 });
  } else {
    setTimeout(run, 2000);
  }
})();
