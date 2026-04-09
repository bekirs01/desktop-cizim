/**
 * Dashboard - PDF ve çizim belgeleri
 */
import { supabase } from "./supabase-config.js";
import { uploadPdfToSupabase, deletePdfFromSupabase, setPdfSharePasswords } from "./supabase-pdf.js";
import { createCanvas, deleteCanvas, listCanvases, setCanvasSharePassword } from "./supabase-canvas.js";

function releaseAuthGate() {
  document.documentElement.classList.remove("auth-gate-pending");
}

if (!supabase) {
  releaseAuthGate();
  document.body.innerHTML = '<div class="dash-app"><p style="color:var(--dash-red);padding:3rem;text-align:center;">Supabase не настроен.</p></div>';
} else {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken) {
    await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken || "" });
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace("/login.html");
  } else {
    releaseAuthGate();
  }
}

(async () => {
  if (!supabase) return;
  const sub = document.getElementById("dashUserSubtitle");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const name =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()) ||
    (user.email || "").split("@")[0] ||
    "";
  if (sub) sub.textContent = name ? `С возвращением, ${name}` : "";
})();

const pdfList = document.getElementById("pdfList");
const pdfEmpty = document.getElementById("pdfEmpty");
const pdfCount = document.getElementById("pdfCount");
const uploadError = document.getElementById("uploadError");
const fileInput = document.getElementById("fileInput");
const uploadModal = document.getElementById("uploadModal");
const openUploadModalBtn = document.getElementById("openUploadModalBtn");
const uploadPickFileBtn = document.getElementById("uploadPickFileBtn");
const uploadModalCancelBtn = document.getElementById("uploadModalCancelBtn");
const uploadFileHint = document.getElementById("uploadFileHint");
const logoutBtn = document.getElementById("logoutBtn");
const pdfLinkInput = document.getElementById("pdfLinkInput");
const openLinkBtn = document.getElementById("openLinkBtn");
const shareBaseUrlInput = document.getElementById("shareBaseUrlInput");
const saveShareUrlBtn = document.getElementById("saveShareUrlBtn");
const handLeftBtn = document.getElementById("handLeftBtn");
const handRightBtn = document.getElementById("handRightBtn");

let preferredHand = (localStorage.getItem("preferredHand") || "right").toLowerCase();
handLeftBtn?.addEventListener("click", () => {
  preferredHand = "left";
  localStorage.setItem("preferredHand", "left");
  handLeftBtn?.classList.add("active");
  handRightBtn?.classList.remove("active");
});
handRightBtn?.addEventListener("click", () => {
  preferredHand = "right";
  localStorage.setItem("preferredHand", "right");
  handRightBtn?.classList.add("active");
  handLeftBtn?.classList.remove("active");
});
if (handLeftBtn && handRightBtn) {
  handLeftBtn.classList.toggle("active", preferredHand === "left");
  handRightBtn.classList.toggle("active", preferredHand === "right");
}

const urlParams = new URLSearchParams(window.location.search);
const shareUrlParam = urlParams.get("shareUrl");
if (shareUrlParam && shareUrlParam.startsWith("http")) {
  localStorage.setItem("shareBaseUrl", shareUrlParam.replace(/\/$/, ""));
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}
if (!window.location.hostname.match(/^localhost$|^127\.0\.0\.1$/)) {
  const origin = window.location.origin;
  if (origin.startsWith("http")) {
    localStorage.setItem("shareBaseUrl", origin);
  }
}

if (shareBaseUrlInput) shareBaseUrlInput.value = localStorage.getItem("shareBaseUrl") || "";
saveShareUrlBtn?.addEventListener("click", () => {
  const url = shareBaseUrlInput?.value?.trim() || "";
  if (url) {
    localStorage.setItem("shareBaseUrl", url.replace(/\/$/, ""));
    alert("Сохранено. Общие ссылки будут использовать этот базовый URL.");
  } else {
    localStorage.removeItem("shareBaseUrl");
    alert("Сброшено. Ссылки будут использовать текущий origin.");
  }
});

function extractShareIdFromLink(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  const canvasMatch = trimmed.match(/[?&]canvas=([a-zA-Z0-9_-]+)/);
  if (canvasMatch) return { type: "canvas", id: canvasMatch[1] };
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return { type: "pdf", id: idMatch[1] };
  if (/^[a-zA-Z0-9_-]{6,64}$/.test(trimmed)) return { type: "pdf", id: trimmed };
  return null;
}

