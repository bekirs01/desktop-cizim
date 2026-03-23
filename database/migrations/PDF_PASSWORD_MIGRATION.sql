-- PDF şifre koruması
-- Her PDF'e opsiyonel şifre eklenebilir. Link paylaşıldığında sadece şifreyi bilenler açabilir.
-- Supabase Dashboard > SQL Editor — bu dosyayı çalıştır (bir kez yeterli)

-- 1. share_password_hash sütunu ekle (SHA256 hash, hex)
ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS share_password_hash TEXT;

-- 2. pgcrypto extension (SHA256 için)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 3. get_pdf_by_share_token: şifre kontrolü
-- Döner: storage_path, needs_password
-- needs_password=true: PDF var ama şifre yanlış/eksik — modal göster
-- storage_path dolu: başarılı
CREATE OR REPLACE FUNCTION get_pdf_by_share_token(token TEXT, pwd TEXT DEFAULT NULL)
RETURNS TABLE (storage_path TEXT, needs_password BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  pwd_hash TEXT;
BEGIN
  SELECT p.storage_path, p.share_password_hash, p.user_id
  INTO rec
  FROM pdfs p
  WHERE p.share_token = token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  -- Sahibi her zaman açabilir (giriş yapmış)
  IF auth.uid() IS NOT NULL AND auth.uid() = rec.user_id THEN
    RETURN QUERY SELECT rec.storage_path, FALSE;
    RETURN;
  END IF;

  -- Şifre yoksa herkes açabilir
  IF rec.share_password_hash IS NULL OR rec.share_password_hash = '' THEN
    RETURN QUERY SELECT rec.storage_path, FALSE;
    RETURN;
  END IF;

  -- Şifre var: kontrol et
  IF pwd IS NULL OR pwd = '' THEN
    RETURN QUERY SELECT NULL::TEXT, TRUE;
    RETURN;
  END IF;

  pwd_hash := encode(digest(pwd, 'sha256'), 'hex');
  IF pwd_hash = rec.share_password_hash THEN
    RETURN QUERY SELECT rec.storage_path, FALSE;
  ELSE
    RETURN QUERY SELECT NULL::TEXT, TRUE;
  END IF;
END;
$$;

-- 4. Şifre ayarlama RPC (sadece sahip)
CREATE OR REPLACE FUNCTION set_pdf_share_password(token TEXT, pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  uid UUID;
  pwd_hash TEXT;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RETURN FALSE;
  END IF;

  IF pwd IS NULL OR trim(pwd) = '' THEN
    UPDATE pdfs SET share_password_hash = NULL
    WHERE share_token = token AND user_id = uid;
    RETURN FOUND;
  END IF;

  pwd_hash := encode(digest(trim(pwd), 'sha256'), 'hex');
  UPDATE pdfs SET share_password_hash = pwd_hash
  WHERE share_token = token AND user_id = uid;
  RETURN FOUND;
END;
$$;
