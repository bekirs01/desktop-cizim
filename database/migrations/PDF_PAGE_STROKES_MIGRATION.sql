-- ============================================================
-- Sayfa başına 1 kayıt - Mobil + gerçek zamanlı uyumlu
-- Supabase SQL Editor'da çalıştır
-- ============================================================

-- 1. Yeni tablo: sayfa başına tek satır
CREATE TABLE IF NOT EXISTS pdf_page_strokes (
  share_token TEXT NOT NULL,
  page_num INT NOT NULL,
  strokes JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (share_token, page_num)
);

ALTER TABLE pdf_page_strokes ENABLE ROW LEVEL SECURITY;

-- RLS: Herkes okuyabilir (paylaşım linki), authenticated yazabilir
DROP POLICY IF EXISTS "Anyone can read pdf_page_strokes" ON pdf_page_strokes;
CREATE POLICY "Anyone can read pdf_page_strokes" ON pdf_page_strokes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated can insert pdf_page_strokes" ON pdf_page_strokes;
CREATE POLICY "Authenticated can insert pdf_page_strokes" ON pdf_page_strokes FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated can update pdf_page_strokes" ON pdf_page_strokes;
CREATE POLICY "Authenticated can update pdf_page_strokes" ON pdf_page_strokes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated can delete pdf_page_strokes" ON pdf_page_strokes;
CREATE POLICY "Authenticated can delete pdf_page_strokes" ON pdf_page_strokes FOR DELETE TO authenticated USING (true);

-- 2. Mevcut pdf_strokes verisini taşı (tablo varsa)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pdf_strokes') THEN
    INSERT INTO pdf_page_strokes (share_token, page_num, strokes, updated_at)
    SELECT share_token, page_num,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'points', stroke_data->'points',
            'color', COALESCE(stroke_data->>'color', '#00ff9f'),
            'lineWidth', COALESCE((stroke_data->>'lineWidth')::int, 4)
          )
          ORDER BY created_at
        ),
        '[]'::jsonb
      ),
      MAX(created_at)
    FROM pdf_strokes
    GROUP BY share_token, page_num
    ON CONFLICT (share_token, page_num) DO NOTHING;
    RAISE NOTICE 'pdf_strokes verisi taşındı';
  END IF;
END $$;

-- 3. Gerçek zamanlı: Supabase Dashboard > Database > Replication > pdf_page_strokes'i ekle

-- 4. Eski tabloyu kaldır (test sonrası manuel çalıştır)
-- DROP TABLE IF EXISTS pdf_strokes;
