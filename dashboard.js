/**
 * Dashboard - PDF ve çizim belgeleri
 */
import { supabase } from "./supabase-config.js";
import { uploadPdfToSupabase, deletePdfFromSupabase, setPdfSharePassword } from "./supabase-pdf.js";
import { createCanvas, deleteCanvas, listCanvases, setCanvasSharePassword } from "./supabase-canvas.js";

if (!supabase) {
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
  }
}

const pdfList = document.getElementById("pdfList");
const pdfEmpty = document.getElementById("pdfEmpty");
const pdfCount = document.getElementById("pdfCount");
const uploadError = document.getElementById("uploadError");
const fileInput = document.getElementById("fileInput");
const uploadZone = document.getElementById("uploadZone");
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
    alert("Сохранено. Теперь скопированные ссылки будут использовать этот URL.");
  } else {
    localStorage.removeItem("shareBaseUrl");
    alert("Сброшено. Будут использоваться текущий адрес (localhost).");
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
    alert("Вставьте ссылку на PDF или общий холст (например: ...index.html?id=xxx или ...index.html?canvas=xxx)");
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
    alert("Ошибка создания документа");
  }
});

document.getElementById("newCanvasCancelBtn")?.addEventListener("click", () => {
  document.getElementById("newCanvasModal").style.display = "none";
});
document.getElementById("newCanvasModal")?.querySelector(".dash-modal-backdrop")?.addEventListener("click", () => {
  document.getElementById("newCanvasModal").style.display = "none";
});

const cameraSection = document.getElementById("cameraSection");
const cameraSectionToggle = document.getElementById("cameraSectionToggle");
const cameraIframe = document.getElementById("cameraIframe");
if (cameraSection && cameraSectionToggle && cameraIframe) {
  cameraSectionToggle.addEventListener("click", () => {
    const expanded = cameraSection.classList.toggle("expanded");
    if (expanded && cameraIframe.src === "about:blank") {
      cameraIframe.src = "/index.html?mode=camera&embed=1";
    } else if (!expanded) {
      cameraIframe.contentWindow?.postMessage({ type: "camera-section-collapsed" }, "*");
    }
  });
}

let passwordModalType = "pdf";

