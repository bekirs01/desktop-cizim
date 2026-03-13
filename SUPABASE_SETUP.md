# Supabase Kurulum Rehberi

## 1. Supabase Projesi Oluşturma

1. https://supabase.com/dashboard adresine git
2. "+ New project" butonuna tıkla
3. Proje adı ver (örn: `drawing-app`)
4. Database şifresi belirle
5. Region seç (örn: `eu-central-1`)
6. "Create new project" tıkla

## 2. SQL Tabloları Oluşturma

Supabase Dashboard → SQL Editor → "New query" ile aşağıdaki SQL'i çalıştır:

```sql
-- PDF'ler tablosu (kullanıcıların yüklediği PDF'ler)
CREATE TABLE IF NOT EXISTS pdfs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  share_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS (Row Level Security) aktif et
ALTER TABLE pdfs ENABLE ROW LEVEL SECURITY;

-- Sadece kendi PDF'lerini görebilir
CREATE POLICY "Users see own pdfs" ON pdfs
  FOR ALL USING (auth.uid() = user_id);

-- PDF çizimleri (anlık kayıt)
CREATE TABLE IF NOT EXISTS pdf_strokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token TEXT NOT NULL,
  page_num INT NOT NULL,
  stroke_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pdf_strokes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read pdf_strokes" ON pdf_strokes FOR SELECT USING (true);
CREATE POLICY "Authenticated can insert pdf_strokes" ON pdf_strokes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can delete pdf_strokes" ON pdf_strokes FOR DELETE TO authenticated USING (true);

-- Paylaşım linki için RPC (anon kullanıcılar share_token ile storage_path alabilir)
CREATE OR REPLACE FUNCTION get_pdf_by_share_token(token TEXT)
RETURNS TABLE (storage_path TEXT)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT pdfs.storage_path FROM pdfs WHERE share_token = token LIMIT 1;
$$;
```

## 3. Storage Bucket

1. Storage → "New bucket"
2. Name: `pdfs`
3. Public bucket: **Açık** (paylaşım linkleri için view.html çalışsın)
4. "Create bucket" tıkla

### Storage RLS Policy (SQL ile - zorunlu)

SQL Editor'da çalıştır:

```sql
DROP POLICY IF EXISTS "Allow pdfs upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated pdfs upload" ON storage.objects;

CREATE POLICY "Allow pdfs upload"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'pdfs');
```

## 4. API Keys

1. Project Settings → API
2. **Project URL** ve **anon public** key'i kopyala
3. `supabase-config.js` dosyasına yapıştır
