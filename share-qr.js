/**
 * Модалка: ссылка + QR для передачи доступа.
 */
export async function showShareLinkWithQr(link) {
  if (!link || typeof document === "undefined") return;
  document.getElementById("shareLinkQrOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "shareLinkQrOverlay";
  overlay.className = "share-link-qr-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const box = document.createElement("div");
  box.className = "share-link-qr-box";

  const h = document.createElement("h3");
  h.textContent = "Ссылка для доступа";
  box.appendChild(h);

  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = link;
  input.className = "share-link-qr-input";
  box.appendChild(input);

  const imgWrap = document.createElement("div");
  imgWrap.className = "share-link-qr-img-wrap";
  const img = document.createElement("img");
  img.alt = "QR-код";
  img.className = "share-link-qr-img";
  imgWrap.appendChild(img);
  box.appendChild(imgWrap);

  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm");
    const QR = mod.default || mod;
    img.src = await QR.toDataURL(link, { width: 220, margin: 2, errorCorrectionLevel: "M" });
  } catch (e) {
    console.warn("QR:", e);
    imgWrap.remove();
  }

  const btnRow = document.createElement("div");
  btnRow.className = "share-link-qr-btns";

  const copyAgain = document.createElement("button");
  copyAgain.type = "button";
  copyAgain.className = "btn btn-secondary";
  copyAgain.textContent = "Скопировать снова";
  copyAgain.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      copyAgain.textContent = "Скопировано";
      setTimeout(() => { copyAgain.textContent = "Скопировать снова"; }, 1500);
    } catch (_) {}
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-draw";
  closeBtn.textContent = "Закрыть";
  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  btnRow.appendChild(copyAgain);
  btnRow.appendChild(closeBtn);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}
