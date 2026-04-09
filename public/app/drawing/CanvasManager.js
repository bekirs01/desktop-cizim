import { cloneStroke, cloneShape } from "./cloneLayer.js";
import { hexToRgba } from "./colorUtils.js";
import { drawPlacedImageShape } from "./placedImageShape.js";

export class CanvasManager {
  constructor() {
    this.strokes = [];
    this.shapes = [];
    this.fillShapes = [];
    this.historyStack = [];
    this.historyIndex = -1;
    this.currentStroke = { points: [], color: "#ffffff", lineWidth: 4 };
  }

  pushHistory() {
    const snapshot = {
      strokes: this.strokes.map(cloneStroke),
      shapes: this.shapes.map(cloneShape),
      fillShapes: this.fillShapes.map((f) => ({ 
        data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), 
        w: f.w, 
        h: f.h 
      }))
    };
    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    this.historyStack.push(snapshot);
    if (this.historyStack.length > 50) {
      this.historyStack.shift();
      this.historyIndex--;
    } else {
      this.historyIndex = this.historyStack.length - 1;
    }
  }

  undo() {
    if (this.historyStack.length === 0 || this.historyIndex < 0) return false;
    this.historyIndex--;
    const s = this.historyStack[this.historyIndex];
    if (s) {
      this.strokes = s.strokes.map(cloneStroke);
      this.shapes = s.shapes.map(cloneShape);
      this.fillShapes = s.fillShapes.map((f) => ({ 
        data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), 
        w: f.w, h: f.h 
      }));
    } else {
      this.strokes = [];
      this.shapes = [];
      this.fillShapes = [];
    }
    return true;
  }

  redo() {
    if (this.historyStack.length === 0 || this.historyIndex >= this.historyStack.length - 1) return false;
    this.historyIndex++;
    const s = this.historyStack[this.historyIndex];
    if (s) {
      this.strokes = s.strokes.map(cloneStroke);
      this.shapes = s.shapes.map(cloneShape);
      this.fillShapes = s.fillShapes.map((f) => ({ 
        data: new ImageData(new Uint8ClampedArray(f.data.data), f.w, f.h), 
        w: f.w, h: f.h 
      }));
    }
    return true;
  }

  clear() {
    this.strokes = [];
    this.shapes = [];
    this.fillShapes = [];
  }

  resetHistory() {
    this.historyStack = [];
    this.historyIndex = -1;
  }

  static drawShapeToCtx(ctx, sh, w, h, sx, drawColor, drawLineWidth) {
    const c = sh.color || drawColor || "#ffffff";
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
}
