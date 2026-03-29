import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";
import {
  getThumbIndexDistance,
  getPinchCursorPosition,
  getPinchStartThreshold,
  getPinchReleaseThreshold,
  isIndexThumbPinch,
} from "../gestures/handGeometry.js";
import { HAND_MODEL, WASM } from "../config/mediapipeConstants.js";

/** Как в script.js для свободного штриха жестом */
const CURSOR_SMOOTH = 0.45;
const GESTURE_LOCK_FRAMES = 6;
const PINCH_RELEASE_FRAMES = 4;
const DIST_SMOOTH_ALPHA = 0.6;
let visionPromise = null;
let handLandmarkerPromise = null;

async function ensureGameHandLandmarker() {
  if (!handLandmarkerPromise) {
    handLandmarkerPromise = (async () => {
      if (!visionPromise) visionPromise = FilesetResolver.forVisionTasks(WASM);
      const vision = await visionPromise;
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.2,
        minHandPresenceConfidence: 0.2,
        minTrackingConfidence: 0.2,
      });
    })().catch((err) => {
      handLandmarkerPromise = null;
      throw err;
    });
  }
  return handLandmarkerPromise;
}

function pickHand(landmarks) {
  if (!landmarks?.length) return null;
  for (const lm of landmarks) {
    if (getPinchCursorPosition(lm)) return lm;
  }
  return null;
}

/**
 * Видеокадр (nx,ny ∈ [0,1]) → нормализованные координаты буфера холста без анизотропии:
 * круг в плоскости изображения камеры остаётся кругом в пикселях холста (как object-fit: contain).
 */
function mapVideoNormToCanvasBufferNorm(nx, ny, vw, vh, cw, ch) {
  if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return { x: nx, y: ny };
  const scale = Math.min(cw / vw, ch / vh);
  const ox = (cw - vw * scale) * 0.5;
  const oy = (ch - vh * scale) * 0.5;
  const cx = nx * vw * scale + ox;
  const cy = ny * vh * scale + oy;
  return {
    x: Math.max(0, Math.min(1, cx / cw)),
    y: Math.max(0, Math.min(1, cy / ch)),
  };
}

function simulateUiPointerMove(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (el) {
    el.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
      })
    );
  }
}

function simulateUiClick(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return;
  const clickable = el.closest("button, a[href], .game-shape-opt, label.game-switch");
  if (!clickable) return;
  if (clickable.tagName === "A" && clickable.getAttribute("href")) {
    clickable.click();
    return;
  }
  if (clickable.tagName === "LABEL" && clickable.classList.contains("game-switch")) {
    clickable.click();
    return;
  }
  ["mousedown", "mouseup", "click"].forEach((type) => {
    clickable.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: type === "mousedown" ? 1 : 0,
      })
    );
  });
}

/**
 * @param {{
 *   mirror?: boolean,
 *   canStartPinchStroke?: () => boolean,
 *   getCanvasBufferSize?: () => { w: number, h: number },
 *   canvasNormToClient?: (nx: number, ny: number) => { clientX: number, clientY: number } | null | undefined,
 *   isOverUiOverlay?: (clientX: number, clientY: number) => boolean,
 *   onVideoReady?: (videoWidth: number, videoHeight: number) => void,
 *   onPinchStrokeBegin: () => void,
 *   onPinchStrokeSample: (nx: number, ny: number) => void,
 *   onUp: () => void,
 *   onCursor?: (visible: boolean, nx?: number, ny?: number) => void,
 * }} hooks
 */
