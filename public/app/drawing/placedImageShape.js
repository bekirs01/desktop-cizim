/** Событие после загрузки Image для перерисовки холста */
export const PLACED_IMAGE_READY_EVENT = "placedImageReady";

export function getPlacedImageSrc(sh) {
  if (!sh?.data) return "";
  if (typeof sh.data === "string" && sh.data.startsWith("data:")) return sh.data;
  const mime = sh.mime || "image/png";
  return `data:${mime};base64,${sh.data}`;
}

/**
 * Рисует вставленное изображение (норм. коорд. x,y,w,h).
 * @param {(x:number)=>number} sx — как на холсте (зеркало и т.д.)
 */
export function drawPlacedImageShape(ctx, sh, w, h, sx) {
  if (sh.type !== "image" || !sh.data) return;
  if (!sh._img) {
    const img = new Image();
    sh._img = img;
    img.onload = () => {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PLACED_IMAGE_READY_EVENT));
    };
    img.onerror = () => {
      sh._img = null;
    };
    img.src = getPlacedImageSrc(sh);
    return;
  }
  if (!sh._img.complete || sh._img.naturalWidth === 0) return;
  const x0 = sh.x;
  const x1 = sh.x + sh.w;
  const dx = Math.min(sx(x0), sx(x1));
  const dy = sh.y * h;
  const dw = Math.max(1, Math.abs(sx(x1) - sx(x0)));
  const dh = Math.max(1, sh.h * h);
  ctx.save();
  ctx.globalAlpha = sh.opacity ?? 1;
  try {
    ctx.drawImage(sh._img, dx, dy, dw, dh);
  } catch (_) {
    /* ignore */
  }
  ctx.restore();
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * @returns {Promise<{ type: 'image', x: number, y: number, w: number, h: number, data: string, mime: string }>}
 */
export async function fileToPlacedImageShape(file, options = {}) {
  if (!file) throw new Error("Нужен файл изображения");
  const maxSide = options.maxSide ?? 1600;
  const maxNormW = options.maxNormW ?? 0.55;
  const maxNormH = options.maxNormH ?? 0.55;
  const objectUrl = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImageFromDataUrl(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  let iw = img.naturalWidth;
  let ih = img.naturalHeight;
  if (!iw || !ih) throw new Error("bad image");
  let outUrl = "";
  if (Math.max(iw, ih) > maxSide) {
    const sc = maxSide / Math.max(iw, ih);
    iw = Math.round(iw * sc);
    ih = Math.round(ih * sc);
    const c = document.createElement("canvas");
    c.width = iw;
    c.height = ih;
    c.getContext("2d").drawImage(img, 0, 0, iw, ih);
    outUrl = c.toDataURL("image/png");
    img = await loadImageFromDataUrl(outUrl);
    iw = img.naturalWidth;
    ih = img.naturalHeight;
  } else {
    const c0 = document.createElement("canvas");
    c0.width = iw;
    c0.height = ih;
    c0.getContext("2d").drawImage(img, 0, 0);
    outUrl = c0.toDataURL("image/png");
  }
  const aspect = iw / ih;
  const refW = 920;
  const refH = 520;
  let normW = (iw / refW) * 0.35;
  let normH = normW / aspect;
  if (normW > maxNormW) {
    normW = maxNormW;
    normH = normW / aspect;
  }
  if (normH > maxNormH) {
    normH = maxNormH;
    normW = normH * aspect;
  }
  normW = Math.max(0.06, Math.min(maxNormW, normW));
  normH = Math.max(0.06, Math.min(maxNormH, normH));
  const x = Math.max(0, Math.min(1 - normW, 0.5 - normW / 2));
  const y = Math.max(0, Math.min(1 - normH, 0.45 - normH / 2));
  const comma = outUrl.indexOf(",");
  const payload = comma >= 0 ? outUrl.slice(comma + 1) : outUrl;
  const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
  return {
    type: "image",
    x,
    y,
    w: normW,
    h: normH,
    data: payload,
    mime,
    opacity: 1,
  };
}
