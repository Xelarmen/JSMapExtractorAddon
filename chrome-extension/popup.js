/**
 * MapXtractor Chrome Extension — popup.js
 *
 * Source map detection & extraction logic inspired by the original
 * mapxtractor tool by Anıl Çelik (@ccelikanil).
 * GitHub: https://github.com/ccelikanil/mapxtractor
 *
 * Teşekkürler Anıl! 🙏
 */
'use strict';

// ── DOM ───────────────────────────────────────────────────────────────────────
const btnScan  = document.getElementById('btn-scan');
const statsBar = document.getElementById('stats');
const stateArea = document.getElementById('state-area');
const assetList = document.getElementById('asset-list');
const btnDlAll       = document.getElementById('btn-dl-all');
const btnDlExtracted = document.getElementById('btn-dl-extracted');
const cntTotal  = document.getElementById('cnt-total');
const cntFound  = document.getElementById('cnt-found');
const cntMiss   = document.getElementById('cnt-miss');
const cntSrc    = document.getElementById('cnt-src');

// ── Global state ──────────────────────────────────────────────────────────────
let foundMaps = [];        // { assetUrl, mapUrl }
let totalSources = 0;      // extracted source files with content (across all maps)
let allSources = [];       // { path, content } — for "download all" ZIP

// ══════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════
btnScan.addEventListener('click', startScan);

async function startScan() {
  btnScan.disabled = true;
  btnScan.textContent = '⏳ Tarıyor…';
  foundMaps = [];
  totalSources = 0;
  allSources = [];

  showLoading();
  statsBar.style.display = 'none';
  assetList.style.display = 'none';
  assetList.innerHTML = '';
  updateStats(0, 0, 0, 0);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const assets = await getPageAssets(tab.id);

    if (!assets || assets.length === 0) {
      showEmpty('Bu sayfada JS veya CSS dosyası bulunamadı.');
      return;
    }

    showList();
    statsBar.style.display = 'flex';
    cntTotal.textContent = assets.length;

    let found = 0, miss = 0;

    await Promise.all(assets.map(async (asset) => {
      const { rowEl, panelEl } = addAssetRow(asset);

      // Step 1 – detect map (fast: HEAD + tail read)
      const detection = await checkSourceMap(asset);

      if (!detection.hasMap) {
        miss++;
        setRowMissing(rowEl, detection.error);
        updateStats(assets.length, found, miss, totalSources);
        return;
      }

      found++;
      foundMaps.push({ assetUrl: asset.url, mapUrl: detection.mapUrl });
      setRowFound(rowEl, asset, detection.mapUrl);
      updateStats(assets.length, found, miss, totalSources);
      btnDlAll.style.display = 'inline-block';

      // Step 2 – show extract button in loading state, then parse full map
      setExtractLoading(rowEl);
      const { parsed, error: parseError } = await fetchAndParseMap(detection.mapUrl);

      if (parsed) {
        const withContent = parsed.sources.filter(s => s.content !== null);
        totalSources += withContent.length;
        allSources.push(...withContent);
        updateStats(assets.length, found, miss, totalSources);
        attachSourcePanel(rowEl, panelEl, asset, detection.mapUrl, parsed);
        if (allSources.length > 0) btnDlExtracted.style.display = 'inline-block';
      } else {
        setExtractFailed(rowEl, parseError);
      }
    }));

  } catch (err) {
    showEmpty(`Hata: ${err.message}`);
  } finally {
    btnScan.disabled = false;
    btnScan.innerHTML = '🔍 Yeniden Tara';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONTENT SCRIPT – collect assets from live page
// ══════════════════════════════════════════════════════════════════════════════
async function getPageAssets(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const seen = new Set();
      const assets = [];
      document.querySelectorAll('script[src]').forEach(el => {
        if (el.src && !seen.has(el.src)) { seen.add(el.src); assets.push({ type: 'js', url: el.src }); }
      });
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach(el => {
        if (el.href && !seen.has(el.href)) { seen.add(el.href); assets.push({ type: 'css', url: el.href }); }
      });
      return assets;
    }
  });
  return results[0].result;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOURCE MAP DETECTION  (same strategy as Python tool)
