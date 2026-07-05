// Fab content downloader for browser (File System Access API)
import { parseManifestFromBytes, decodeChunkPayload, chunkUrl, IncrementalSHA1 } from '../lib/browser-manifest-parser.js';
import { debug } from '../lib/debug.js';

const CHUNK_CONCURRENCY = 16;

// ==================== Chunk Cache (browser, batched proxy) ====================
class ChunkCache {
  constructor(chunkById, baseUrls, manifestVersion, baseUrlTokens = null, maxConcurrent = CHUNK_CONCURRENCY) {
    this.chunkById = chunkById;
    this.baseUrls = baseUrls;
    this.baseUrlTokens = baseUrlTokens; // parallel to baseUrls — CDN token per URL
    this.manifestVersion = manifestVersion;
    this.maxConcurrent = maxConcurrent;
    this.inflight = new Map();
    this.active = 0;
    this.waiters = [];
    this.pending = new Map(); // url → [{resolve, reject}]
    this.batchTimer = null;
  }

  acquire() {
    if (this.active < this.maxConcurrent) { this.active++; return Promise.resolve(); }
    return new Promise(r => this.waiters.push(() => { this.active++; r(); }));
  }

  release() {
    this.active--;
    const n = this.waiters.shift();
    if (n) n();
  }

