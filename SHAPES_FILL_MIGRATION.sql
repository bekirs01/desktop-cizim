-- Shapes ve fill_shapes sütunları - metin, şekiller ve zemin doldurma için
-- Supabase SQL Editor'da çalıştır

ALTER TABLE pdf_page_strokes
  ADD COLUMN IF NOT EXISTS shapes JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS fill_shapes JSONB DEFAULT '[]';
