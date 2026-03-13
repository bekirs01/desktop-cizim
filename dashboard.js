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
    window.history.replaceState(null, "", window.location.pathname);
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace("login.html");
  }
}

const pdfList = document.getElementById("pdfList");
const pdfEmpty = document.getElementById("pdfEmpty");
const fileInput = document.getElementById("fileInput");
const uploadZone = document.getElementById("uploadZone");
const logoutBtn = document.getElementById("logoutBtn");

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
    return;
  }
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
        <a href="index.html?id=${row.share_token}" class="btn btn-primary">Открыть PDF</a>
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

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  uploadZone.querySelector("span").textContent = "Загрузка…";
  let err = null;
  const result = await uploadPdfToSupabase(file, null, (e) => { err = e; });
  uploadZone.querySelector("span").textContent = "📤 Загрузить PDF";
  e.target.value = "";
  if (err) {
    alert("Ошибка загрузки: " + err);
    return;
  }
  if (result) await loadPdfs();
});

logoutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.replace("login.html");
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
