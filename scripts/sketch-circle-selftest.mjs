import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, "..", "public", "app", "drawing", "sketchToCircle.js");
const { trySketchToCircleShape } = await import(pathToFileURL(modPath).href);

function circlePts(cx, cy, r, n, noise = 0, close = true) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const nx = (Math.random() - 0.5) * noise;
    const ny = (Math.random() - 0.5) * noise;
    pts.push({ x: cx + r * Math.cos(t) + nx, y: cy + r * Math.sin(t) + ny });
  }
  if (close && pts.length) {
    const a = pts[0],
      b = pts[pts.length - 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pts[pts.length - 1] = mid;
    pts[0] = { x: mid.x, y: mid.y };
  }
  return pts;
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log("OK", name);
  } else {
    failed++;
    console.log("FAIL", name);
  }
}

const stroke = (pts) => ({ points: pts, color: "#000", lineWidth: 3, opacity: 1 });

// Noisy closed circle
let pts = circlePts(0.5, 0.45, 0.14, 48, 0.012, true);
let sh = trySketchToCircleShape(stroke(pts), false);
check("noisy circle -> shape", sh && sh.type === "circle" && Math.abs(sh.cx - 0.5) < 0.04 && Math.abs(sh.r - 0.14) < 0.035);

// Line
pts = [];
for (let i = 0; i < 30; i++) pts.push({ x: 0.2 + i * 0.02, y: 0.5 });
sh = trySketchToCircleShape(stroke(pts), false);
check("line -> null", sh === null);

// Open arc (~240°, endpoints far apart)
pts = [];
for (let i = 0; i < 45; i++) {
  const t = (i / 45) * (Math.PI * 1.35);
  pts.push({ x: 0.5 + 0.12 * Math.cos(t), y: 0.5 + 0.12 * Math.sin(t) });
}
sh = trySketchToCircleShape(stroke(pts), false);
check("open arc -> null", sh === null);

// Ellipse
pts = [];
for (let i = 0; i < 50; i++) {
  const t = (i / 50) * Math.PI * 2;
  pts.push({ x: 0.5 + 0.18 * Math.cos(t), y: 0.5 + 0.09 * Math.sin(t) });
}
pts[pts.length - 1] = { ...pts[0] };
sh = trySketchToCircleShape(stroke(pts), false);
check("flat ellipse -> null", sh === null);

// Small circle (still above min size)
pts = circlePts(0.3, 0.7, 0.045, 36, 0.004, true);
sh = trySketchToCircleShape(stroke(pts), false);
check("small circle", sh && sh.type === "circle" && sh.r > 0.03);

// Hexagon (chords — не окружность)
pts = [];
for (let k = 0; k < 6; k++) {
  const t = (k / 6) * Math.PI * 2;
  pts.push({ x: 0.5 + 0.14 * Math.cos(t), y: 0.5 + 0.14 * Math.sin(t) });
}
pts.push({ ...pts[0] });
sh = trySketchToCircleShape(stroke(pts), false);
check("hexagon chords -> null", sh === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
