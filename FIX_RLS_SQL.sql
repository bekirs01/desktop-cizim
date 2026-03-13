-- RLS hatasını düzeltmek için Supabase SQL Editor'da çalıştır

DROP POLICY IF EXISTS "Users see own pdfs" ON pdfs;
CREATE POLICY "Users see own pdfs" ON pdfs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
