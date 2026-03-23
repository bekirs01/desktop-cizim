-- ============================================================
-- Supabase Storage RLS Hatası - Tam Çözüm
-- Bu dosyayı Supabase Dashboard > SQL Editor'da çalıştır
-- ============================================================

-- 1. storage.objects üzerindeki TÜM policy'leri kaldır (isim fark etmez)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
    RAISE NOTICE 'Dropped policy: %', r.policyname;
  END LOOP;
END $$;

-- 2. pdfs bucket için tek INSERT policy (path: user_id/dosya.pdf)
CREATE POLICY "pdfs_authenticated_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);

-- 3. upsert için SELECT policy (aynı dosyayı kontrol etmek için)
CREATE POLICY "pdfs_authenticated_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);

-- 4. upsert için UPDATE policy (üzerine yazma için)
CREATE POLICY "pdfs_authenticated_update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
)
WITH CHECK (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);

-- 4b. Silme için DELETE policy (dashboard'dan PDF silme)
CREATE POLICY "pdfs_authenticated_delete"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);

-- 5. public.pdfs tablosu RLS kontrolü (veritabanı kaydı için)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pdfs' AND policyname = 'pdfs_user_insert') THEN
    CREATE POLICY "pdfs_user_insert" ON public.pdfs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
    RAISE NOTICE 'Created pdfs_user_insert';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pdfs' AND policyname = 'pdfs_user_delete') THEN
    CREATE POLICY "pdfs_user_delete" ON public.pdfs FOR DELETE TO authenticated USING (auth.uid() = user_id);
    RAISE NOTICE 'Created pdfs_user_delete';
  END IF;
END $$;
