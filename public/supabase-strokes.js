/**
 * PDF çizimleri - Sayfa başına 1 kayıt (mobil + gerçek zamanlı uyumlu)
 */
import { supabase } from "./supabase-config.js";

/** Douglas-Peucker: Nokta sadeleştirme */
function simplifyPoints(points, epsilon = 0.002) {
  if (!points || points.length < 3) return points || [];
  const sq = (x) => x * x;
  const distToSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-10;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + t * dx, y: a.y + t * dy };
    return Math.sqrt(sq(p.x - proj.x) + sq(p.y - proj.y));
  };
  const douglasPeucker = (pts, eps) => {
    if (pts.length < 3) return pts;
    let maxD = 0, idx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distToSegment(pts[i], a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= eps) return [a, b];
    return [...douglasPeucker(pts.slice(0, idx + 1), eps), ...douglasPeucker(pts.slice(idx), eps).slice(1)];
  };
  return douglasPeucker(points, epsilon);
}

/** Tek stroke'ı sayfa verisine ekler (eski API uyumluluğu) */
export async function saveStroke(shareToken, pageNum, stroke) {
  const strokes = await fetchPageStrokes(shareToken, pageNum);
  const { points, color, lineWidth } = stroke;
  if (!points || points.length < 2) return null;
  const simplified = simplifyPoints(points);
  if (simplified.length < 2) return null;
  strokes.push({ points: simplified, color: color || "#00ff9f", lineWidth: lineWidth ?? 4 });
  return savePageStrokes(shareToken, pageNum, strokes);
}

function serializeFillShape(f) {
  if (!f?.data || !f.w || !f.h) return null;
  try {
    const c = document.createElement("canvas");
    c.width = f.w;
    c.height = f.h;
    c.getContext("2d").putImageData(f.data, 0, 0);
    const url = c.toDataURL("image/png");
    return { data: url.replace(/^data:image\/png;base64,/, ""), w: f.w, h: f.h };
  } catch (e) {
    return null;
  }
}
function deserializeFillShape(s) {
  if (!s?.data || !s.w || !s.h) return null;
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = s.w;
      c.height = s.h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      res({ data: ctx.getImageData(0, 0, s.w, s.h), w: s.w, h: s.h });
    };
    img.onerror = () => res(null);
    img.src = "data:image/png;base64," + s.data;
  });
}

/** Serileştirilmiş fill_shapes dizisini ImageData formatına çevirir */
export async function deserializeFillShapes(serialized) {
  if (!serialized || !Array.isArray(serialized)) return [];
  const out = [];
  for (const s of serialized) {
    const f = await deserializeFillShape(s);
    if (f) out.push(f);
  }
  return out;
}

/** Sayfanın tüm stroke'larını (ve isteğe bağlı shapes, fillShapes) kaydeder */
export async function savePageStrokes(shareToken, pageNum, strokes, shapes, fillShapes) {
  if (!supabase) return false;
  const cleaned = (strokes || [])
    .filter((s) => s.points?.length >= 2)
    .map((s) => ({
      points: simplifyPoints(s.points).length >= 2 ? simplifyPoints(s.points) : s.points,
      color: s.color || "#00ff9f",
      lineWidth: s.lineWidth ?? 4,
    }));
  const shapesJson =
    shapes && shapes.length > 0
      ? shapes.map((s) => {
          const o = { ...s };
          if (o.type === "image") delete o._img;
          return o;
        })
      : [];
  const fillShapesJson = fillShapes && fillShapes.length > 0
    ? fillShapes.map(serializeFillShape).filter(Boolean)
    : [];
  const payload = {
    share_token: shareToken,
    page_num: pageNum,
    strokes: cleaned,
    shapes: shapesJson,
    fill_shapes: fillShapesJson,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("pdf_page_strokes").upsert(payload, {
    onConflict: "share_token,page_num",
  });
  if (error) {
    console.warn("Ошибка сохранения страницы:", error);
    return false;
  }
  return { updated_at: payload.updated_at };
}

/** Tek sayfanın stroke'larını getirir */
export async function fetchPageStrokes(shareToken, pageNum) {
  const rows = await fetchStrokes(shareToken);
  const page = rows?.find((r) => r.page_num === pageNum);
  return page?.strokes || [];
}

/** Tüm sayfaların stroke'larını getirir (shapes, fill_shapes dahil) */
export async function fetchStrokes(shareToken) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("pdf_page_strokes")
    .select("page_num, strokes, shapes, fill_shapes")
    .eq("share_token", shareToken)
    .order("page_num", { ascending: true });
  if (error) {
    console.warn("Ошибка загрузки штрихов:", error);
    return null;
  }
  return (data || []).map((r) => ({
    page_num: r.page_num,
    strokes: r.strokes || [],
    shapes: r.shapes || [],
    fill_shapes: r.fill_shapes || [],
  }));
}

