-- Çizim belgeleri (çok sayfalı, isimli, şifreli)
-- Supabase Dashboard > SQL Editor — çalıştır

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. canvases tablosu
CREATE TABLE IF NOT EXISTS canvases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL DEFAULT 'Çizim',
  share_token TEXT UNIQUE NOT NULL,
  share_password_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE canvases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "canvases_user_all" ON canvases
  FOR ALL USING (auth.uid() = user_id);

-- 2. get_canvas_by_share_token (şifre kontrolü, PDF gibi)
CREATE OR REPLACE FUNCTION get_canvas_by_share_token(token TEXT, pwd TEXT DEFAULT NULL)
RETURNS TABLE (share_token TEXT, needs_password BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  pwd_hash TEXT;
BEGIN
  SELECT c.share_token, c.share_password_hash, c.user_id
  INTO rec
  FROM canvases c
  WHERE c.share_token = token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = rec.user_id THEN
    RETURN QUERY SELECT rec.share_token, FALSE;
    RETURN;
  END IF;

  IF rec.share_password_hash IS NULL OR rec.share_password_hash = '' THEN
    RETURN QUERY SELECT rec.share_token, FALSE;
    RETURN;
  END IF;

  IF pwd IS NULL OR pwd = '' THEN
    RETURN QUERY SELECT NULL::TEXT, TRUE;
    RETURN;
  END IF;

  pwd_hash := encode(digest(pwd, 'sha256'), 'hex');
  IF pwd_hash = rec.share_password_hash THEN
    RETURN QUERY SELECT rec.share_token, FALSE;
  ELSE
    RETURN QUERY SELECT NULL::TEXT, TRUE;
  END IF;
END;
$$;

-- 3. set_canvas_share_password
CREATE OR REPLACE FUNCTION set_canvas_share_password(token TEXT, pwd TEXT)
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
    UPDATE canvases SET share_password_hash = NULL
    WHERE share_token = token AND user_id = uid;
    RETURN FOUND;
  END IF;

  pwd_hash := encode(digest(trim(pwd), 'sha256'), 'hex');
  UPDATE canvases SET share_password_hash = pwd_hash
  WHERE share_token = token AND user_id = uid;
  RETURN FOUND;
END;
$$;
