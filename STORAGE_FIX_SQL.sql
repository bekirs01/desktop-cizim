-- Storage RLS hatasını düzelt - Supabase SQL Editor'da çalıştır

-- Eski policy'leri kaldır
DROP POLICY IF EXISTS "Allow pdfs upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated pdfs upload" ON storage.objects;

-- Yeni policy: Kullanıcı sadece kendi klasörüne yükleyebilir (path: user_id/dosya.pdf)
CREATE POLICY "Allow pdfs upload"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'pdfs'
  AND (storage.foldername(name))[1] = (auth.jwt()->>'sub')
);
