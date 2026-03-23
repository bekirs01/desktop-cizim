-- ============================================================
-- Supabase Tam Kurulum - Yükleme/Kamera/PDF için
-- Supabase Dashboard > SQL Editor'da çalıştır
-- ============================================================

-- 1. pdfs tablosu: Kullanıcı kendi PDF'lerini görebilmeli
DROP POLICY IF EXISTS "Users see own pdfs" ON public.pdfs;
CREATE POLICY "Users see own pdfs" ON public.pdfs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "pdfs_user_insert" ON public.pdfs;
CREATE POLICY "pdfs_user_insert" ON public.pdfs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "pdfs_user_delete" ON public.pdfs;
CREATE POLICY "pdfs_user_delete" ON public.pdfs
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "pdfs_user_update" ON public.pdfs;
CREATE POLICY "pdfs_user_update" ON public.pdfs
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 2. Storage pdfs bucket: Yükleme için (SUPABASE_STORAGE_RLS_FIX.sql'deki gibi)
-- Eğer storage hatası alıyorsan SUPABASE_STORAGE_RLS_FIX.sql dosyasını da çalıştır
