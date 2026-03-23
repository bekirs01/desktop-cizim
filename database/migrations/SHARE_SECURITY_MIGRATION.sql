-- Безопасные ссылки: edit_key для совместного рисования
-- Supabase Dashboard > SQL Editor — выполнить

-- 1. Добавить edit_key (секретный ключ для рисования)
ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS edit_key TEXT;

-- 2. Обновить RPC: проверка ключа, возврат can_edit
CREATE OR REPLACE FUNCTION get_pdf_by_share_token(token TEXT, key TEXT DEFAULT NULL)
RETURNS TABLE (storage_path TEXT, can_edit BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT p.storage_path,
    (p.edit_key IS NULL OR p.edit_key = key OR auth.uid() = p.user_id)
  FROM pdfs p
  WHERE p.share_token = token
  LIMIT 1;
$$;

-- 3. Владелец может получить полную ссылку с ключом (только для своих PDF)
CREATE OR REPLACE FUNCTION get_pdf_edit_link(token TEXT)
RETURNS TABLE (result TEXT)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT (p.share_token || '|' || p.edit_key)::TEXT
  FROM pdfs p
  WHERE p.share_token = token AND auth.uid() = p.user_id AND p.edit_key IS NOT NULL
  LIMIT 1;
$$;
