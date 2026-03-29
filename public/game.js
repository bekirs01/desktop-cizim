/**
 * Режим «повтори фигуру»: серый контур + оценка близости к нему.
 */
import { getShapePolyline, scoreTraceToTemplate, SHAPE_IDS } from "./app/game/traceScore.js";
import { mountGameGestures } from "./app/game/gameGestures.js";

const canvas = document.getElementById("gameCanvas");
const shapeSelect = document.getElementById("gameShapeSelect");
const shapePickerEl = document.getElementById("gameShapePicker");
const checkBtn = document.getElementById("gameCheckBtn");
const clearBtn = document.getElementById("gameClearBtn");
const randomBtn = document.getElementById("gameRandomBtn");
const resultEl = document.getElementById("gameResult");
const hintEl = document.getElementById("gameHint");
const gestureToggle = document.getElementById("gameGestureToggle");
const gestureStatusEl = document.getElementById("gameGestureStatus");
const gameCanvasOuter = document.getElementById("gameCanvasOuter");

/** Размер кадра камеры (после включения жестов); 0 — до включения, берём запасной 16:9. */
let cameraVideoW = 0;
let cameraVideoH = 0;

function getCameraAspectRatio() {
  if (cameraVideoW > 0 && cameraVideoH > 0) return cameraVideoW / cameraVideoH;
  return 16 / 9;
}

/** Полная ширина контейнера; высота из пропорций камеры (как до боковой колонки). */
function layoutGameCanvas() {
  const outer = gameCanvasOuter;
  const wrap = canvas?.parentElement;
  if (!outer || !wrap) return;
  const aw = outer.getBoundingClientRect().width;
  const ar = getCameraAspectRatio();
  if (aw < 8) return;
  const hBox = Math.max(8, Math.floor(aw / ar));
  wrap.style.boxSizing = "border-box";
  wrap.style.width = "100%";
  wrap.style.height = `${hBox}px`;
}

function syncGestureToggleAria() {
  gestureToggle?.setAttribute("aria-checked", gestureToggle.checked ? "true" : "false");
}

/** Как drawCursorDot в script.js: точка на холсте, не отдельный HTML-круг */
let gameDrawCursorNorm = null;

function updateGameGestureCursor(visible, nx, ny) {
  if (visible && nx != null && ny != null) {
    gameDrawCursorNorm = { x: nx, y: ny };
  } else {
    gameDrawCursorNorm = null;
  }
  redraw();
}

const REF_COLOR = "rgba(100, 100, 120, 0.45)";
const REF_LINE = 5;
const USER_COLOR = "#6c5ce7";
const USER_LINE = 5;
const MIN_STROKE_DIST = 0.002;

let refPolyline = [];
let userStrokes = [];
let currentStroke = null;
let drawing = false;
let w = 480;
let h = 480;
let gestureUnmount = null;
let gestureStartSeq = 0;

function normToCanvas(p) {
  return { x: p.x * w, y: p.y * h };
}

/** Подсказка задана в квадрате 0–1; рисуем во вписанном квадрате — круг не превращается в овал. */
function normToCanvasHint(p) {
  const side = Math.min(w, h);
  const ox = (w - side) * 0.5;
  const oy = (h - side) * 0.5;
  return { x: ox + p.x * side, y: oy + p.y * side };
}

function canvasToNorm(x, y) {
  return { x: x / w, y: y / h };
}

function clientToNorm(clientX, clientY) {
  const r = canvas?.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return { x: 0.5, y: 0.5 };
  const nx = (clientX - r.left) / r.width;
  const ny = (clientY - r.top) / r.height;
  return {
    x: Math.max(0, Math.min(1, nx)),
    y: Math.max(0, Math.min(1, ny)),
  };
}