/** Eski API: fetchStrokes döngüsel format (her satır = stroke) - view/script uyumluluğu */
export async function fetchStrokesLegacy(shareToken) {
  const pages = await fetchStrokes(shareToken);
  const out = [];
  for (const p of pages || []) {
    for (const s of p.strokes || []) {
      out.push({ page_num: p.page_num, stroke_data: s });
    }
  }
  return out;
}

export async function deleteStrokesForPage(shareToken, pageNum) {
  if (!supabase) return;
  await supabase.from("pdf_page_strokes").delete().eq("share_token", shareToken).eq("page_num", pageNum);
}

/** Gerçek zamanlı: postgres_changes + broadcast (anlık senkron) */
export function subscribeStrokes(shareToken, onUpdate) {
  if (!supabase) return { unsubscribe: () => {}, broadcast: () => {} };
  const channel = supabase.channel(`pdf_page_strokes:${shareToken}`);
  channel
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pdf_page_strokes", filter: `share_token=eq.${shareToken}` },
      (payload) => { if (payload) onUpdate?.(payload); }
    )
    .on("broadcast", { event: "stroke" }, (msg) => {
      const { pageNum, strokes, updated_at } = msg?.payload || msg || {};
      if (pageNum == null || !strokes) return;
      const row = { page_num: pageNum, share_token: shareToken, strokes };
      if (typeof updated_at === "string") row.updated_at = updated_at;
      onUpdate?.({ new: row });
    })
    .on("broadcast", { event: "stroke_progress" }, (msg) => {
      const { pageNum, stroke } = msg?.payload || msg || {};
      if (pageNum != null && stroke?.points?.length >= 2) onUpdate?.({ type: "progress", pageNum, stroke });
    })
    .on("broadcast", { event: "pointer_position" }, (msg) => {
      const p = msg?.payload?.payload || msg?.payload || msg || {};
      const { x, y } = p;
      if (typeof x === "number" && typeof y === "number") onUpdate?.({ event: "pointer_position", payload: { x, y } });
    })
    .on("broadcast", { event: "pointer_hidden" }, () => {
      onUpdate?.({ event: "pointer_hidden" });
    })
    .on("broadcast", { event: "remote_ui" }, (msg) => {
      window.dispatchEvent(
        new CustomEvent("drawflow-remote-ui", { detail: msg?.payload || msg || {} })
      );
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.warn("[Realtime] Ошибка подключения — выполнен ли SUPABASE_REALTIME_ENABLE.sql?");
    });
  return {
    unsubscribe: () => supabase.removeChannel(channel),
    broadcast: (pageNum, strokes, updated_at) => {
      const payload = { pageNum, strokes };
      if (typeof updated_at === "string") payload.updated_at = updated_at;
      channel.send({ type: "broadcast", event: "stroke", payload });
    },
    broadcastProgress: (pageNum, stroke) => {
      if (stroke?.points?.length >= 2) channel.send({ type: "broadcast", event: "stroke_progress", payload: { pageNum, stroke } });
    },
  };
}