  // Queue a URL for batched fetch
  queueUrl(url) {
    if (!this.pending.has(url)) this.pending.set(url, []);
    return new Promise((resolve, reject) => {
      this.pending.get(url).push({ resolve, reject });
      // Flush after 20ms or 8 URLs accumulated
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), 20);
      }
      if (this.pending.size >= 8) {
        clearTimeout(this.batchTimer);
        this.flushBatch();
      }
    });
  }

  async flushBatch() {
    if (this._flushing) return;
    this._flushing = true;
    this.batchTimer = null;
    const batch = new Map(this.pending);
    this.pending.clear();

    if (batch.size === 0) return;

    const urls = [...batch.keys()];
    // Use proxy:fetch if only 1 URL (simpler), proxy:batch otherwise
    const fetchOne = async (url) => {
      const resp = await chrome.runtime.sendMessage({ action: "proxy:fetch", url });
      if (resp?.status !== "ok") throw new Error(resp?.message || "proxy fetch failed");
      return resp.data;
    };

    const fetchAll = async (urls) => {
      const resp = await chrome.runtime.sendMessage({ action: "proxy:batch", urls });
      if (resp?.status !== "ok") throw new Error(resp?.message || "batch failed");
      return resp.results; // [{url, data?, error?}]
    };

    try {
      const results = urls.length === 1
        ? [{ url: urls[0], data: await fetchOne(urls[0]) }]
        : await fetchAll(urls);

      const resultMap = new Map();
      for (const r of results) {
        if (r.data) resultMap.set(r.url, r.data);
      }

      for (const [url, waiters] of batch) {
        const data = resultMap.get(url);
        if (data) {
          for (const w of waiters) w.resolve(data);
        } else {
          const err = results.find(r => r.url === url)?.error || 'fetch failed';
          for (const w of waiters) w.reject(new Error(err));
        }
      }
    } catch (e) {
      for (const [, waiters] of batch) {
        for (const w of waiters) w.reject(e);
      }
    }
    this._flushing = false;
  }

  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const data = await this.queueUrl(url);
        if (!data) throw new Error('empty response');
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        return bytes;
      } catch (e) {
        if (i < retries - 1) await new Promise(r => setTimeout(r, Math.min(500 * Math.pow(2, i), 5000)));
        else throw e;
      }
    }
  }

  async get(guid) {
    const cached = this.inflight.get(guid);
    if (cached) return cached;

    const chunk = this.chunkById.get(guid);
    if (!chunk) throw new Error(`Unknown chunk: ${guid}`);

    const promise = (async () => {
      await this.acquire();
      try {
        let lastErr;
        for (let cdn = 0; cdn < this.baseUrls.length; cdn++) {
          try {
            const token = this.manifestVersion === 0 ? (this.baseUrlTokens?.[cdn] || null) : null;
            const url = chunkUrl(chunk, this.baseUrls[cdn], this.manifestVersion, token);
            const raw = await this.fetchWithRetry(url);
            return await decodeChunkPayload(raw);
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr;
      } finally { this.release(); }
    })();
    this.inflight.set(guid, promise);
    return promise;
  }

  get stats() {
    return { downloaded: this.inflight.size, active: this.active };
  }
}

// ==================== TAR Archive Builder ====================
// Bypasses Chrome FSAA .dll/.exe blocking: writes ONE .tar instead of per-file writes

function tarHeader(filename, size) {
  // USTAR format: 512-byte header
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  const w = (off, str, len) => { const b = enc.encode(str); buf.set(b.slice(0, len), off); };

  // Split path into prefix (dir) and name (basename) — USTAR allows 155 + 100 = 255 chars
  const norm = filename.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  let name = norm, prefix = '';
  if (lastSlash > 0) {
    prefix = norm.slice(0, lastSlash);
    name = norm.slice(lastSlash + 1);
  }
  // Truncate if needed
  if (name.length > 100) name = name.slice(0, 100);
  if (prefix.length > 155) prefix = prefix.slice(0, 155);

  w(0, name, 100);
  w(100, '000644 \0', 8);        // mode
  w(108, '0000000 \0', 8);       // uid
  w(116, '0000000 \0', 8);       // gid
  w(124, size.toString(8).padStart(11, '0') + ' ', 12); // size in octal
  w(136, Math.floor(Date.now()/1000).toString(8).padStart(11, '0') + ' ', 12); // mtime
  buf[156] = 0x30;                // typeflag: '0' = regular file
  w(257, 'ustar\0', 6);
  w(263, '00', 2);
  w(345, prefix, 155);

  // Checksum: fill field with spaces, sum all bytes, write back
  buf.set(enc.encode('        '), 148); // 8 spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  w(148, sum.toString(8).padStart(6, '0') + '\0 ', 8);

  return buf;
}

const ZERO512 = new Uint8Array(512);

async function buildTar(fileManifestList, cache, dirHandle, assetName, onProgress) {
  // Create the .tar file
  const tarName = `${assetName}.tar`;
  const fh = await dirHandle.getFileHandle(tarName, { create: true });
  const w = await fh.createWritable();

  let totalBytes = 0, done = 0;
  const total = fileManifestList.length;

  for (const file of fileManifestList) {
    const hasher = new IncrementalSHA1();
    const header = tarHeader(file.filename, file.fileSize);
    await w.write(header);

    let bytes = 0;
    for (const part of file.chunkParts) {
      const payload = await cache.get(part.guid);
      const slice = payload.subarray(part.offset, part.offset + part.size);
      hasher.update(slice);
      await w.write(slice);
      bytes += part.size;
    }

    // SHA1 verify
    if (file.fileHash && file.fileHash !== '0'.repeat(40)) {
      const got = await hasher.digest();
      if (got !== file.fileHash.toLowerCase()) throw new Error(`SHA1 mismatch: ${file.filename}`);
    }

    // Pad to 512 bytes
    const pad = (512 - (file.fileSize % 512)) % 512;
    if (pad > 0) await w.write(ZERO512.slice(0, pad));

    totalBytes += bytes;
    done++;
    if (onProgress) onProgress({
      phase: 'downloading', current: done, total,
      filename: file.filename.replace(/\\/g, '/').replace(/^\/+/, ''),
      totalWritten: totalBytes,
      chunkDownloaded: cache.stats.downloaded,
      totalChunks: 0,
    });
  }
  // TAR end: two zero blocks
  await w.write(ZERO512);
  await w.write(ZERO512);
  await w.close();

  return { files: done, totalBytes };
}

// ==================== Main Download Pipeline ====================

export async function downloadAsset({ manifestUrls, baseUrls, baseUrlTokens, manifestBase64, dirHandle, assetName, onProgress }) {
  // Step 1: Get manifest binary
  let manifestBytes = null;
  if (manifestBase64) {
    try {
      const binary = atob(manifestBase64);
      manifestBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) manifestBytes[i] = binary.charCodeAt(i);
    } catch (e) {
      debug.warn('base64 decode failed:', e.message);
      manifestBytes = null;
    }
  }
  if (!manifestBytes) {
    for (const url of manifestUrls) {
      try {
        const r = await fetch(url);
        if (r.ok) { manifestBytes = new Uint8Array(await r.arrayBuffer()); break; }
      } catch { debug.warn('CDN manifest fetch failed, trying next URL'); }
    }
  }
  if (!manifestBytes) throw new Error('Failed to download manifest from all CDNs');

  if (onProgress) onProgress({ phase: 'parsing' });

  // Step 2: Parse manifest
  const manifest = await parseManifestFromBytes(manifestBytes);
  const { chunkDataList, fileManifestList, version } = manifest;
  debug.log('Manifest:', fileManifestList.length, 'files,', chunkDataList.length, 'chunks, version:', version);

  // Step 3: Download and build TAR
  const chunkById = new Map();
  for (const ck of chunkDataList) chunkById.set(ck.guid, ck);

  const cache = new ChunkCache(chunkById, baseUrls, version, baseUrlTokens, CHUNK_CONCURRENCY);
  return await buildTar(fileManifestList, cache, dirHandle, assetName, onProgress);
}
// parseManifestFromBytes imported from lib/browser-manifest-parser.js
