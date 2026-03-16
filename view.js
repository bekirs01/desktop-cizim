/**
 * Paylaşım linkiyle PDF görüntüleme (view.html?id=SHARE_TOKEN)
 */
import { supabase } from "./supabase-config.js";
import { fetchStrokesLegacy, subscribeStrokes } from "./supabase-strokes.js";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.mjs";

const viewError = document.getElementById("viewError");
const viewLoading = document.getElementById("viewLoading");
const viewContent = document.getElementById("viewContent");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const pageInfo = document.getElementById("pageInfo");
const pdfWrap = document.getElementById("pdfWrap");
const pdfCanvas = document.getElementById("pdfCanvas");
const drawCanvas = document.getElementById("drawCanvas");

function showError(msg) {
  viewLoading.style.display = "none";
  viewContent.style.display = "none";
  viewError.style.display = "block";
  viewError.textContent = msg;
}

function hideLoading() {
  viewLoading.style.display = "none";
  viewContent.style.display = "block";
}

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let allStrokes = [];

function drawStrokesToCanvas(w, h) {
  if (!drawCanvas) return;
  const dctx = drawCanvas.getContext("2d");
  dctx.clearRect(0, 0, w, h);
  const pageStrokes = allStrokes.filter((r) => r.page_num === currentPage);
  for (const row of pageStrokes) {
    const sd = row.stroke_data || {};
    const pts = sd.points || [];
    if (pts.length < 2) continue;
    dctx.strokeStyle = sd.color || "#00ff9f";
    dctx.lineWidth = sd.lineWidth ?? 4;
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    dctx.beginPath();
    dctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      dctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    dctx.stroke();
  }
}

/** pdf_page_strokes formatından legacy formatına dönüştür */
function legacyFromStrokes(pageNum, strokes) {
  if (!strokes || !Array.isArray(strokes)) return [];
  return strokes.map((s) => ({ page_num: pageNum, stroke_data: s }));
}

async function renderPage() {
  if (!pdfDoc || !pdfCanvas) return;
  const page = await pdfDoc.getPage(currentPage);
  const ctx = pdfCanvas.getContext("2d");
  const defaultVp = page.getViewport({ scale: 1 });
  const scale = Math.min(2, (pdfWrap.clientWidth - 32) / defaultVp.width);
  const viewport = page.getViewport({ scale });
  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  if (drawCanvas) {
    drawCanvas.width = viewport.width;
    drawCanvas.height = viewport.height;
  }
  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;
  drawStrokesToCanvas(viewport.width, viewport.height);
  pageInfo.textContent = `${currentPage} / ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

(async () => {
  const params = new URLSearchParams(window.location.search);
  const shareId = params.get("id");
  if (!shareId) {
    showError("Geçersiz paylaşım linki. Örnek: view.html?id=abc12345");
    return;
  }

  if (!supabase) {
    showError("Supabase yapılandırılmamış. supabase-config.js içinde URL ve KEY girin.");
    return;
  }

  try {
    const { data, error } = await supabase.rpc("get_pdf_by_share_token", { token: shareId });
    if (error) {
      showError("PDF bulunamadı: " + (error.message || "Bilinmeyen hata"));
      return;
    }
    const path = data?.[0]?.storage_path;
    if (!path) {
      showError("PDF bulunamadı.");
      return;
    }

    const { data: urlData } = supabase.storage.from("pdfs").getPublicUrl(path);
    const pdfUrl = urlData?.publicUrl;
    if (!pdfUrl) {
      showError("PDF URL'si alınamadı.");
      return;
    }

    pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
    totalPages = pdfDoc.numPages;
    currentPage = 1;
    allStrokes = (await fetchStrokesLegacy(shareId)) || [];

    // Mobil uygulama çizimlerini anında göster
    subscribeStrokes(shareId, (payload) => {
      if (payload?.type === "progress") {
        const { pageNum, stroke } = payload;
        if (pageNum != null && stroke?.points?.length >= 2) {
          const progress = legacyFromStrokes(pageNum, [stroke]);
          const others = allStrokes.filter((r) => r.page_num !== pageNum);
          allStrokes = [...others, ...progress];
          if (currentPage === pageNum) drawStrokesToCanvas(drawCanvas?.width || 0, drawCanvas?.height || 0);
        }
      } else if (payload?.new?.strokes) {
        const pageNum = payload.new.page_num;
        const strokes = payload.new.strokes || [];
        const others = allStrokes.filter((r) => r.page_num !== pageNum);
        allStrokes = [...others, ...legacyFromStrokes(pageNum, strokes)];
        if (currentPage === pageNum) drawStrokesToCanvas(drawCanvas?.width || 0, drawCanvas?.height || 0);
      } else if (payload?.eventType === "UPDATE" || payload?.eventType === "INSERT") {
        fetchStrokesLegacy(shareId).then((fresh) => {
          allStrokes = fresh || [];
          drawStrokesToCanvas(drawCanvas?.width || 0, drawCanvas?.height || 0);
        });
      }
    });

    hideLoading();
    await renderPage();

    prevBtn?.addEventListener("click", async () => {
      if (currentPage <= 1) return;
      currentPage--;
      await renderPage();
    });
    nextBtn?.addEventListener("click", async () => {
      if (currentPage >= totalPages) return;
      currentPage++;
      await renderPage();
    });
  } catch (err) {
    showError("Yükleme hatası: " + (err.message || "Bilinmeyen hata"));
  }
})();
