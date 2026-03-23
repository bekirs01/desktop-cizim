/**
 * Страница справки: авторизация и встроенная демо-камера.
 */
import { supabase } from "./supabase-config.js";

if (!supabase) {
  document.body.innerHTML =
    '<div class="dash-app" style="padding:3rem;text-align:center;color:var(--dash-red,#ff6b6b)">Supabase не настроен.</div>';
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
    const r = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace("/login.html?redirect=" + r);
  }
}

const iframe = document.getElementById("helpCameraIframe");

function stopDemoCamera() {
  try {
    iframe?.contentWindow?.postMessage({ type: "camera-section-collapsed" }, "*");
  } catch (_) {}
}

window.addEventListener("beforeunload", stopDemoCamera);
window.addEventListener("pagehide", stopDemoCamera);

requestAnimationFrame(() => {
  if (iframe) iframe.src = "/index.html?mode=camera&embed=1&hands=both";
});
