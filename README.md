# Desktop Çizim (DrawFlow)

Electron + web: masaüstü üzerinde jest ile çizim, PDF/PPTX ve Supabase ile paylaşım.

## Hızlı başlangıç

```bash
npm install
npm start          # HTTP sunucu (varsayılan port 3000) — public/ kökü
npm run desktop    # Electron şeffaf overlay (public/desktop-overlay.html)
npm run web        # serve ile public/ (port 8080)
```

## Dokümantasyon

- [Genel kullanım ve özellikler](docs/README.md) (Rusça özgün README)
- [Supabase kurulumu](docs/SUPABASE_SETUP.md)
- [Railway deploy](docs/RAILWAY_DEPLOY.md)

## Klasör yapısı

| Klasör | İçerik |
|--------|--------|
| `public/` | HTML, CSS, istemci JS (tarayıcı + Electron yüklemesi) |
| `server/` | `server.js` — production HTTP sunucusu |
| `database/` | SQL: `setup/`, `migrations/`, `policies/`, `fixes/`, `schemas/` |
| `docs/` | README, kurulum ve deploy notları |
| `config/` | `serve.json` (lokal `serve` için) |
| `supabase/functions/` | Edge Functions (OTP) |
| `review-needed/` | İncelenmesi önerilen / geçici not dosyaları |

Deploy için `railway.json` ve `nixpacks.toml` proje kökünde kalır.
