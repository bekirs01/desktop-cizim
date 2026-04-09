/**
 * DrawFlow — анимированный фон (aurora + геометрия + частицы).
 * Уважает prefers-reduced-motion и скрытие вкладки.
 */

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function norm3(x, y, z) {
  const L = Math.hypot(x, y, z) || 1;
  return [x / L, y / L, z / L];
}

/** Поворот Rx → Ry → Rz (накапливаемые углы из step). */
function rotate3(x, y, z, rx, ry, rz) {
  let x1 = x;
  let y1 = y;
  let z1 = z;
  let c = Math.cos(rx);
  let s = Math.sin(rx);
  let y2 = y1 * c - z1 * s;
  let z2 = y1 * s + z1 * c;
  y1 = y2;
  z1 = z2;
  c = Math.cos(ry);
  s = Math.sin(ry);
  let x2 = x1 * c + z1 * s;
  z2 = -x1 * s + z1 * c;
  x1 = x2;
  z1 = z2;
  c = Math.cos(rz);
  s = Math.sin(rz);
  x2 = x1 * c - y1 * s;
  y2 = x1 * s + y1 * c;
  return [x2, y2, z2];
}

const GEO_TETRA = {
  verts: [
    norm3(1, 1, 1),
    norm3(1, -1, -1),
    norm3(-1, 1, -1),
    norm3(-1, -1, 1),
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ],
};

const GEO_CUBE = {
  verts: [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ].map(([a, b, c]) => norm3(a, b, c)),
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ],
};

const GEO_OCTA = {
  verts: [
    norm3(1, 0, 0),
    norm3(-1, 0, 0),
    norm3(0, 1, 0),
    norm3(0, -1, 0),
    norm3(0, 0, 1),
    norm3(0, 0, -1),
  ],
  edges: [
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 4],
    [2, 5],
    [3, 4],
    [3, 5],
  ],
};

function geoForKind(kind) {
  if (kind === 1) return GEO_CUBE;
  if (kind === 2) return GEO_OCTA;
  return GEO_TETRA;
}

const dfAmbientSyncFns = [];
let dfAmbientGlobalObservers = false;