export async function mountGameGestures(hooks) {
  /** Как script.js: координаты в норм. кадра без зеркала в штрихе; зеркало только если явно hooks.mirror === true */
  const mirror = hooks.mirror === true;
  const canStart = hooks.canStartPinchStroke ?? (() => true);

  const video = document.createElement("video");
  let stream = null;
  let handLandmarker = null;
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.muted = true;
  video.style.cssText = "position:fixed;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none";

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
      audio: false,
    });
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();

    let wait = 0;
    while ((video.videoWidth === 0 || video.videoHeight === 0) && wait < 80) {
      await new Promise((r) => setTimeout(r, 50));
      wait++;
    }
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      hooks.onVideoReady?.(video.videoWidth, video.videoHeight);
    }
    handLandmarker = await ensureGameHandLandmarker();
  } catch (err) {
    stream?.getTracks().forEach((tr) => tr.stop());
    video.remove();
    throw err;
  }

  let lastVideoTime = -1;
  let gestureState = "idle";
  let pinchReleaseFrames = 0;
  let smoothedThumbIndexDist = 0.2;
  let smoothedCursor = null;
  const framesSinceErase = 999;
  let raf = 0;
  let stopped = false;
  let wasToolbarPinch = false;

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  /** Как norm из cursorPos в script.js (свободный штрих): только getPinchCursorPosition + clamp, без преобразований кадра */
  function normFromLandmark(lm) {
    const raw = getPinchCursorPosition(lm);
    if (!raw) return null;
    const rx = clamp01(raw.x);
    const ry = clamp01(raw.y);
    const nx = clamp01(mirror ? 1 - rx : rx);
    return { x: nx, y: ry };
  }

  function loop(t) {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    if (t <= lastVideoTime) return;
    lastVideoTime = t;

    let res;
    try {
      res = handLandmarker.detectForVideo(video, t);
    } catch (_) {
      return;
    }
    const rawLm = pickHand(res?.landmarks);
    if (!rawLm) {
      smoothedCursor = null;
      hooks.onCursor?.(false);
      wasToolbarPinch = false;
      if (gestureState === "drawing") {
        gestureState = "idle";
        pinchReleaseFrames = 0;
        hooks.onUp();
      }
      return;
    }

    const cursorPos = normFromLandmark(rawLm);
    if (!cursorPos) {
      smoothedCursor = null;
      hooks.onCursor?.(false);
      return;
    }

    if (!smoothedCursor) smoothedCursor = { ...cursorPos };
    else {
      smoothedCursor.x = smoothedCursor.x * (1 - CURSOR_SMOOTH) + cursorPos.x * CURSOR_SMOOTH;
      smoothedCursor.y = smoothedCursor.y * (1 - CURSOR_SMOOTH) + cursorPos.y * CURSOR_SMOOTH;
    }

    const buf = hooks.getCanvasBufferSize?.();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let drawX = smoothedCursor.x;
    let drawY = smoothedCursor.y;
    if (buf && vw > 0 && vh > 0) {
      const m = mapVideoNormToCanvasBufferNorm(drawX, drawY, vw, vh, buf.w, buf.h);
      drawX = m.x;
      drawY = m.y;
    }

    hooks.onCursor?.(true, drawX, drawY);

    const pinchStart = getPinchStartThreshold(rawLm);
    const pinchRelease = getPinchReleaseThreshold(rawLm);
    const rawDist = getThumbIndexDistance(rawLm);
    if (gestureState === "idle" && rawDist < pinchStart) {
      smoothedThumbIndexDist = rawDist;
    } else {
      smoothedThumbIndexDist =
        smoothedThumbIndexDist * (1 - DIST_SMOOTH_ALPHA) + rawDist * DIST_SMOOTH_ALPHA;
    }

    const pt = hooks.canvasNormToClient?.(clamp01(drawX), clamp01(drawY));
    const overUi = pt && hooks.isOverUiOverlay?.(pt.clientX, pt.clientY);

    if (overUi) {
      if (gestureState === "drawing") {
        gestureState = "idle";
        pinchReleaseFrames = 0;
        hooks.onUp();
      }
      simulateUiPointerMove(pt.clientX, pt.clientY);
      if (isIndexThumbPinch(rawLm)) {
        if (!wasToolbarPinch) {
          wasToolbarPinch = true;
          simulateUiClick(pt.clientX, pt.clientY);
        }
      } else {
        wasToolbarPinch = false;
      }
      return;
    }
    wasToolbarPinch = false;

    let isPinchActive = false;
    if (gestureState === "drawing") {
      if (smoothedThumbIndexDist > pinchRelease) {
        pinchReleaseFrames++;
        if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) {
          gestureState = "idle";
          pinchReleaseFrames = 0;
          smoothedCursor = null;
          hooks.onUp();
        }
      } else {
        pinchReleaseFrames = 0;
        isPinchActive = true;
      }
    } else {
      pinchReleaseFrames = 0;
      if (smoothedThumbIndexDist < pinchStart && framesSinceErase >= GESTURE_LOCK_FRAMES && canStart()) {
        gestureState = "drawing";
        hooks.onPinchStrokeBegin();
        isPinchActive = true;
      }
    }

    if (gestureState === "drawing" && isPinchActive && framesSinceErase >= GESTURE_LOCK_FRAMES) {
      hooks.onPinchStrokeSample(clamp01(drawX), clamp01(drawY));
    }
  }

  raf = requestAnimationFrame(loop);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    hooks.onCursor?.(false);
    stream.getTracks().forEach((tr) => tr.stop());
    video.remove();
    wasToolbarPinch = false;
    if (gestureState === "drawing") {
      gestureState = "idle";
      hooks.onUp();
    }
  };
}
