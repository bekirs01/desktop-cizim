/**
 * Dashboard - PDF listesi ve yükleme
 */
import { supabase } from "./supabase-config.js";
import { uploadPdfToSupabase, deletePdfFromSupabase } from "./supabase-pdf.js";

if (!supabase) {
  document.body.innerHTML = '<div class="dashboard-page"><p style="color:var(--error)">Supabase не настроен.</p></div>';
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

// shareUrl query param ile otomatik kaydet (npm run share sonrası)
const urlParams = new URLSearchParams(window.location.search);
const shareUrlParam = urlParams.get("shareUrl");
if (shareUrlParam && shareUrlParam.startsWith("http")) {
  localStorage.setItem("shareBaseUrl", shareUrlParam.replace(/\/$/, ""));
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}
// Tünel URL'inden açıldıysa (localhost değilse) otomatik kaydet
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

// Kamera bölümü - aç/kapa ve iframe yükle
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

async function loadPdfs() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from("pdfs")
    .select("id, file_name, share_token, storage_path, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("PDF listesi alınamadı:", error);
    showUploadError("Не удалось загрузить список: " + (error.message || "ошибка"));
    return;
  }
  showUploadError("");
  pdfList.innerHTML = "";
  if (!data?.length) {
    pdfEmpty.style.display = "block";
    return;
  }
  pdfEmpty.style.display = "none";
  for (const row of data) {
    const div = document.createElement("div");
    div.className = "pdf-item";
    const date = row.created_at ? new Date(row.created_at).toLocaleDateString("tr-TR") : "";
    div.innerHTML = `
      <div class="pdf-item-info">
        <div class="pdf-item-name">${escapeHtml(row.file_name || "PDF")}</div>
        <div class="pdf-item-meta">${date}</div>
      </div>
      <div class="pdf-item-actions">
        <a href="/index.html?id=${row.share_token}" class="btn btn-primary">Открыть PDF</a>
        <button type="button" class="btn btn-danger pdf-delete-btn" data-id="${row.id}" data-share="${row.share_token}" data-path="${escapeHtml(row.storage_path || "")}" title="Удалить">🗑️ Удалить</button>
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
  showUploadError("");
  uploadZone.querySelector("span").textContent = "Загрузка…";
  let err = null;
  try {
    const result = await uploadPdfToSupabase(file, null, (e) => { err = e; });
    uploadZone.querySelector("span").textContent = "📤 Загрузить PDF";
    e.target.value = "";
    if (err) {
      showUploadError("Ошибка загрузки: " + err);
      return;
    }
    if (result) await loadPdfs();
  } catch (ex) {
    uploadZone.querySelector("span").textContent = "📤 Загрузить PDF";
    e.target.value = "";
    showUploadError("Ошибка: " + (ex?.message || ex));
  }
});

logoutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.replace("/login.html");
});

pdfList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".pdf-delete-btn");
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.id;
  const share_token = btn.dataset.share;
  const storage_path = btn.dataset.path;
  if (!id || !share_token) return;
  if (!confirm("Удалить этот PDF и все рисунки навсегда?")) return;
  btn.disabled = true;
  btn.textContent = "…";
  const ok = await deletePdfFromSupabase({ id, share_token, storage_path }, (err) => alert(err));
  if (ok) await loadPdfs();
  else { btn.disabled = false; btn.textContent = "🗑️ Sil"; }
});

loadPdfs();
