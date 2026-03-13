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

/** Sayfanın tüm stroke'larını kaydeder - 1 sayfa = 1 kayıt */
export async function savePageStrokes(shareToken, pageNum, strokes) {
  if (!supabase) return false;
  const cleaned = (strokes || [])
    .filter((s) => s.points?.length >= 2)
    .map((s) => ({
      points: simplifyPoints(s.points).length >= 2 ? simplifyPoints(s.points) : s.points,
      color: s.color || "#00ff9f",
      lineWidth: s.lineWidth ?? 4,
    }));
  const { error } = await supabase.from("pdf_page_strokes").upsert(
    { share_token: shareToken, page_num: pageNum, strokes: cleaned, updated_at: new Date().toISOString() },
    { onConflict: "share_token,page_num" }
  );
  if (error) {
    console.warn("Sayfa kaydetme hatası:", error);
    return false;
  }
  return true;
}

/** Tek sayfanın stroke'larını getirir */
export async function fetchPageStrokes(shareToken, pageNum) {
  const rows = await fetchStrokes(shareToken);
  const page = rows?.find((r) => r.page_num === pageNum);
  return page?.strokes || [];
}

/** Tüm sayfaların stroke'larını getirir (eski format: {page_num, stroke_data} uyumluluğu) */
export async function fetchStrokes(shareToken) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("pdf_page_strokes")
    .select("page_num, strokes")
    .eq("share_token", shareToken)
    .order("page_num", { ascending: true });
  if (error) {
    console.warn("Stroke yükleme hatası:", error);
    return null;
  }
  return (data || []).map((r) => ({ page_num: r.page_num, strokes: r.strokes || [] }));
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

/** Gerçek zamanlı: Sayfa güncellendiğinde tetiklenir - anlık senkron (sayfa yenilemeden) */
export function subscribeStrokes(shareToken, onUpdate) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`pdf_page_strokes:${shareToken}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pdf_page_strokes", filter: `share_token=eq.${shareToken}` },
      (payload) => {
        if (payload) onUpdate?.(payload);
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.warn("[Realtime] Bağlantı hatası - SUPABASE_REALTIME_ENABLE.sql çalıştırdın mı?");
    });
  return () => supabase.removeChannel(channel);
}
