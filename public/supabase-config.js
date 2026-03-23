/**
 * Supabase yapılandırması
 * Supabase Dashboard > Project Settings > API'den al
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** Arkadaşların açabileceği public URL. Deploy sonrası kullanılır. */
export const SITE_URL = "https://desktop-cizim-production.up.railway.app";

export const SUPABASE_URL = "https://jtnwvkjtiijhebsqucqe.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0bnd2a2p0aWlqaGVic3F1Y3FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MjczNzIsImV4cCI6MjA4OTAwMzM3Mn0.msQYIAqQZG8tdDqCRGgxSXmxma34MSldbQYiRlbl0UY";

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/** Paylaşım linki base URL — localStorage > SITE_URL > window.origin */
export function getShareBaseUrl() {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("shareBaseUrl");
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, "");
    if (typeof SITE_URL === "string" && SITE_URL) return SITE_URL.replace(/\/$/, "");
    return window.location.origin;
  }
  return (typeof SITE_URL === "string" && SITE_URL) ? SITE_URL.replace(/\/$/, "") : "";
}
