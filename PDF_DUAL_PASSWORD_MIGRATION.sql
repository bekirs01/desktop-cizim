-- İki şifre: öğretmen (tam erişim) + öğrenci (yalnız izleme)
-- share_password_hash = öğretmen / editör
-- share_viewer_password_hash = öğrenci / salt okunur
-- Supabase SQL Editor'da bir kez çalıştırın.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS share_viewer_password_hash TEXT;

-- Eski sürüm farklı OUT kolonları döndürüyorsa CREATE OR REPLACE kabul edilmez (42P13).
DROP FUNCTION IF EXISTS public.get_pdf_by_share_token(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_pdf_by_share_token(TEXT);

CREATE OR REPLACE FUNCTION get_pdf_by_share_token(token TEXT, pwd TEXT DEFAULT NULL)
RETURNS TABLE (storage_path TEXT, needs_password BOOLEAN, access_mode TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  pwd_hash TEXT;
  ed TEXT;
  vw TEXT;
BEGIN
  SELECT p.storage_path, p.share_password_hash, p.share_viewer_password_hash, p.user_id
  INTO rec
  FROM pdfs p
  WHERE p.share_token = token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::BOOLEAN, NULL::TEXT;
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = rec.user_id THEN
    RETURN QUERY SELECT rec.storage_path, FALSE, 'editor'::TEXT;
    RETURN;
  END IF;

  ed := NULLIF(trim(COALESCE(rec.share_password_hash, '')), '');
  vw := NULLIF(trim(COALESCE(rec.share_viewer_password_hash, '')), '');

  -- Hiç şifre yok: herkes tam erişim (eski davranış)
  IF ed IS NULL AND vw IS NULL THEN
    RETURN QUERY SELECT rec.storage_path, FALSE, 'editor'::TEXT;
    RETURN;
  END IF;

  IF pwd IS NULL OR trim(pwd) = '' THEN
    RETURN QUERY SELECT NULL::TEXT, TRUE, NULL::TEXT;
    RETURN;
  END IF;

  pwd_hash := encode(digest(trim(pwd), 'sha256'), 'hex');

  IF ed IS NOT NULL AND pwd_hash = ed THEN
    RETURN QUERY SELECT rec.storage_path, FALSE, 'editor'::TEXT;
    RETURN;
  END IF;

  IF vw IS NOT NULL AND pwd_hash = vw THEN
    RETURN QUERY SELECT rec.storage_path, FALSE, 'viewer'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::TEXT, TRUE, NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION set_pdf_share_passwords(p_token TEXT, p_editor TEXT, p_viewer TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID;
  ed_hash TEXT;
  vw_hash TEXT;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN RETURN FALSE; END IF;

  IF p_editor IS NULL OR trim(p_editor) = '' THEN ed_hash := NULL;
  ELSE ed_hash := encode(digest(trim(p_editor), 'sha256'), 'hex');
  END IF;

  IF p_viewer IS NULL OR trim(p_viewer) = '' THEN vw_hash := NULL;
  ELSE vw_hash := encode(digest(trim(p_viewer), 'sha256'), 'hex');
  END IF;

  UPDATE pdfs
  SET share_password_hash = ed_hash,
      share_viewer_password_hash = vw_hash
  WHERE share_token = p_token AND user_id = uid;
  RETURN FOUND;
END;
$$;

-- Satır id ile güncelleme (dashboard’dan gelen UUID; token eşleşmesi gerekmez)
CREATE OR REPLACE FUNCTION set_pdf_share_passwords_by_id(p_id UUID, p_editor TEXT, p_viewer TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID;
  ed_hash TEXT;
  vw_hash TEXT;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN RETURN FALSE; END IF;

  IF p_editor IS NULL OR trim(p_editor) = '' THEN ed_hash := NULL;
  ELSE ed_hash := encode(digest(trim(p_editor), 'sha256'), 'hex');
  END IF;

  IF p_viewer IS NULL OR trim(p_viewer) = '' THEN vw_hash := NULL;
  ELSE vw_hash := encode(digest(trim(p_viewer), 'sha256'), 'hex');
  END IF;

  UPDATE pdfs
  SET share_password_hash = ed_hash,
      share_viewer_password_hash = vw_hash
  WHERE id = p_id AND user_id = uid;
  RETURN FOUND;
END;
$$;

-- Eski tek-parametreli RPC: sadece öğretmen şifresini günceller (izleyici şifresine dokunmaz)
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
  IF uid IS NULL THEN RETURN FALSE; END IF;

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

-- Doğrudan .from('pdfs').update(...) ile kayıt için (RPC yoksa / yedek)
DROP POLICY IF EXISTS "pdfs_user_update" ON public.pdfs;
CREATE POLICY "pdfs_user_update" ON public.pdfs
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT EXECUTE ON FUNCTION set_pdf_share_passwords(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION set_pdf_share_passwords_by_id(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_pdf_by_share_token(TEXT, TEXT) TO anon, authenticated;
