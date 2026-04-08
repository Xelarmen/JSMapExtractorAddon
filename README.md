# 🗺️ MapXtractor — Chrome Extension

> **One-click source map detection & source code extraction, right in your browser.**

A Chrome extension for security researchers and bug bounty hunters. Scans every JS and CSS file on the current page for exposed source maps, extracts original source code, and lets you download everything — individual files or a full ZIP — without leaving the browser.

---

## ✨ Features

- 🔍 **Auto-detect** — scans all `<script src>` and `<link rel="stylesheet">` assets on the active tab
- ✅ / ❌ **Visual status** — instant ✅ / ❌ per file, no guessing
- 🗺️ **Multi-strategy detection** — checks `SourceMap` / `X-SourceMap` HTTP headers, `//# sourceMappingURL` comments, fallback `.map` suffix
- 📂 **Source extraction** — parses `sourcesContent` from the map JSON, reconstructs original file tree
- 🟨🔷⚛️ **File-type icons** — JS, TS, JSX, TSX, Vue, CSS, SCSS and more
- 📦 **ZIP download** — bundle all extracted sources into a single `.zip` with one click
- ⬇️ **Selective download** — download the raw `.map` file or individual source files
- 📊 **Live stats bar** — total assets / maps found / maps missing / total source files
- 🔄 **Re-scan** — run again after navigating or triggering lazy-loaded assets

---

## 🖼️ Interface

```
┌─────────────────────────────────────────────────────────────┐
│ 🗺️ MapXtractor                                   [🔍 Tara]  │
├─────────────────────────────────────────────────────────────┤
│ Toplam: 5  Map: 2  Yok: 3  Kaynak: 47   [⬇ Map'leri İndir] │
├─────────────────────────────────────────────────────────────┤
│ [JS]  main.abc123.js              ✅  [⬇ Map] [📦 Çıkart]  │
│       https://…/main.abc123.js.map                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 📂 47 kaynak                       [⬇ ZIP indir]    │   │
│  │ ⚛️  src/App.tsx                    1.2 KB  [⬇]      │   │
│  │ 🔷  src/api/client.ts              3.4 KB  [⬇]      │   │
│  │ 🟨  src/utils/helpers.js           800 B   [⬇]      │   │
│  │ …                                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│ [CSS] styles.chunk.css             ❌  source map yok       │
│ [JS]  vendor.js                    ❌  source map yok       │
├─────────────────────────────────────────────────────────────┤
│  MapXtractor | Inspired by mapxtractor by Anıl Çelik 🙏    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Installation

> Chrome Web Store'da yayınlanmamıştır. Developer mode ile yükleyin.

1. Bu repoyu klonlayın veya `chrome-extension/` klasörünü indirin:
   ```bash
   git clone https://github.com/YOUR_USERNAME/mapxtractor.git
   cd mapxtractor/chrome-extension
   ```

2. İkonları oluşturun (isteğe bağlı, zaten mevcutsa atlayın):
   ```bash
   python3 generate_icons.py
   ```

3. Chrome'u açın ve adres çubuğuna yazın:
   ```
   chrome://extensions/
   ```

4. Sağ üst köşeden **Developer mode**'u aktif edin.

5. **Load unpacked** butonuna tıklayın → `chrome-extension/` klasörünü seçin.

6. Toolbar'da 🗺️ ikonunu göreceksiniz.

---

## 🧠 How It Works

### 1 — Asset Discovery
Sayfa DOM'u taranır. `<script src="">` ve `<link rel="stylesheet" href="">` elementlerindeki URL'ler toplanır.

### 2 — Source Map Detection (3 strateji)

| Strateji | Açıklama |
|----------|----------|
| **HTTP Header** | `SourceMap:` veya `X-SourceMap:` response header'ı |
| **Comment** | Dosyanın sonundaki `//# sourceMappingURL=` veya `/*# sourceMappingURL= */` |
| **Fallback** | `filename.js` → `filename.js.map` (HEAD isteği) |

> Inline `data:application/json;base64,...` map'ler tespit edilir ama indirme gerektirmediğinden ayrı işaretlenir.