function registerDfAmbientObservers() {
  if (dfAmbientGlobalObservers) return;
  dfAmbientGlobalObservers = true;
  const runAll = () => {
    for (const fn of dfAmbientSyncFns) fn();
  };
  new MutationObserver(runAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  const appEl = document.querySelector(".app");
  if (appEl) {
    new MutationObserver(runAll).observe(appEl, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
}

function setupAmbient(canvas) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return;

  const rnd = mulberry32(
    parseInt(canvas.dataset.seed, 10) || (Math.random() * 0xffffffff) | 0
  );

  let w = 0;
  let h = 0;
  let dpr = 1;
  let running = false;
  let raf = 0;

  const blobs = [];
  const solids = [];
  const hexes = [];
  const nodes = [];
  const sparks = [];

  function pick(lo, hi) {
    return lo + rnd() * (hi - lo);
  }

  function resize() {
    const parent = canvas.parentElement;
    const rw = parent ? parent.clientWidth : window.innerWidth;
    const rh = parent ? parent.clientHeight : window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(rw));
    h = Math.max(1, Math.floor(rh));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function buildEntities() {
    blobs.length = 0;
    solids.length = 0;
    hexes.length = 0;
    nodes.length = 0;
    sparks.length = 0;

    const nBlob = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < nBlob; i++) {
      blobs.push({
        x: pick(0, w),
        y: pick(0, h),
        r: pick(90, 220) * (0.5 + h / 1400),
        vx: pick(-0.12, 0.12),
        vy: pick(-0.1, 0.1),
        hue: 248 + pick(-18, 35),
        sat: 58 + pick(-8, 12),
      });
    }

    const nSolid = 6 + Math.floor(rnd() * 3);
    for (let i = 0; i < nSolid; i++) {
      const rk = rnd();
      const kind = rk < 0.48 ? 0 : rk < 0.78 ? 1 : 2;
      solids.push({
        x: pick(-80, w + 80),
        y: pick(-80, h + 80),
        size: pick(15, 26),
        rx: pick(0, Math.PI * 2),
        ry: pick(0, Math.PI * 2),
        rz: pick(0, Math.PI * 2),
        vrx: pick(-0.2, 0.2),
        vry: pick(-0.17, 0.17),
        vrz: pick(-0.18, 0.18),
        vx: pick(-0.08, 0.08),
        vy: pick(-0.07, 0.07),
        a: pick(0.07, 0.15),
        kind,
      });
    }

    const nHex = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < nHex; i++) {
      hexes.push({
        x: pick(0, w),
        y: pick(0, h),
        s: pick(28, 95),
        rot: pick(0, Math.PI * 2),
        vr: pick(0.0002, 0.00055) * (rnd() > 0.5 ? 1 : -1),
        vx: pick(-0.08, 0.08),
        vy: pick(-0.07, 0.07),
        a: pick(0.05, 0.11),
      });
    }

    const nNode = 20 + Math.floor(rnd() * 8);
    for (let i = 0; i < nNode; i++) {
      nodes.push({
        x: pick(0, w),
        y: pick(0, h),
        vx: pick(-0.06, 0.06),
        vy: pick(-0.05, 0.05),
      });
    }

    const nSpark = 62 + Math.floor(rnd() * 26);
    for (let i = 0; i < nSpark; i++) {
      sparks.push({
        x: pick(0, w),
        y: pick(0, h),
        vx: pick(-0.04, 0.04),
        vy: pick(-0.035, 0.035),
        r: pick(0.4, 1.6),
        a: pick(0.08, 0.38),
      });
    }
  }

  function drawHex(x, y, R, rotation) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rotation + (i / 6) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * R;
      const py = y + Math.sin(a) * R;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawWireSolid(s) {
    const geo = geoForKind(s.kind);
    const pts = geo.verts.map((v) => {
      const [px, py, pz] = rotate3(v[0], v[1], v[2], s.rx, s.ry, s.rz);
      const depth = pz + 2.35;
      const proj = (s.size * 2.05) / Math.max(0.5, depth);
      return { x: s.x + px * proj, y: s.y + py * proj, z: pz };
    });
    ctx.lineWidth = 1.15;
    for (let e = 0; e < geo.edges.length; e++) {
      const [i, j] = geo.edges[e];
      const a = pts[i];
      const b = pts[j];
      const zmid = (a.z + b.z) * 0.5;
      const fade = clamp((zmid + 1.15) / 2.5, 0.38, 1);
      const alt = e & 1;
      ctx.strokeStyle = alt
        ? `rgba(124, 108, 245, ${s.a * fade})`
        : `rgba(45, 212, 191, ${s.a * 0.88 * fade})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function step(dt) {
    const wrapPad = 160;
    for (const b of blobs) {
      b.x += b.vx * 55 * dt;
      b.y += b.vy * 55 * dt;
      if (b.x < -wrapPad) b.x = w + wrapPad;
      if (b.x > w + wrapPad) b.x = -wrapPad;
      if (b.y < -wrapPad) b.y = h + wrapPad;
      if (b.y > h + wrapPad) b.y = -wrapPad;
    }
    for (const s of solids) {
      s.x += s.vx * 48 * dt;
      s.y += s.vy * 48 * dt;
      s.rx += s.vrx * dt;
      s.ry += s.vry * dt;
      s.rz += s.vrz * dt;
      if (s.x < -wrapPad) s.x = w + wrapPad;
      if (s.x > w + wrapPad) s.x = -wrapPad;
      if (s.y < -wrapPad) s.y = h + wrapPad;
      if (s.y > h + wrapPad) s.y = -wrapPad;
    }
    for (const hx of hexes) {
      hx.x += hx.vx * 42 * dt;
      hx.y += hx.vy * 42 * dt;
      hx.rot += hx.vr * 1000 * dt;
      if (hx.x < -wrapPad) hx.x = w + wrapPad;
      if (hx.x > w + wrapPad) hx.x = -wrapPad;
      if (hx.y < -wrapPad) hx.y = h + wrapPad;
      if (hx.y > h + wrapPad) hx.y = -wrapPad;
    }
    for (const n of nodes) {
      n.x += n.vx * 32 * dt;
      n.y += n.vy * 32 * dt;
      if (n.x < 0) n.x = w;
      if (n.x > w) n.x = 0;
      if (n.y < 0) n.y = h;
      if (n.y > h) n.y = 0;
    }
    for (const s of sparks) {
      s.x += s.vx * 36 * dt;
      s.y += s.vy * 36 * dt;
      if (s.x < 0) s.x = w;
      if (s.x > w) s.x = 0;
      if (s.y < 0) s.y = h;
      if (s.y > h) s.y = 0;
    }
  }

  function drawFrame(t) {
    const lg = ctx.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, "#070712");
    lg.addColorStop(0.45, "#06060a");
    lg.addColorStop(1, "#0a0c14");
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, w, h);

    const tHue = t * 0.00002;
    for (const b of blobs) {
      const grd = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      const hShift = Math.sin(tHue + b.x * 0.001) * 8;
      grd.addColorStop(
        0,
        `hsla(${clamp(b.hue + hShift, 220, 290)}, ${b.sat}%, 52%, 0.16)`
      );
      grd.addColorStop(0.45, `hsla(${b.hue + 15}, 55%, 42%, 0.05)`);
      grd.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const linkDist = Math.min(140, Math.max(90, Math.hypot(w, h) * 0.11));
    const linkDist2 = linkDist * linkDist;
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 > linkDist2) continue;
        const fade = 1 - d2 / linkDist2;
        ctx.strokeStyle = `rgba(140, 160, 220, ${0.035 + fade * 0.1})`;
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();
      }
    }

    for (const hx of hexes) {
      ctx.strokeStyle = `rgba(100, 200, 210, ${hx.a})`;
      ctx.lineWidth = 1;
      drawHex(hx.x, hx.y, hx.s, hx.rot);
      ctx.stroke();
      ctx.strokeStyle = `rgba(167, 139, 250, ${hx.a * 0.75})`;
      drawHex(hx.x, hx.y, hx.s * 0.58, hx.rot + 0.2);
      ctx.stroke();
    }

    for (const s of solids) {
      drawWireSolid(s);
    }

    for (const s of sparks) {
      ctx.fillStyle = `rgba(230, 235, 255, ${s.a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let last = 0;
  function frame(now) {
    if (!running) return;
    const raw = (now - last) / 1000;
    const dt = clamp(raw || 0.016, 0.001, 0.05);
    last = now;
    if (!reduced) step(dt);
    drawFrame(now);
    raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function ambientShouldPause() {
    const h = document.documentElement;
    if (h.classList.contains("embed-camera-root")) return true;
    if (h.classList.contains("canvas-fullscreen")) return true;
    return !!document.querySelector(".app.canvas-fullscreen");
  }

  function syncAmbientLoop() {
    if (reduced) return;
    if (document.hidden || ambientShouldPause()) {
      stopLoop();
      return;
    }
    if (!running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function onVis() {
    syncAmbientLoop();
  }

  resize();
  buildEntities();

  const ro = new ResizeObserver(() => {
    resize();
    buildEntities();
    if (reduced) drawFrame(0);
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);

  window.addEventListener("resize", () => {
    resize();
    buildEntities();
    if (reduced) drawFrame(0);
  });

  document.addEventListener("visibilitychange", onVis);

  dfAmbientSyncFns.push(syncAmbientLoop);
  registerDfAmbientObservers();

  if (reduced) {
    drawFrame(0);
  } else {
    syncAmbientLoop();
  }
}

document.querySelectorAll("canvas.df-ambient-canvas").forEach((el) => {
  setupAmbient(el);
});
