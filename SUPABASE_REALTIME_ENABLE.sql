-- ============================================================
-- Gerçek zamanlı senkronizasyon için - Supabase SQL Editor'da çalıştır
-- Bu sayede bir kullanıcı çizim yaptığında diğeri ANLIK görür (sayfa yenilemeden)
-- ============================================================

-- pdf_page_strokes tablosunu Realtime yayınına ekle (anlık senkron için)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'pdf_page_strokes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pdf_page_strokes;
    RAISE NOTICE 'Realtime eklendi - artık çizimler anlık senkron olacak';
  ELSE
    RAISE NOTICE 'Realtime zaten aktif';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Hata (tablo zaten ekli olabilir): %', SQLERRM;
END $$;
