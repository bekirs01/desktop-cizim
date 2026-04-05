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

function editorAndViewerPasswordsConflict(editorPassword, viewerPassword) {
  const ed = editorPassword && String(editorPassword).trim() ? String(editorPassword).trim() : null;
  const vw = viewerPassword && String(viewerPassword).trim() ? String(viewerPassword).trim() : null;
  return !!(ed && vw && ed === vw);
}

/** sharePassword = öğretmen (çizim), viewerPassword = öğrenci (salt izleme) */
export async function uploadPdfToSupabase(file, onSuccess, onError, sharePassword = null, viewerPassword = null) {
  if (!supabase) {
    onError?.("Supabase не настроен");
    return null;
  }
  try {
    if (editorAndViewerPasswordsConflict(sharePassword, viewerPassword)) {
      onError?.("Пароли ведущего и зрителя не должны совпадать.");
      return null;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      onError?.("Вход не выполнен");
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
    if (uploadErr) throw new Error("Storage: " + (uploadErr.message || "Ошибка загрузки"));

    const sharePasswordHash = sharePassword ? await hashPassword(sharePassword) : null;
    const viewerPasswordHash = viewerPassword ? await hashPassword(viewerPassword) : null;
    const insertRow = {
      user_id: user.id,
      storage_path: path,
      share_token: shareId,
      file_name: file.name,
    };
    if (sharePasswordHash) insertRow.share_password_hash = sharePasswordHash;
    if (viewerPasswordHash) insertRow.share_viewer_password_hash = viewerPasswordHash;

    let { error: dbErr } = await supabase.from("pdfs").insert(insertRow);
    const msg = (dbErr?.message || "") + (dbErr?.details || "");
    if (dbErr && viewerPasswordHash && /share_viewer_password_hash|schema cache/i.test(msg)) {
      const fallback = { ...insertRow };
      delete fallback.share_viewer_password_hash;
      ({ error: dbErr } = await supabase.from("pdfs").insert(fallback));
      if (!dbErr) {
        console.warn("Нет столбца share_viewer_password_hash; пароль зрителя не сохранён. Выполните PDF_DUAL_PASSWORD_MIGRATION.sql в Supabase.");
      }
    }
    if (dbErr) throw new Error("База данных: " + (dbErr.message || "Ошибка сохранения"));

    const link = `${getShareBaseUrl()}/index.html?id=${shareId}`;
    onSuccess?.(link);
    return { shareId, link };
  } catch (err) {
    onError?.(err.message || "Ошибка загрузки");
    return null;
  }
}

/** PDF paylaşım şifresini ayarla veya kaldır (sadece sahip) — sadece öğretmen şifresi */
export async function setPdfSharePassword(shareToken, password) {
  if (!supabase) return false;
  const pwd = password && String(password).trim() ? String(password).trim() : null;
  const { data, error } = await supabase.rpc("set_pdf_share_password", {
    token: shareToken,
    pwd: pwd,
  });
  return !error && data === true;
}

function formatSupabaseErr(err) {
  if (!err) return "";
  const m = [err.message, err.details, err.hint, err.code].filter(Boolean).join(" — ");
  return m || String(err);
}

/** Tabloya doğrudan yaz (RPC yok / RLS ile). pdfRowId varsa satır id ile eşleşir (daha güvenilir). */
async function updatePdfPasswordsOnRow(shareToken, editorPassword, viewerPassword, pdfRowId = null) {
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return { ok: false, error: "Сессия отсутствует; войдите снова." };
  if (editorAndViewerPasswordsConflict(editorPassword, viewerPassword)) {
    return { ok: false, error: "Пароли ведущего и зрителя не должны совпадать." };
  }
  const ed = editorPassword && String(editorPassword).trim() ? String(editorPassword).trim() : null;
  const vw = viewerPassword && String(viewerPassword).trim() ? String(viewerPassword).trim() : null;
  const edHash = ed ? await hashPassword(ed) : null;
  const vwHash = vw ? await hashPassword(vw) : null;
  const payload = {
    share_password_hash: edHash,
    share_viewer_password_hash: vwHash,
  };
  let q = supabase.from("pdfs").update(payload).eq("user_id", user.id);
  if (pdfRowId) q = q.eq("id", pdfRowId);
  else q = q.eq("share_token", shareToken);
  let { data, error } = await q.select("id");
  const errMsg = (error?.message || "") + (error?.details || "");
  if (error && /share_viewer_password_hash|column|schema cache/i.test(errMsg)) {
    const fallback = { share_password_hash: edHash };
    let q2 = supabase.from("pdfs").update(fallback).eq("user_id", user.id);
    if (pdfRowId) q2 = q2.eq("id", pdfRowId);
    else q2 = q2.eq("share_token", shareToken);
    ({ data, error } = await q2.select("id"));
    if (!error) {
      console.warn("Не удалось сохранить пароль зрителя: нет столбца share_viewer_password_hash. Выполните PDF_DUAL_PASSWORD_MIGRATION.sql.");
    }
  }
  if (!error && Array.isArray(data) && data.length > 0) return { ok: true };
  if (error) {
    return { ok: false, error: formatSupabaseErr(error) || "Не удалось обновить" };
  }
  return {
    ok: false,
    error:
      "Запись не обновлена (0 строк). В Supabase SQL Editor выполните UPDATE policy для pdfs (pdfs_user_update) и PDF_DUAL_PASSWORD_MIGRATION.sql.",
  };
}

/** İki şifre: öğretmen (tam erişim) + öğrenci (salt izleme). Boş = o şifreyi kaldır. pdfRowId = pdfs.id (UUID) */
export async function setPdfSharePasswords(shareToken, editorPassword, viewerPassword, pdfRowId = null) {
  if (!supabase || !shareToken) return { ok: false, error: "Supabase veya token yok" };
  if (editorAndViewerPasswordsConflict(editorPassword, viewerPassword)) {
    return { ok: false, error: "Пароли ведущего и зрителя не должны совпадать." };
  }
  const ed = editorPassword && String(editorPassword).trim() ? String(editorPassword).trim() : null;
  const vw = viewerPassword && String(viewerPassword).trim() ? String(viewerPassword).trim() : null;

  if (pdfRowId) {
    const byId = await supabase.rpc("set_pdf_share_passwords_by_id", {
      p_id: pdfRowId,
      p_editor: ed,
      p_viewer: vw,
    });
    if (!byId.error && byId.data === true) return { ok: true };
    if (byId.error && !/function|does not exist|PGRST202|schema cache/i.test(formatSupabaseErr(byId.error))) {
      console.warn("set_pdf_share_passwords_by_id:", byId.error);
    }
  }

  const { data, error } = await supabase.rpc("set_pdf_share_passwords", {
    p_token: shareToken,
    p_editor: ed,
    p_viewer: vw,
  });

  if (!error && data === true) return { ok: true };

  if (error) {
    console.warn("set_pdf_share_passwords RPC:", formatSupabaseErr(error));
  }

  return updatePdfPasswordsOnRow(shareToken, ed, vw, pdfRowId);
}

/** PDF'i Storage, pdf_strokes ve pdfs tablosundan tamamen siler */
export async function deletePdfFromSupabase(pdfRow, onError) {
  if (!supabase) {
    onError?.("Supabase не настроен");
    return false;
  }
  try {
    const { share_token, storage_path, id } = pdfRow;
    if (!share_token || !storage_path || !id) {
      onError?.("Недостаточно данных PDF");
      return false;
    }
    await supabase.from("pdf_page_strokes").delete().eq("share_token", share_token);
    const { error: storageErr } = await supabase.storage.from("pdfs").remove([storage_path]);
    if (storageErr) console.warn("Предупреждение удаления из Storage:", storageErr);
    const { error: dbErr } = await supabase.from("pdfs").delete().eq("id", id);
    if (dbErr) throw new Error(dbErr.message || "Ошибка удаления из базы данных");
    return true;
  } catch (err) {
    onError?.(err.message || "Ошибка удаления");
    return false;
  }
}
