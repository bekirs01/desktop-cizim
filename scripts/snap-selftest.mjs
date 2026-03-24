import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(__dirname, "..", "public", "app", "drawing");
const { trySnapFreehandToShape } = await import(pathToFileURL(path.join(base, "sketchHoldSnap.js")).href);

function stroke(pts, color = "#000") {
  return { points: pts, color, lineWidth: 3, opacity: 1 };
}

let ok = 0, bad = 0;
function t(name, cond) {
  if (cond) {
    ok++;
    console.log("OK", name);
  } else {
    bad++;
    console.log("FAIL", name);
  }
}

function circlePts(cx, cy, r, n, noise = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    pts.push({
      x: cx + r * Math.cos(ang) + (Math.random() - 0.5) * noise,
      y: cy + r * Math.sin(ang) + (Math.random() - 0.5) * noise,
    });
  }
  const mid = { x: (pts[0].x + pts[n - 1].x) / 2, y: (pts[0].y + pts[n - 1].y) / 2 };
  pts[0] = { ...mid };
  pts[n - 1] = { ...mid };
  return pts;
}

const c = trySnapFreehandToShape(stroke(circlePts(0.5, 0.48, 0.13, 42, 0.018)), false);
t("snap closed noisy → circle", c?.type === "circle");

const linePts = [];
for (let i = 0; i < 25; i++) linePts.push({ x: 0.2 + i * 0.025, y: 0.42 + (Math.random() - 0.5) * 0.008 });
const ln = trySnapFreehandToShape(stroke(linePts), false);
t("snap open straight → line", ln?.type === "line" && Math.abs(ln.y2 - ln.y1) < 0.04);

const zig = [];
for (let i = 0; i < 20; i++) zig.push({ x: 0.3 + i * 0.02, y: 0.5 + Math.sin(i * 0.7) * 0.06 });
t("snap wiggle → null", trySnapFreehandToShape(stroke(zig), false) === null);

console.log(`\n${ok} ok, ${bad} fail`);
process.exit(bad ? 1 : 0);
