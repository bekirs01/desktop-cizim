/**
 * PDF'i Supabase Storage'a yükleyip veritabanına kaydeder
 * supabase-config.js'te URL ve KEY doldurulmalı
 */
import { supabase, getShareBaseUrl } from "./supabase-config.js";

export async function uploadPdfToSupabase(file, onSuccess, onError) {
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
    const ext = file.name.split(".").pop() || "pdf";
    const path = `${user.id}/${shareId}.${ext}`;

    const { error: uploadErr } = await supabase.storage.from("pdfs").upload(path, file, {
      upsert: true,
      contentType: "application/pdf",
    });
    if (uploadErr) throw new Error("Storage: " + (uploadErr.message || "Yükleme hatası"));

    const { error: dbErr } = await supabase.from("pdfs").insert({
      user_id: user.id,
      storage_path: path,
      share_token: shareId,
      file_name: file.name,
    });
    if (dbErr) throw new Error("Veritabanı: " + (dbErr.message || "Kayıt hatası"));

    const link = `${getShareBaseUrl()}/index.html?id=${shareId}`;
    onSuccess?.(link);
    return { shareId, link };
  } catch (err) {
    onError?.(err.message || "Yükleme hatası");
    return null;
  }
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