function resizeCanvas() {
  layoutGameCanvas();
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const cw = Math.max(8, Math.floor(rect.width));
  const ch = Math.max(8, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = Math.max(1, Math.floor(cw * dpr));
  h = Math.max(1, Math.floor(ch * dpr));
  canvas.width = w;
  canvas.height = h;
  redraw();
}

function syncShapePickerUI() {
  const id = shapeSelect?.value;
  shapePickerEl?.querySelectorAll(".game-shape-opt").forEach((btn) => {
    const on = btn.dataset.shape === id;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("game-shape-opt--active", on);
  });
}

function loadShape(id) {
  refPolyline = getShapePolyline(id);
  userStrokes = [];
  currentStroke = null;
  resultEl.textContent = "";
  resultEl.classList.remove("game-result--visible");
  syncShapePickerUI();
  redraw();
}

function redraw() {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f6f7fb";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = REF_COLOR;
  ctx.lineWidth = REF_LINE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (refPolyline.length > 1) {
    const closed = shapeSelect?.value !== "line" && shapeSelect?.value !== "diagonal";
    ctx.beginPath();
    const p0 = normToCanvasHint(refPolyline[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < refPolyline.length; i++) {
      const p = normToCanvasHint(refPolyline[i]);
      ctx.lineTo(p.x, p.y);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth = USER_LINE;
  for (const st of userStrokes) {
    const pts = st.points;
    if (!pts?.length) continue;
    ctx.beginPath();
    const q0 = normToCanvas(pts[0]);
    ctx.moveTo(q0.x, q0.y);
    for (let i = 1; i < pts.length; i++) {
      const q = normToCanvas(pts[i]);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  }
  if (currentStroke?.points?.length) {
    const pts = currentStroke.points;
    ctx.beginPath();
    const q0 = normToCanvas(pts[0]);
    ctx.moveTo(q0.x, q0.y);
    for (let i = 1; i < pts.length; i++) {
      const q = normToCanvas(pts[i]);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  }

  if (gameDrawCursorNorm) {
    const cx = gameDrawCursorNorm.x * w;
    const cy = gameDrawCursorNorm.y * h;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.shadowColor = USER_COLOR;
    ctx.shadowBlur = 6;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = USER_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function pointerDownNorm(nx, ny) {
  if (drawing) return;
  drawing = true;
  currentStroke = { points: [{ x: nx, y: ny }] };
  redraw();
}

function pointerMoveNorm(nx, ny) {
  if (!drawing || !currentStroke) return;
  const p = { x: nx, y: ny };
  const last = currentStroke.points[currentStroke.points.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_STROKE_DIST) {
    currentStroke.points.push(p);
    redraw();
  }
}

function pointerUpNorm() {
  if (!drawing) return;
  drawing = false;
  if (currentStroke?.points?.length > 1) userStrokes.push(currentStroke);
  currentStroke = null;
  redraw();
}

function gesturePinchBegin() {
  drawing = true;
  currentStroke = { points: [] };
}

function gesturePinchSample(nx, ny) {
  if (!drawing || !currentStroke) return;
  const cx = Math.max(0, Math.min(1, nx));
  const cy = Math.max(0, Math.min(1, ny));
  const last = currentStroke.points[currentStroke.points.length - 1];
  const gStep = last ? Math.hypot(cx - last.x, cy - last.y) : 1;
  if (!last || gStep >= MIN_STROKE_DIST) {
    currentStroke.points.push({ x: cx, y: cy });
    redraw();
  }
}

function onDown(e) {
  e.preventDefault();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const { x: nx, y: ny } = clientToNorm(clientX, clientY);
  pointerDownNorm(nx, ny);
}

function onMove(e) {
  if (e.type === "mousemove" && (e.buttons & 1) === 0) return;
  if (!drawing || !currentStroke) return;
  e.preventDefault();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const { x: nx, y: ny } = clientToNorm(clientX, clientY);
  pointerMoveNorm(nx, ny);
}

function onUp(e) {
  if (!drawing) return;
  e.preventDefault();
  pointerUpNorm();
}

function pickRandomShape() {
  const ids = SHAPE_IDS.filter((id) => id !== shapeSelect.value);
  const next = ids[Math.floor(Math.random() * ids.length)] || SHAPE_IDS[0];
  shapeSelect.value = next;
  loadShape(next);
}

async function setGesturesEnabled(on) {
  const seq = ++gestureStartSeq;
  if (on) {
    if (gestureUnmount) return;
    if (gestureStatusEl) gestureStatusEl.textContent = "Камера…";
    try {
      const unmount = await mountGameGestures({
        mirror: true,
        getCanvasBufferSize: () => ({ w, h }),
        canvasNormToClient: (nx, ny) => {
          const r = canvas?.getBoundingClientRect();
          if (!r?.width) return null;
          return {
            clientX: r.left + nx * r.width,
            clientY: r.top + ny * r.height,
          };
        },
        isOverUiOverlay: (cx, cy) => {
          const bar = document.getElementById("gameSidebarOverlay");
          if (!bar) return false;
          const r = bar.getBoundingClientRect();
          return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
        },
        onVideoReady: (vw, vh) => {
          cameraVideoW = vw;
          cameraVideoH = vh;
          resizeCanvas();
        },
        canStartPinchStroke: () => !drawing,
        onPinchStrokeBegin: gesturePinchBegin,
        onPinchStrokeSample: gesturePinchSample,
        onUp: pointerUpNorm,
        onCursor: updateGameGestureCursor,
      });
      if (seq !== gestureStartSeq || !gestureToggle?.checked) {
        unmount?.();
        return;
      }
      gestureUnmount = unmount;
      if (gestureStatusEl) gestureStatusEl.textContent = "Щепотка — рисовать";
    } catch (err) {
      console.error(err);
      if (gestureToggle) gestureToggle.checked = false;
      syncGestureToggleAria();
      if (gestureStatusEl) gestureStatusEl.textContent = "";
      alert("Не удалось включить камеру для жестов.");
    }
  } else {
    if (gestureUnmount) {
      gestureUnmount();
      gestureUnmount = null;
    }
    cameraVideoW = 0;
    cameraVideoH = 0;
    gameDrawCursorNorm = null;
    resizeCanvas();
    if (gestureStatusEl) gestureStatusEl.textContent = "";
  }
}

shapeSelect?.addEventListener("change", () => loadShape(shapeSelect.value));
checkBtn?.addEventListener("click", () => {
  const strokes = userStrokes.slice();
  if (currentStroke?.points?.length > 1) strokes.push(currentStroke);
  const res = scoreTraceToTemplate(shapeSelect.value, strokes, w, h);
  resultEl.innerHTML = `<strong>${res.percent}%</strong> — ${res.label}<br><span class="game-result-detail">${res.detail || ""}</span>`;
  resultEl.classList.add("game-result--visible");
});
clearBtn?.addEventListener("click", () => {
  userStrokes = [];
  currentStroke = null;
  drawing = false;
  resultEl.textContent = "";
  resultEl.classList.remove("game-result--visible");
  redraw();
});
randomBtn?.addEventListener("click", pickRandomShape);

gestureToggle?.addEventListener("change", () => {
  syncGestureToggleAria();
  void setGesturesEnabled(!!gestureToggle.checked);
});

const gameCanvasWrap = canvas?.parentElement;
gameCanvasWrap?.addEventListener("mousedown", onDown);
window.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);
gameCanvasWrap?.addEventListener("touchstart", onDown, { passive: false });
gameCanvasWrap?.addEventListener("touchmove", onMove, { passive: false });
gameCanvasWrap?.addEventListener("touchend", onUp);
gameCanvasWrap?.addEventListener("touchcancel", onUp);

window.addEventListener("resize", () => {
  resizeCanvas();
});

if (typeof ResizeObserver !== "undefined" && gameCanvasOuter) {
  new ResizeObserver(() => resizeCanvas()).observe(gameCanvasOuter);
}

if (SHAPE_IDS.length && shapeSelect) {
  shapeSelect.innerHTML = "";
  shapePickerEl?.replaceChildren();
  const labels = {
    circle: "Круг",
    square: "Квадрат",
    triangle: "Треугольник",
    line: "Горизонтальная линия",
    diagonal: "Диагональ",
  };
  const icons = {
    circle:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>',
    square:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    triangle:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5 19 17H5Z"/></svg>',
    line:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="4" y1="12" x2="20" y2="12"/></svg>',
    diagonal:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="19" x2="19" y2="5"/></svg>',
  };
  for (const id of SHAPE_IDS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = labels[id] || id;
    shapeSelect.appendChild(opt);
    if (shapePickerEl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "game-shape-opt";
      btn.dataset.shape = id;
      btn.title = labels[id] || id;
      btn.setAttribute("aria-label", labels[id] || id);
      btn.innerHTML = icons[id] || icons.circle;
      btn.addEventListener("click", () => {
        shapeSelect.value = id;
        shapeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      shapePickerEl.appendChild(btn);
    }
  }
}

resizeCanvas();
requestAnimationFrame(() => resizeCanvas());
syncGestureToggleAria();
loadShape(shapeSelect?.value || "circle");

if (hintEl) {
  hintEl.textContent =
    "Серый контур показывает, где и какой фигурой рисовать (вписанный квадрат на холсте). Оценка — насколько близко ваш штрих к этому контуру. Жесты: щепотка указательного и большого пальца.";
}

window.addEventListener("beforeunload", () => {
  gestureUnmount?.();
});
