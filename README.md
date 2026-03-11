# Canlı Hareket Takip Sistemi

Masaüstünde el hareketi ile çizim yapabileceğiniz Electron uygulaması.

## Kurulum

```bash
npm install
```

## Çalıştırma

### Electron (Masaüstü Uygulaması)
```bash
npm start
```
Tam ekran şeffaf pencere açılır. Kapatmak için: **Cmd+Shift+Q** (Mac) veya **Ctrl+Shift+Q** (Windows)

### Web (Tarayıcıda)
```bash
npm run web
```
Ardından tarayıcıda **http://localhost:8080** adresine gidin ve `desktop-overlay.html` dosyasını açın.

**Not:** Dosyayı doğrudan açmak (file://) çalışmaz. Mutlaka HTTP sunucusu kullanın.

## Özellikler

- ✅ Gerçek kamera akışı
- ✅ MediaPipe Hands 21 landmark (tüm parmak boğumları ve uçları)
- ✅ Pose iskelet çizimi
- ✅ Face Mesh göz konturu
- ✅ İşaret parmağı ile çizim modu
- ✅ Hareket algılama (Türkçe + Rusça)
- ✅ Sanal nesneleri tutup taşıma

## Kullanım

1. **Kamerayı Başlat** – Kamera izni verin
2. **Çizim Modu** – İşaret parmağınızı kameraya doğrultup hareket ettirin
3. **Çizimi Sil** – Tüm çizimleri temizler
4. Nesneleri 3 parmağınızı birleştirerek tutup taşıyabilirsiniz