async function loadDocuments() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const [pdfRes, canvases] = await Promise.all([
    supabase.from("pdfs").select("id, file_name, share_token, storage_path, created_at, share_password_hash").eq("user_id", user.id).order("created_at", { ascending: false }),
    listCanvases(),
  ]);
  const pdfError = pdfRes.error;
  const pdfData = pdfRes.data || [];
  if (pdfError) {
    showUploadError("Не удалось загрузить список: " + (pdfError.message || "ошибка"));
    return;
  }
  showUploadError("");
  const items = [
    ...pdfData.map((r) => {
      const fn = r.file_name || r.storage_path || "";
      const isPptx = fn.toLowerCase().endsWith(".pptx");
      return { ...r, type: isPptx ? "pptx" : "pdf", name: r.file_name || (isPptx ? "Презентация" : "PDF"), date: r.created_at };
    }),
    ...canvases.map((r) => ({ ...r, type: "canvas", name: r.name || "Çizim", date: r.created_at, share_password_hash: r.share_password_hash })),
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
    const date = row.date ? new Date(row.date).toLocaleDateString("tr-TR") : "";
    const hasPwd = !!(row.share_password_hash);
    const icon = row.type === "pdf" ? "&#x1F4C4;" : row.type === "pptx" ? "&#x1F4FA;" : "&#x270F;&#xFE0F;";
    const openHref = (row.type === "pdf" || row.type === "pptx") ? `/index.html?id=${row.share_token}` : `/index.html?canvas=${row.share_token}`;
    const deleteData = (row.type === "pdf" || row.type === "pptx")
      ? `data-id="${row.id}" data-share="${row.share_token}" data-path="${escapeHtml(row.storage_path || "")}" data-type="pdf"`
      : `data-id="${row.id}" data-share="${row.share_token}" data-type="canvas"`;
    div.innerHTML = `
      <div class="dash-pdf-icon">${icon}</div>
      <div class="dash-pdf-info">
        <div class="dash-pdf-name">${escapeHtml(row.name)}</div>
        <div class="dash-pdf-meta">${date}${hasPwd ? ' &#x1F512;' : ''}</div>
      </div>
      <div class="dash-pdf-actions">
        <a href="${openHref}" class="dash-btn dash-btn-primary" style="font-size:0.8rem;padding:0.5rem 1rem;">Открыть</a>
        <button type="button" class="dash-btn dash-btn-ghost doc-password-btn" style="font-size:0.8rem;padding:0.5rem 0.8rem;" data-share="${row.share_token}" data-type="${row.type}" title="${hasPwd ? 'Изменить пароль' : 'Добавить пароль'}">&#x1F512;</button>
        <button type="button" class="dash-btn dash-btn-danger-ghost doc-delete-btn" style="font-size:0.8rem;padding:0.5rem 0.8rem;" ${deleteData} title="Удалить">Удалить</button>
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

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const ext = (file.name || "").split(".").pop()?.toLowerCase();
  if (ext !== "pdf" && ext !== "pptx") {
    showUploadError("Поддерживаются только PDF и PPTX");
    e.target.value = "";
    return;
  }
  showUploadError("");
  const sharePassword = document.getElementById("uploadPasswordInput")?.value?.trim() || null;
  const btnSpan = uploadZone.querySelector("button span");
  const btnText = uploadZone.querySelector("button");
  if (btnText) btnText.style.opacity = "0.6";
  if (btnSpan) btnSpan.textContent = "...";
  let err = null;
  try {
    const result = await uploadPdfToSupabase(file, null, (e) => { err = e; }, sharePassword);
    if (btnText) btnText.style.opacity = "1";
    if (btnSpan) btnSpan.textContent = "+";
    e.target.value = "";
    if (err) {
      showUploadError("Ошибка загрузки: " + err);
      return;
    }
    if (result) await loadDocuments();
  } catch (ex) {
    if (btnText) btnText.style.opacity = "1";
    if (btnSpan) btnSpan.textContent = "+";
    e.target.value = "";
    showUploadError("Ошибка: " + (ex?.message || ex));
  }
});

logoutBtn.addEventListener("click", async () => {
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
    if (!confirm((type === "pdf" || type === "pptx") ? "Удалить этот документ и все рисунки навсегда?" : "Удалить этот документ и все рисунки навсегда?")) return;
    delBtn.disabled = true;
    delBtn.textContent = "...";
    let ok = false;
    if (type === "pdf" || type === "pptx") {
      ok = await deletePdfFromSupabase({ id, share_token, storage_path: delBtn.dataset.path || "" }, (err) => alert(err));
    } else {
      ok = await deleteCanvas({ id, share_token });
    }
    if (ok) await loadDocuments();
    else { delBtn.disabled = false; delBtn.textContent = "Удалить"; }
    return;
  }
  const pwdBtn = e.target.closest(".doc-password-btn");
  if (pwdBtn) {
    e.preventDefault();
    passwordModalType = pwdBtn.dataset.type || "pdf";
    openPasswordModal(pwdBtn.dataset.share);
  }
});

let passwordModalShareToken = null;
function openPasswordModal(shareToken) {
  passwordModalShareToken = shareToken;
  const modal = document.getElementById("passwordModal");
  const input = document.getElementById("modalPasswordInput");
  if (modal && input) {
    input.value = "";
    modal.style.display = "flex";
    input.focus();
  }
}

function closePasswordModal() {
  passwordModalShareToken = null;
  const modal = document.getElementById("passwordModal");
  const input = document.getElementById("modalPasswordInput");
  if (modal) modal.style.display = "none";
  if (input) input.value = "";
}

document.getElementById("modalPasswordSave")?.addEventListener("click", async () => {
  const pwd = document.getElementById("modalPasswordInput")?.value?.trim();
  if (!passwordModalShareToken) return;
  if (!pwd) {
    alert("Введите пароль");
    return;
  }
  const ok = passwordModalType === "canvas"
    ? await setCanvasSharePassword(passwordModalShareToken, pwd)
    : await setPdfSharePassword(passwordModalShareToken, pwd);
  closePasswordModal();
  if (ok) await loadDocuments();
  else alert("Ошибка сохранения пароля");
});

document.getElementById("modalPasswordRemove")?.addEventListener("click", async () => {
  if (!passwordModalShareToken) return;
  const ok = passwordModalType === "canvas"
    ? await setCanvasSharePassword(passwordModalShareToken, "")
    : await setPdfSharePassword(passwordModalShareToken, "");
  closePasswordModal();
  if (ok) await loadDocuments();
  else alert("Ошибка удаления пароля");
});

document.getElementById("modalPasswordCancel")?.addEventListener("click", closePasswordModal);
document.getElementById("passwordModal")?.querySelector(".dash-modal-backdrop")?.addEventListener("click", closePasswordModal);

loadDocuments();
