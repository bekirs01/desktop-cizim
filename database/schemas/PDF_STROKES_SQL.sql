-- PDF çizimleri tablosu (Supabase SQL Editor'da çalıştır)
CREATE TABLE IF NOT EXISTS pdf_strokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token TEXT NOT NULL,
  page_num INT NOT NULL,
  stroke_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pdf_strokes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read pdf_strokes" ON pdf_strokes;
CREATE POLICY "Anyone can read pdf_strokes" ON pdf_strokes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated can insert pdf_strokes" ON pdf_strokes;
CREATE POLICY "Authenticated can insert pdf_strokes" ON pdf_strokes FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated can delete pdf_strokes" ON pdf_strokes;
CREATE POLICY "Authenticated can delete pdf_strokes" ON pdf_strokes FOR DELETE TO authenticated USING (true);
