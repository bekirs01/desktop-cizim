-- Storage RLS düzeltmesi - Supabase SQL Editor'da çalıştır
-- Tüm mevcut pdfs ile ilgili policy'leri kaldır

DROP POLICY IF EXISTS "Allow pdfs upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated pdfs upload" ON storage.objects;
DROP POLICY IF EXISTS "Users upload own" ON storage.objects;
DROP POLICY IF EXISTS "Users upload own 21n71_0" ON storage.objects;

-- Basit policy: authenticated kullanıcılar pdfs bucket'a yükleyebilir
CREATE POLICY "Allow pdfs upload"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'pdfs');
