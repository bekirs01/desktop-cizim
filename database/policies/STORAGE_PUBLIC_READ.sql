-- Публичное чтение PDF для совместной работы по ссылке
-- Supabase Dashboard > SQL Editor — выполнить

CREATE POLICY "pdfs_public_read"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'pdfs');
