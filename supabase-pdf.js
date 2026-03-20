/**
 * PDF'i Supabase Storage'a yükleyip veritabanına kaydeder
 * supabase-config.js'te URL ve KEY doldurulmalı
 */
import { supabase, getShareBaseUrl } from "./supabase-config.js";

async function hashPassword(password) {
  if (!password || !password.trim()) return null;
  const enc = new TextEncoder();
  const data = enc.encode(password.trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function uploadPdfToSupabase(file, onSuccess, onError, sharePassword = null) {
  if (!supabase) {
    onError?.("Supabase yapılandırılmamış");
    return null;
  }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      onError?.("Giriş yapılmamış");
      return null;
    }
    const user = session.user;
    const shareId = crypto.randomUUID().replace(/-/g, "");
    const ext = (file.name.split(".").pop() || "pdf").toLowerCase();
    const path = `${user.id}/${shareId}.${ext}`;
    const contentType = ext === "pptx"
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/pdf";

    const { error: uploadErr } = await supabase.storage.from("pdfs").upload(path, file, {
      upsert: true,
      contentType,
    });
    if (uploadErr) throw new Error("Storage: " + (uploadErr.message || "Yükleme hatası"));

    const sharePasswordHash = sharePassword ? await hashPassword(sharePassword) : null;
    const insertRow = {
      user_id: user.id,
      storage_path: path,
      share_token: shareId,
      file_name: file.name,
    };
    if (sharePasswordHash) insertRow.share_password_hash = sharePasswordHash;

    const { error: dbErr } = await supabase.from("pdfs").insert(insertRow);
    if (dbErr) throw new Error("Veritabanı: " + (dbErr.message || "Kayıt hatası"));

    const link = `${getShareBaseUrl()}/index.html?id=${shareId}`;
    onSuccess?.(link);
    return { shareId, link };
  } catch (err) {
    onError?.(err.message || "Yükleme hatası");
    return null;
  }
}

/** PDF paylaşım şifresini ayarla veya kaldır (sadece sahip) */
export async function setPdfSharePassword(shareToken, password) {
  if (!supabase) return false;
  const pwd = password && String(password).trim() ? String(password).trim() : null;
  const { data, error } = await supabase.rpc("set_pdf_share_password", {
    token: shareToken,
    pwd: pwd,
  });
  return !error && data === true;
}

/** PDF'i Storage, pdf_strokes ve pdfs tablosundan tamamen siler */
export async function deletePdfFromSupabase(pdfRow, onError) {
  if (!supabase) {
    onError?.("Supabase yapılandırılmamış");
    return false;
  }
  try {
    const { share_token, storage_path, id } = pdfRow;
    if (!share_token || !storage_path || !id) {
      onError?.("Eksik PDF bilgisi");
      return false;
    }
    await supabase.from("pdf_page_strokes").delete().eq("share_token", share_token);
    const { error: storageErr } = await supabase.storage.from("pdfs").remove([storage_path]);
    if (storageErr) console.warn("Storage silme uyarısı:", storageErr);
    const { error: dbErr } = await supabase.from("pdfs").delete().eq("id", id);
    if (dbErr) throw new Error(dbErr.message || "Veritabanı silme hatası");
    return true;
  } catch (err) {
    onError?.(err.message || "Silme hatası");
    return false;
  }
}
