/**
 * Çizim belgeleri - canvases tablosu
 */
import { supabase } from "./supabase-config.js";

async function hashPassword(password) {
  if (!password || !password.trim()) return null;
  const enc = new TextEncoder();
  const data = enc.encode(password.trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Yeni çizim belgesi oluştur */
export async function createCanvas(name, sharePassword = null) {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const shareToken = crypto.randomUUID().replace(/-/g, "");
  const sharePasswordHash = sharePassword ? await hashPassword(sharePassword) : null;
  const { data, error } = await supabase.from("canvases").insert({
    user_id: user.id,
    name: (name || "Рисунок").trim() || "Рисунок",
    share_token: shareToken,
    share_password_hash: sharePasswordHash,
  }).select("id, share_token").single();
  if (error) return null;
  return { id: data.id, shareToken: data.share_token };
}

/** Token ile canvas belgesi kontrolü (şifre gerekli mi?) - get_canvas_by_share_token RPC */
export async function getCanvasByShareToken(token, password = null) {
  if (!supabase || !token) return { shareToken: null, needsPassword: null };
  try {
    const { data, error } = await supabase.rpc("get_canvas_by_share_token", {
      token: String(token).trim(),
      pwd: password && String(password).trim() ? String(password).trim() : null,
    });
    if (error) return { shareToken: null, needsPassword: null };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { shareToken: null, needsPassword: null };
    const st = row?.share_token ?? null;
    const needs = !!row?.needs_password;
    if (st) return { shareToken: st, needsPassword: false };
    if (needs) return { shareToken: null, needsPassword: true };
    return { shareToken: null, needsPassword: null };
  } catch (e) {
    return { shareToken: null, needsPassword: null };
  }
}

/** Çizim belgesi sil */
export async function deleteCanvas(row) {
  if (!supabase) return false;
  const { id, share_token } = row;
  if (!id || !share_token) return false;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  await supabase.from("pdf_page_strokes").delete().eq("share_token", share_token);
  const { error } = await supabase.from("canvases").delete().eq("id", id).eq("user_id", user.id);
  return !error;
}

/** Kullanıcının çizim belgelerini listele */
export async function listCanvases() {
  if (!supabase) return [];
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("canvases")
    .select("id, name, share_token, share_password_hash, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return [];
  return data || [];
}

/** Çizim şifresini ayarla */
export async function setCanvasSharePassword(shareToken, password) {
  if (!supabase) return false;
  const pwd = password && String(password).trim() ? String(password).trim() : null;
  const { data, error } = await supabase.rpc("set_canvas_share_password", {
    token: shareToken,
    pwd: pwd,
  });
  return !error && data === true;
}