function openPdfLink() {
  const parsed = extractShareIdFromLink(pdfLinkInput?.value || "");
  if (!parsed) {
    alert("Вставьте ссылку на общий PDF или холст (например …index.html?id=… или …index.html?canvas=…)");
    return;
  }
  const param = parsed.type === "canvas" ? "canvas" : "id";
  window.location.href = `/index.html?${param}=${encodeURIComponent(parsed.id)}`;
}
openLinkBtn?.addEventListener("click", openPdfLink);
pdfLinkInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); openPdfLink(); } });

document.getElementById("goCameraBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  sessionStorage.setItem("pendingCameraMode", "1");
  window.location.href = "/index.html?mode=camera";
});

document.getElementById("newCanvasBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const modal = document.getElementById("newCanvasModal");
  const nameInput = document.getElementById("newCanvasNameInput");
  const pwdInput = document.getElementById("newCanvasPasswordInput");
  if (modal && nameInput) {
    nameInput.value = "";
    if (pwdInput) pwdInput.value = "";
    modal.style.display = "flex";
    nameInput.focus();
  }
});

document.getElementById("newCanvasCreateBtn")?.addEventListener("click", async () => {
  const nameInput = document.getElementById("newCanvasNameInput");
  const pwdInput = document.getElementById("newCanvasPasswordInput");
  const name = nameInput?.value?.trim() || "";
  const pwd = pwdInput?.value?.trim() || null;
  const result = await createCanvas(name, pwd);
  document.getElementById("newCanvasModal").style.display = "none";
  if (result) {
    window.location.href = `/index.html?canvas=${result.shareToken}`;
  } else {
    alert("Не удалось создать документ");
  }
});

document.getElementById("newCanvasCancelBtn")?.addEventListener("click", () => {
  document.getElementById("newCanvasModal").style.display = "none";
});
document.getElementById("newCanvasModal")?.querySelector(".dash-modal-backdrop")?.addEventListener("click", () => {
  document.getElementById("newCanvasModal").style.display = "none";
});

function closeUploadModal() {
  if (uploadModal) uploadModal.style.display = "none";
}

function openUploadModal() {
  showUploadError("");
  const p1 = document.getElementById("uploadPasswordInput");
  const p2 = document.getElementById("uploadViewerPasswordInput");
  if (p1) p1.value = "";
  if (p2) p2.value = "";
  if (fileInput) fileInput.value = "";
  if (uploadFileHint) uploadFileHint.textContent = "Файл не выбран";
  const lbl = document.getElementById("uploadBtnLabel");
  if (lbl) lbl.textContent = "Выбрать файл";
  if (uploadPickFileBtn) uploadPickFileBtn.style.opacity = "1";
  if (uploadModal) uploadModal.style.display = "flex";
}

openUploadModalBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  openUploadModal();
});

uploadPickFileBtn?.addEventListener("click", () => {
  fileInput?.click();
});

uploadModalCancelBtn?.addEventListener("click", closeUploadModal);
uploadModal?.querySelector(".dash-modal-backdrop")?.addEventListener("click", closeUploadModal);

let passwordModalType = "pdf";