// ══════════════════════════════════════════════════════════════════════════════
async function checkSourceMap(asset) {
  let text = '';
  let headers = null;

  try {
    const resp = await fetch(asset.url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Check response headers first (SourceMap / X-SourceMap)
    headers = resp.headers;
    const hdrMap = headers.get('SourceMap') || headers.get('X-SourceMap');
    if (hdrMap) {
      const mapUrl = resolveUrl(hdrMap, asset.url);
      if (await urlExists(mapUrl)) return { hasMap: true, mapUrl, via: 'header' };
    }

    // Read only the last 8 KB for the sourceMappingURL comment
    const buf = await resp.arrayBuffer();
    const tail = new Uint8Array(buf, Math.max(0, buf.byteLength - 8192));
    text = new TextDecoder().decode(tail);
  } catch (err) {
    return { hasMap: false, error: err.message };
  }

  // Inline base64 map  →  data:application/json;base64,<b64>
  const inlineMatch = text.match(/sourceMappingURL\s*=\s*data:application\/json;base64,([A-Za-z0-9+/=]+)/i);
  if (inlineMatch) {
    // Inline maps are embedded – no external file to fetch. Signal special case.
    return { hasMap: false, error: 'Inline (data URI) map – embedded in file' };
  }

  // External reference:  //# sourceMappingURL=foo.js.map  or  /*# sourceMappingURL=foo.css.map */
  const refMatch = text.match(/sourceMappingURL\s*=\s*(\S+?)(?:\s*\*\/)?$/im);
  if (refMatch) {
    const ref = refMatch[1].trim().replace(/["']/g, '');
    if (!ref.startsWith('data:')) {
      const mapUrl = resolveUrl(ref, asset.url);
      if (await urlExists(mapUrl)) return { hasMap: true, mapUrl, via: 'comment' };
    }
  }

  // Fallback: try <url>.map
  const fallback = asset.url.split('?')[0] + '.map';
  if (await urlExists(fallback)) return { hasMap: true, mapUrl: fallback, via: 'fallback' };

  return { hasMap: false };
}

// ══════════════════════════════════════════════════════════════════════════════
//  FULL MAP PARSE  – fetch JSON, validate, extract sources
// ══════════════════════════════════════════════════════════════════════════════
async function fetchAndParseMap(mapUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(mapUrl, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) return { parsed: null, error: `Sunucu hatası: HTTP ${resp.status}` };

    const ct = resp.headers.get('Content-Type') || '';
    if (ct.includes('text/html'))  return { parsed: null, error: 'Sunucu HTML döndürdü (map değil)' };
    if (ct.includes('image/'))     return { parsed: null, error: 'Sunucu görüntü döndürdü' };

    let data;
    try {
      data = await resp.json();
    } catch {
      return { parsed: null, error: 'JSON parse hatası — map bozuk veya sıkıştırılmış olabilir' };
    }

    if (!isValidSourceMap(data)) {
      const why = diagnoseInvalidMap(data);
      return { parsed: null, error: `Geçersiz source map: ${why}` };
    }

    const rawSources  = data.sources || [];
    const rawContents = data.sourcesContent;       // may be undefined/null
    const hasContent  = Array.isArray(rawContents);

    const sources = rawSources.map((src, i) => {
      const content = hasContent ? (rawContents[i] ?? null) : null;
      return {
        path:    sanitizeSourcePath(src),
        raw:     src,
        content,
        size:    content !== null ? new TextEncoder().encode(content).length : 0
      };
    });

    return { parsed: { sources, hasContent }, error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { parsed: null, error: 'Bağlantı zaman aşımı (20 s)' };
    return { parsed: null, error: err.message };
  }
}

function isValidSourceMap(data) {
  // Relaxed — only require version:3 and a non-empty sources array.
  // mappings can be empty for index maps; sourcesContent is optional.
  return (
    typeof data === 'object' && data !== null &&
    data.version === 3 &&
    Array.isArray(data.sources) && data.sources.length > 0
  );
}

function diagnoseInvalidMap(data) {
  if (typeof data !== 'object' || data === null) return 'JSON objesi değil';
  if (data.version !== 3) return `version ${data.version} (sadece v3 desteklenir)`;
  if (!Array.isArray(data.sources) || data.sources.length === 0) return 'sources dizisi boş';
  return 'bilinmeyen format';
}

// ── Path sanitization (mirrors Python's sanitize_path) ────────────────────────
function sanitizeSourcePath(src) {
  // Strip webpack:/// or webpack://projectname/
  let p = src
    .replace(/^webpack:\/\/\//, '')
    .replace(/^webpack:\/\/[^/]+\//, '')
    .replace(/^ng:\/\/\//, '')
    .replace(/^[a-z]+:\/\//, '');

  // Replace backslashes
  p = p.replace(/\\/g, '/');

  // Remove leading ./  ../  /
  p = p.replace(/^(\.\.\/|\.\/|\/)+/, '');

  // Remove path traversal
  const parts = p.split('/').filter(s => s !== '' && s !== '..');
  p = parts.join('/');

  // Remove null bytes and other dangerous chars
  p = p.replace(/\0/g, '').replace(/:/g, '_');

  return p || 'unknown_source';
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI – ASSET ROW
// ══════════════════════════════════════════════════════════════════════════════
const _idCache = new Map();
let _idSeq = 0;
function rowId(url) {
  if (!_idCache.has(url)) _idCache.set(url, _idSeq++);
  return _idCache.get(url);
}

function addAssetRow(asset) {
  const id = rowId(asset.url);
  const filename = assetFilename(asset.url);

  const rowEl = document.createElement('div');
  rowEl.className = 'asset-item';
  rowEl.dataset.id = id;
  rowEl.innerHTML = `
    <span class="asset-badge badge-${asset.type}">${asset.type.toUpperCase()}</span>
    <div class="asset-info">
      <div class="asset-name">
        <a href="${escHtml(asset.url)}" target="_blank" title="${escHtml(asset.url)}">${escHtml(filename)}</a>
      </div>
      <div class="asset-sub" id="sub-${id}">kontrol ediliyor…</div>
    </div>
    <span class="asset-status status-checking" id="st-${id}">⋯</span>
    <div class="row-actions">
      <button class="btn-sm btn-map"     id="dl-map-${id}">⬇ Map</button>
      <button class="btn-sm btn-extract" id="btn-ext-${id}">📦 Çıkart</button>
    </div>`;

  const panelEl = document.createElement('div');
  panelEl.className = 'source-panel';
  panelEl.id = `panel-${id}`;

  assetList.appendChild(rowEl);
  assetList.appendChild(panelEl);
  return { rowEl, panelEl };
}

function setRowFound(rowEl, asset, mapUrl) {
  const id   = rowEl.dataset.id;
  const stEl = document.getElementById(`st-${id}`);
  const subEl = document.getElementById(`sub-${id}`);
  const dlMap = document.getElementById(`dl-map-${id}`);

  stEl.className = 'asset-status';
  stEl.textContent = '✅';
  subEl.className = 'asset-sub found';
  subEl.title = mapUrl;
  subEl.textContent = mapUrl;

  dlMap.classList.add('visible');
  dlMap.addEventListener('click', () => downloadUrl(mapUrl));
}

function setRowMissing(rowEl, errorMsg) {
  const id   = rowEl.dataset.id;
  const stEl = document.getElementById(`st-${id}`);
  const subEl = document.getElementById(`sub-${id}`);

  stEl.className = 'asset-status';
  stEl.textContent = '❌';
  subEl.className = 'asset-sub';
  subEl.textContent = errorMsg || 'source map bulunamadı';
}

function setExtractLoading(rowEl) {
  const btn = document.getElementById(`btn-ext-${rowEl.dataset.id}`);
  btn.classList.add('visible');
  btn.disabled = true;
  btn.textContent = '⏳';
  btn.title = 'Map içeriği analiz ediliyor…';
}

function setExtractFailed(rowEl, reason) {
  const id   = rowEl.dataset.id;
  const btn  = document.getElementById(`btn-ext-${id}`);
  const subEl = document.getElementById(`sub-${id}`);

  btn.disabled = true;
  btn.textContent = '⚠️';
  btn.title = reason || 'Çıkartılamadı';
  btn.style.background = '#5a1d1d';

  // Append reason to sub-text
  subEl.textContent += ` — ⚠️ ${reason}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI – SOURCE PANEL
// ══════════════════════════════════════════════════════════════════════════════
function attachSourcePanel(rowEl, panelEl, asset, mapUrl, { sources, hasContent }) {
  const id          = rowEl.dataset.id;
  const extBtn      = document.getElementById(`btn-ext-${id}`);
  const withContent = sources.filter(s => s.content !== null);
  const noContent   = !hasContent;   // server sent map without sourcesContent at all

  // ── Panel header label
  let label;
  if (noContent) {
    label = `${sources.length} kaynak yolu (içerik gömülü değil)`;
  } else if (withContent.length < sources.length) {
    label = `${sources.length} kaynak · ${withContent.length} içerikli · ${sources.length - withContent.length} boş`;
  } else {
    label = `${sources.length} kaynak dosya`;
  }

  // ── ZIP button visibility
  const zipDisabled = withContent.length === 0;

  // ── Warning banner when sourcesContent absent
  const warnBanner = noContent
    ? `<div class="src-warn">
         ℹ️ Bu map dosyasında <code>sourcesContent</code> yok — kaynak kod gömülmemiş.
         Sadece dosya yolları listeleniyor.
       </div>`
    : '';

  // ── File rows
  const fileRows = sources.map((s, i) => {
    const has     = s.content !== null;
    const sizeStr = has ? fmtBytes(s.size) : '—';
    return `
      <div class="source-file-item">
        <span class="src-icon">${extIcon(fileExt(s.path))}</span>
        <span class="src-path ${has ? '' : 'src-nocontent'}" title="${escHtml(s.raw)}">${escHtml(s.path)}</span>
        <span class="src-size">${sizeStr}</span>
        <button class="btn-src-dl" data-idx="${i}" ${has ? '' : 'disabled'}>⬇</button>
      </div>`;
  }).join('');

  panelEl.innerHTML = `
    <div class="source-panel-header">
      <span class="source-panel-title">📂 ${escHtml(label)}</span>
      <button class="btn-zip" id="btn-zip-${id}" ${zipDisabled ? 'disabled title="İndirilecek içerik yok"' : ''}>
        ⬇ ZIP indir
      </button>
    </div>
    ${warnBanner}
    <div class="source-file-list" id="sfl-${id}">${fileRows}</div>`;

  // Individual file download
  document.getElementById(`sfl-${id}`).addEventListener('click', e => {
    const btn = e.target.closest('.btn-src-dl');
    if (!btn || btn.disabled) return;
    const src = sources[parseInt(btn.dataset.idx, 10)];
    if (src?.content !== null) downloadContent(src.path, src.content);
  });

  // Per-asset ZIP download
  document.getElementById(`btn-zip-${id}`).addEventListener('click', () => {
    if (zipDisabled) return;
    const zipName = assetFilename(asset.url).replace(/\.[^.]+$/, '') + '_sources.zip';
    downloadBlobAs(buildZip(withContent.map(s => ({ name: s.path, data: s.content }))),
      zipName, 'application/zip');
  });

  // Toggle open/close
  extBtn.disabled = false;
  extBtn.title = '';
  extBtn.textContent = noContent ? '📋 Yollar' : '📦 Çıkart';
  extBtn.addEventListener('click', () => {
    const isOpen = panelEl.classList.toggle('open');
    extBtn.classList.toggle('open', isOpen);
    extBtn.textContent = isOpen
      ? '📂 Kapat'
      : (noContent ? '📋 Yollar' : '📦 Çıkart');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function downloadUrl(url) {
  chrome.downloads.download({ url, saveAs: false });
}

function downloadContent(filePath, content) {
  const blob = new Blob([content], { type: guessMime(filePath) });
  downloadBlobAs(blob, filePath.split('/').pop() || 'source.txt', guessMime(filePath));
}

function downloadBlobAs(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: safeFilename(filename), saveAs: false }, () => {
    // Revoke after a short delay to allow Chrome to start the download
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ZIP BUILDER  (STORE / no compression, pure JS)
// ══════════════════════════════════════════════════════════════════════════════

// CRC-32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }

function buildZip(files) {
  // files = [{ name: 'src/App.js', data: string }]
  const enc = new TextEncoder();
  const parts = [];
  const centralDirEntries = [];
  let offset = 0;

  for (const file of files) {
    // Normalise path separator for ZIP (always forward slash)
    const nameBytes = enc.encode(file.name.replace(/\\/g, '/'));
    const dataBytes = enc.encode(file.data || '');
    const crc       = crc32(dataBytes);
    const size      = dataBytes.length;

    // Local file header
    const localHeader = concat([
      new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // signature
      u16(20),          // version needed
      u16(0),           // flags
      u16(0),           // compression: STORE
      u16(0),           // mod time
      u16(0),           // mod date
      u32(crc),
      u32(size),        // compressed size
      u32(size),        // uncompressed size
      u16(nameBytes.length),
      u16(0),           // extra field length
      nameBytes
    ]);

    // Central directory entry (saved for later)
    const cdEntry = concat([
      new Uint8Array([0x50, 0x4B, 0x01, 0x02]), // signature
      u16(20),           // version made by
      u16(20),           // version needed
      u16(0),            // flags
      u16(0),            // compression: STORE
      u16(0),            // mod time
      u16(0),            // mod date
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),            // extra field length
      u16(0),            // file comment length
      u16(0),            // disk number start
      u16(0),            // internal attr
      u32(0),            // external attr
      u32(offset),       // relative offset of local header
      nameBytes
    ]);

    centralDirEntries.push(cdEntry);
    parts.push(localHeader, dataBytes);
    offset += localHeader.length + size;
  }

  const cdOffset = offset;
  const cdBytes  = concat(centralDirEntries);
  const eocd     = concat([
    new Uint8Array([0x50, 0x4B, 0x05, 0x06]), // end of central dir signature
    u16(0),                 // disk number
    u16(0),                 // disk with start of CD
    u16(files.length),      // entries on this disk
    u16(files.length),      // total entries
    u32(cdBytes.length),    // size of central directory
    u32(cdOffset),          // offset of central directory
    u16(0)                  // comment length
  ]);

  return concat([...parts, cdBytes, eocd]);
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI STATE HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function showLoading() {
  stateArea.style.display = 'flex';
  stateArea.innerHTML = `
    <div class="state-msg">
      <div class="spinner"></div>
      <p>Sayfadaki JS/CSS dosyaları taranıyor…</p>
    </div>`;
}

function showEmpty(msg) {
  stateArea.style.display = 'flex';
  stateArea.innerHTML = `
    <div class="state-msg">
      <span class="icon">🔍</span>
      <p>${escHtml(msg)}</p>
    </div>`;
  assetList.style.display = 'none';
}

function showList() {
  stateArea.style.display = 'none';
  assetList.style.display = 'block';
}

function updateStats(total, found, miss, src) {
  cntTotal.textContent = total;
  cntFound.textContent = found;
  cntMiss.textContent  = miss;
  cntSrc.textContent   = src;
}

// ── Download all raw map files ────────────────────────────────────────────────
btnDlAll.addEventListener('click', () => {
  foundMaps.forEach(({ mapUrl }) => downloadUrl(mapUrl));
});

// ── Download ALL extracted sources as one mega-ZIP ────────────────────────────
btnDlExtracted.addEventListener('click', () => {
  if (!allSources.length) return;
  const zip = buildZip(allSources.map(s => ({ name: s.path, data: s.content })));
  downloadBlobAs(zip, 'all_sources.zip', 'application/zip');
});

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════════════════
function resolveUrl(ref, base) {
  try { return new URL(ref, base).href; } catch { return ref; }
}

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

function assetFilename(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).pop() || url; }
  catch { return url; }
}

function safeFilename(name) {
  return name.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\/+/, '');
}

function fileExt(path) {
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function extIcon(ext) {
  const map = { js: '🟨', ts: '🔷', jsx: '⚛️', tsx: '⚛️', vue: '💚',
                css: '🎨', scss: '🎨', sass: '🎨', less: '🎨',
                html: '🌐', json: '📋', md: '📝', svg: '🖼️',
                py: '🐍', rb: '💎', go: '🐹', rs: '🦀' };
  return map[ext] || '📄';
}

function guessMime(path) {
  const ext = fileExt(path);
  const map = { js: 'application/javascript', ts: 'application/typescript',
                css: 'text/css', html: 'text/html', json: 'application/json',
                md: 'text/markdown', svg: 'image/svg+xml' };
  return map[ext] || 'text/plain';
}

function fmtBytes(n) {
  if (n < 1024)       return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