### 3 — Source Extraction
Map dosyası geçerli bir Source Map v3 ise (`version`, `mappings`, `sources` kontrol edilir), `sourcesContent` dizisindeki her dosya listelenir:

```json
{
  "version": 3,
  "sources": ["src/App.tsx", "src/api/client.ts"],
  "sourcesContent": ["// App.tsx içeriği…", "// client.ts içeriği…"],
  "mappings": "AAAA,…"
}
```

### 4 — Download Options

| Seçenek | Ne indirir |
|---------|-----------|
| **⬇ Map** | Ham `.map` JSON dosyası |
| **⬇ ZIP indir** | Tüm `sourcesContent` dosyaları, orijinal path yapısıyla ZIP'e paketlenir |
| **⬇ (per file)** | Tek bir kaynak dosya |
| **⬇ Map'leri İndir** | Bulunan tüm `.map` dosyaları (stats bar'dan) |

ZIP oluşturma işlemi harici kütüphane gerektirmez — pure JavaScript ile STORE yöntemi kullanılır.

---

## 🎯 Use Cases

- **Bug bounty recon** — üretim ortamında açıkta kalan kaynak kod tespiti
- **Penetration testing** — JS bundle'ları içindeki endpoint, token ve konfigürasyon avcılığı
- **CTF challenges** — client-side kaynak kodunu hızlıca çözümleme
- **Security research** — frontend mimarisi ve gizli API'ları keşfetme

---

## 🔍 What You Might Find

Açıkta kalan source map'ler üretim ortamlarında şunları ifşa edebilir:

```typescript
// src/config/env.ts (extracted from main.abc123.js.map)
export const API_BASE_URL = "https://api.internal.corp/v2";
export const ADMIN_PANEL   = "/internal/admin-dashboard";
export const DEBUG_TOKEN   = "eyJhbGci...";
```

- Gizli API endpoint'leri
- Hardcoded credential ve token'lar
- İç ağ adresleri ve servis URL'leri
- Feature flag'ler ve A/B test mantığı
- Yorumlar ve geliştirici notları

---

## 📁 Extracted ZIP Structure

ZIP içeriği, source map'teki orijinal proje yapısını korur:

```
main.abc123_sources.zip
└── src/
    ├── App.tsx
    ├── index.tsx
    ├── api/
    │   ├── client.ts
    │   └── endpoints.ts
    └── config/
        └── env.ts
```

---

## 🛡️ Permissions

| İzin | Neden gerekli |
|------|--------------|
| `activeTab` | Aktif sekmedeki DOM'a erişim (asset listesi) |
| `scripting` | Sayfaya content script inject etmek |
| `downloads` | Map ve kaynak dosyaları indirmek |
| `host_permissions: <all_urls>` | Map dosyalarını fetch etmek |

---

## ⚠️ Disclaimer

Bu araç yalnızca **yetkili güvenlik testleri ve eğitim amaçlı** kullanım içindir.

- Yalnızca herkese açık kaynaklara erişir.
- Herhangi bir kimlik doğrulama veya yetkilendirme mekanizmasını atlatmaz.
- Test ettiğiniz sistemler için **her zaman önceden izin alın**.

---

## 🙏 Credits & Inspiration

Bu extension, **Anıl Çelik** ([@ccelikanil](https://github.com/ccelikanil))'in geliştirdiği orijinal [mapxtractor](https://github.com/ccelikanil/mapxtractor) aracından ilham alınarak yapılmıştır.

Python CLI aracındaki source map tespiti, kaynak doğrulama ve `sourcesContent` çıkarma mantığı bu extension'ın temelini oluşturmaktadır.

> Python aracıyla **komut satırından toplu tarama** yapmak, secretscanner ile **gizli değerleri aramak** ve üretim ortamlarını derinlemesine analiz etmek için orijinal projeyi ziyaret edin:
>
> 👉 **[github.com/ccelikanil/mapxtractor](https://github.com/ccelikanil/mapxtractor)**

---

## 📜 License

MIT — özgürce kullanın, fork edin, geliştirin.