async function loadDocuments() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const [pdfRes, canvases] = await Promise.all([
    supabase.from("pdfs").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
    listCanvases(),
  ]);
  const pdfError = pdfRes.error;
  const pdfData = pdfRes.data || [];
  if (pdfError) {
    showListError("Не удалось загрузить документы: " + (pdfError.message || "ошибка"));
    return;
  }
  showListError("");
  const items = [
    ...pdfData.map((r) => {
      const fn = r.file_name || r.storage_path || "";
      const isPptx = fn.toLowerCase().endsWith(".pptx");
      return { ...r, type: isPptx ? "pptx" : "pdf", name: r.file_name || (isPptx ? "Презентация" : "PDF"), date: r.created_at };
    }),
    ...canvases.map((r) => ({ ...r, type: "canvas", name: r.name || "Холст", date: r.created_at, share_password_hash: r.share_password_hash })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  pdfList.innerHTML = "";
  if (!items.length) {
    pdfEmpty.style.display = "block";
    if (pdfCount) pdfCount.style.display = "none";
    return;
  }
  pdfEmpty.style.display = "none";
  if (pdfCount) {
    pdfCount.textContent = items.length;
    pdfCount.style.display = "inline";
  }
  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    const div = document.createElement("div");
    div.className = "dash-pdf-item";
    div.style.animationDelay = `${0.05 * i}s`;
    const date = row.date ? new Date(row.date).toLocaleDateString("ru-RU", { year: "numeric", month: "short", day: "numeric" }) : "";
    const hasPwd = !!(row.share_password_hash || row.share_viewer_password_hash);
    const iconWrap = row.type === "pdf"
      ? `<div class="dash-pdf-icon dash-pdf-icon--pdf" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg></div>`
      : row.type === "pptx"
        ? `<div class="dash-pdf-icon dash-pdf-icon--pptx" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="12" rx="1.5"/><line x1="3" y1="7.5" x2="21" y2="7.5"/><line x1="7" y1="11" x2="17" y2="11"/><line x1="7" y1="13.5" x2="13" y2="13.5"/><line x1="12" y1="15" x2="12" y2="17"/><line x1="9" y1="17" x2="15" y2="17"/></svg></div>`
        : `<div class="dash-pdf-icon dash-pdf-icon--canvas" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg></div>`;
    const lockSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
    const lockBadge = hasPwd
      ? `<span class="dash-lock-badge" title="Защищено паролем">${lockSvg}</span>`
      : "";
    const openHref = (row.type === "pdf" || row.type === "pptx") ? `/index.html?id=${row.share_token}` : `/index.html?canvas=${row.share_token}`;
    const deleteData = (row.type === "pdf" || row.type === "pptx")
      ? `data-id="${row.id}" data-share="${row.share_token}" data-path="${escapeHtml(row.storage_path || "")}" data-type="pdf"`
      : `data-id="${row.id}" data-share="${row.share_token}" data-type="canvas"`;
    div.innerHTML = `
      ${iconWrap}
      <div class="dash-pdf-info">
        <div class="dash-pdf-name">${escapeHtml(row.name)}</div>
        <div class="dash-pdf-meta">${escapeHtml(date)}${lockBadge}</div>
      </div>
      <div class="dash-pdf-actions">
        <a href="${openHref}" class="dash-btn dash-btn-primary" style="font-size:0.8rem;padding:0.5rem 1rem;">Открыть</a>
        <button type="button" class="dash-btn dash-btn-ghost doc-password-btn" style="font-size:0.8rem;padding:0.45rem 0.65rem;" data-share="${row.share_token}" data-doc-id="${row.type === "canvas" ? "" : (row.id || "")}" data-type="${row.type}" title="${hasPwd ? "Изменить пароль" : "Добавить пароль"}" aria-label="${hasPwd ? "Изменить пароль" : "Добавить пароль"}">${lockSvg}</button>
        <button type="button" class="dash-btn dash-btn-danger-ghost doc-delete-btn" style="font-size:0.8rem;padding:0.45rem 0.75rem;" ${deleteData} title="Удалить"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg><span class="doc-btn-text">Удалить</span></button>
      </div>
    `;
    pdfList.appendChild(div);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function showUploadError(msg) {
  if (uploadError) {
    uploadError.textContent = msg || "";
    uploadError.style.display = msg ? "block" : "none";
  }
}

function showListError(msg) {
  const el = document.getElementById("dashListError");
  if (el) {
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
}

fileInput?.addEventListener("change", async (e) => {
  const uploadBtnLabel = document.getElementById("uploadBtnLabel");
  const file = e.target.files?.[0];
  if (!file) return;
  const ext = (file.name || "").split(".").pop()?.toLowerCase();
  if (ext !== "pdf" && ext !== "pptx") {
    showUploadError("Поддерживаются только файлы PDF и PPTX");
    e.target.value = "";
    return;
  }
  showUploadError("");
  if (uploadFileHint) uploadFileHint.textContent = file.name;
  const sharePassword = document.getElementById("uploadPasswordInput")?.value?.trim() || null;
  const viewerPassword = document.getElementById("uploadViewerPasswordInput")?.value?.trim() || null;
  if (uploadPickFileBtn) uploadPickFileBtn.style.opacity = "0.6";
  if (uploadBtnLabel) uploadBtnLabel.textContent = "Загрузка…";
  let err = null;
  try {
    const result = await uploadPdfToSupabase(file, null, (e) => { err = e; }, sharePassword, viewerPassword);
    if (uploadPickFileBtn) uploadPickFileBtn.style.opacity = "1";
    if (uploadBtnLabel) uploadBtnLabel.textContent = "Выбрать файл";
    e.target.value = "";
    if (err) {
      showUploadError("Ошибка загрузки: " + err);
      return;
    }
    if (result) {
      closeUploadModal();
      await loadDocuments();
    }
  } catch (ex) {
    if (uploadPickFileBtn) uploadPickFileBtn.style.opacity = "1";
    if (uploadBtnLabel) uploadBtnLabel.textContent = "Выбрать файл";
    e.target.value = "";
    showUploadError("Ошибка: " + (ex?.message || ex));
  }
});

logoutBtn?.addEventListener("click", async () => {
  if (!supabase) return;
  await supabase.auth.signOut();
  window.location.replace("/login.html");
});

pdfList.addEventListener("click", async (e) => {
  const delBtn = e.target.closest(".doc-delete-btn");
  if (delBtn) {
    e.preventDefault();
    const id = delBtn.dataset.id;
    const share_token = delBtn.dataset.share;
    const type = delBtn.dataset.type || "pdf";
    if (!id || !share_token) return;
    if (!confirm("Удалить этот документ и все рисунки безвозвратно?")) return;
    delBtn.disabled = true;
    const delLabel = delBtn.querySelector(".doc-btn-text");
    if (delLabel) delLabel.textContent = "…";
    let ok = false;
    if (type === "pdf" || type === "pptx") {
      ok = await deletePdfFromSupabase({ id, share_token, storage_path: delBtn.dataset.path || "" }, (err) => alert(err));
    } else {
      ok = await deleteCanvas({ id, share_token });
    }
    if (ok) await loadDocuments();
    else {
      delBtn.disabled = false;
      const lbl = delBtn.querySelector(".doc-btn-text");
      if (lbl) lbl.textContent = "Удалить";
    }
    return;
  }
  const pwdBtn = e.target.closest(".doc-password-btn");
  if (pwdBtn) {
    e.preventDefault();
    passwordModalType = pwdBtn.dataset.type || "pdf";
    const docId = (pwdBtn.dataset.docId || "").trim();
    openPasswordModal(pwdBtn.dataset.share, docId || null);
  }
});

let passwordModalShareToken = null;
/** PDF/PPTX satırı için pdfs.id (UUID); canvas’ta null */
let passwordModalPdfId = null;
function openPasswordModal(shareToken, pdfRowId) {
  passwordModalShareToken = shareToken;
  passwordModalPdfId = pdfRowId || null;
  const modal = document.getElementById("passwordModal");
  const input = document.getElementById("modalPasswordInput");
  const viewerWrap = document.getElementById("modalViewerPasswordWrap");
  const label = document.getElementById("modalPasswordLabel");
  const desc = document.getElementById("passwordModalDesc");
  const vIn = document.getElementById("modalViewerPasswordInput");
  if (modal && input) {
    input.value = "";
    if (vIn) vIn.value = "";
    if (viewerWrap) viewerWrap.style.display = passwordModalType === "canvas" ? "none" : "block";
    if (label) label.textContent = passwordModalType === "canvas" ? "Пароль" : "Пароль ведущего (полный доступ)";
    if (desc) {
      desc.style.display = "block";
      desc.textContent = passwordModalType === "canvas"
        ? "Только вы и те, у кого есть пароль, смогут открыть этот холст."
        : "Ведущий: рисование и управление. Зритель: только полноэкранный просмотр, без рисования.";
    }
    modal.style.display = "flex";
    input.focus();
  }
}

function closePasswordModal() {
  passwordModalShareToken = null;
  passwordModalPdfId = null;
  const modal = document.getElementById("passwordModal");
  const input = document.getElementById("modalPasswordInput");
  if (modal) modal.style.display = "none";
  if (input) input.value = "";
}

document.getElementById("modalPasswordSave")?.addEventListener("click", async () => {
  if (!passwordModalShareToken) return;
  if (passwordModalType === "canvas") {
    const pwd = document.getElementById("modalPasswordInput")?.value?.trim();
    if (!pwd) {
      alert("Введите пароль");
      return;
    }
    const ok = await setCanvasSharePassword(passwordModalShareToken, pwd);
    closePasswordModal();
    if (ok) await loadDocuments();
    else alert("Не удалось сохранить пароль");
    return;
  }
  const ed = document.getElementById("modalPasswordInput")?.value?.trim() || null;
  const vw = document.getElementById("modalViewerPasswordInput")?.value?.trim() || null;
  const res = await setPdfSharePasswords(passwordModalShareToken, ed, vw, passwordModalPdfId);
  closePasswordModal();
  if (res.ok) await loadDocuments();
  else alert(res.error || "Не удалось сохранить пароли");
});

document.getElementById("modalPasswordRemove")?.addEventListener("click", async () => {
  if (!passwordModalShareToken) return;
  const res = passwordModalType === "canvas"
    ? { ok: await setCanvasSharePassword(passwordModalShareToken, "") }
    : await setPdfSharePasswords(passwordModalShareToken, "", "", passwordModalPdfId);
  closePasswordModal();
  if (res.ok) await loadDocuments();
  else alert(res.error || "Не удалось убрать пароли");
});

document.getElementById("modalPasswordCancel")?.addEventListener("click", closePasswordModal);
document.getElementById("passwordModal")?.querySelector(".dash-modal-backdrop")?.addEventListener("click", closePasswordModal);

loadDocuments();
