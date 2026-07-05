// Epic binary/JSON manifest parser — browser (Web API) port
// Uses DecompressionStream instead of node:zlib, crypto.subtle instead of node:crypto
// Ported from e:\playground\epic-fab\src\manifestParser.ts

import { debug } from './debug.js';

const MANIFEST_MAGIC = 0x44bec00c;
const CHUNK_MAGIC = 0xb1fe3aa2;
const STORED_COMPRESSED = 0x1;

// ==================== Binary Reader ====================
class Reader {
  offset = 0;
  constructor(view) { this.view = view; }
  get pos() { return this.offset; }
  seek(n) { this.offset = n; }
  skip(n) { this.offset += n; }
  remaining() { return this.view.byteLength - this.offset; }
  u8() { return this.view.getUint8(this.offset++); }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  i32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  u64() { const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i64() { const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return Number(v); }
  bytes(len) {
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len).slice();
    this.offset += len; return out;
  }
  fstring() {
    const l = this.i32();
    if (l === 0) return "";
    if (l > 0) { const d = this.bytes(l - 1); this.skip(1); return new TextDecoder().decode(d); }
    const cc = -l; const d = this.bytes((cc - 1) * 2); this.skip(2);
    let o = "";
    for (let i = 0; i + 1 < d.length; i += 2) o += String.fromCharCode(d[i] | (d[i + 1] << 8));
    return o;
  }
}

// ==================== Decompression (Web API) ====================
// Unified decompressor: tries zlib-wrapped first, then raw deflate
async function decompressDeflate(data) {
  // Check for zlib header (0x78 0x01 / 0x78 0x9C / 0x78 0xDA)
  const isZlib = data.length >= 2 && data[0] === 0x78;
  // Try raw deflate first (handles both raw and zlib-stripped)
  for (const input of [data, isZlib ? data.subarray(2, data.length - 4) : null].filter(Boolean)) {
    try { return await decompressRaw(input); }
    catch { debug.log('decompression attempt failed, trying next format'); }
  }
  if (isZlib) {
    try { return await decompressRaw(data.subarray(2)); }
    catch { debug.log('zlib-stripped decompression attempt failed'); }
  }
  throw new Error('Decompression failed');
}

async function decompressRaw(input) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(input);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ==================== SHA1 (Web Crypto) ====================
async function sha1(data) {
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export class IncrementalSHA1 {
  constructor() { this.chunks = []; }
  update(data) { this.chunks.push(data); }
  async digest() {
    const total = this.chunks.reduce((a, c) => a + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.byteLength; }
    return sha1(merged);
  }
}

// ==================== GUID / Hex helpers ====================
function guidS(a,b,c,d) { return [a,b,c,d].map(p => p.toString(16).toUpperCase().padStart(8, '0')).join(''); }
function b2h(b) { let o=''; for(const x of b) o+=x.toString(16).padStart(2,'0'); return o; }
function u64h(v) { return v.toString(16).toUpperCase().padStart(16, '0'); }
function rGuid(r) { return guidS(r.u32(), r.u32(), r.u32(), r.u32()); }

// ==================== Manifest Parser ====================
export async function parseManifest(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Manifest fetch HTTP ${resp.status}: ${url}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length < 4) throw new Error('Manifest too short');
  return parseManifestFromBytes(bytes);
}

/** Parse a binary or JSON manifest from raw bytes. */
export async function parseManifestFromBytes(bytes) {
  // Detect format by first byte: 0x7b = '{' = JSON, otherwise binary
  if (bytes[0] === 0x7b) {
    return parseJsonManifest(bytes);
  }

  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (r.u32() !== MANIFEST_MAGIC) throw new Error('Bad manifest magic: 0x' + (new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)).toString(16));
  const hs = r.u32(); r.u32(); r.u32();
  const shaH = r.bytes(20);
  const sa = r.u8(); const v = r.u32();
  if (sa & 2) throw new Error('Encrypted manifests not supported');
  if (v >= 22) r.skip(32);
  if (r.pos !== hs) r.seek(hs);
  const cb = r.bytes(r.remaining());
  let body = (sa & STORED_COMPRESSED) ? await decompressDeflate(cb) : cb;
  if (sa & STORED_COMPRESSED) {
    const got = await sha1(body);
    if (got !== b2h(shaH)) throw new Error('Manifest body SHA1 mismatch');
  }
  return readBody(new Uint8Array(body), v);
}

// ==================== JSON Manifest Parser ====================
// Epic JSON-format manifests have chunk metadata in separate top-level sections:
//   ChunkFilesizeList, ChunkHashList, ChunkShaList, DataGroupList
// Values are decimal-encoded (3 digits per byte, like FileHash).
// CDN path for JSON manifests (version 13): ChunksV3/{group}/{hash:016X}_{GUID}.chunk

/** Decode a decimal-encoded byte string (e.g. "070193170...") to Uint8Array. */
function decodeDecimalBytes(s) {
  if (!s || s.length % 3 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(s.length / 3);
  for (let i = 0; i < s.length; i += 3) {
    bytes[i / 3] = parseInt(s.slice(i, i + 3), 10);
  }
  return bytes;
}

/** Decode decimal-encoded bytes to a hex string. */
function decodeDecimalHex(s) {
  const bytes = decodeDecimalBytes(s);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Parse a decimal-encoded uint64 to a 16-char uppercase hex string (for chunk hash). */
function decodeDecimalUint64(s) {
  const bytes = decodeDecimalBytes(s);
  // Read as little-endian uint64
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 8));
  let hash;
  if (bytes.length >= 8) {
    hash = view.getBigUint64(0, true);
  } else {
    hash = BigInt(0);
  }
  return hash.toString(16).toUpperCase().padStart(16, '0');
}

/** Parse an Epic JSON-format manifest. */
function parseJsonManifest(bytes) {
  const text = new TextDecoder().decode(bytes);
  const j = JSON.parse(text);

  const files = j.FileManifestList || [];
  const buildVersion = j.BuildVersionString || '';

  // Parse chunk metadata from top-level sections
  const chunkHashList = j.ChunkHashList || {};
  const chunkShaList = j.ChunkShaList || {};
  const chunkFilesizeList = j.ChunkFilesizeList || {};
  const dataGroupList = j.DataGroupList || {};

  const chunkDataList = [];
  const chunkByGuid = new Map();
  const allGuids = new Set(Object.keys(chunkHashList));

  for (const guid of allGuids) {
    const hashHex = decodeDecimalUint64(chunkHashList[guid] || '');
    const shaHash = (chunkShaList[guid] || '').toLowerCase();
    const sizeStr = chunkFilesizeList[guid] || '';
    const groupStr = dataGroupList[guid] || '0';
    const groupNum = parseInt(groupStr, 10) || 0;

    // fileSize from ChunkFilesizeList: decode as uint64
    const sizeBytes = decodeDecimalBytes(sizeStr);
    let fileSize = 0;
    if (sizeBytes.length >= 8) {
      fileSize = Number(new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 8).getBigUint64(0, true));
    }

    const entry = {
      guid,
      hash: hashHex,
      shaHash,
      groupNumber: groupNum,
      windowSize: 0,
      fileSize,
    };
    chunkDataList.push(entry);
    chunkByGuid.set(guid, entry);
  }

  // Parse file manifest list (FileChunkParts → chunkParts)
  const fileManifestList = [];

  // Helper: decode a decimal-encoded uint32 (e.g. "000000016000" → 1048576)
  function decodeDecimalUint32(s) {
    const db = decodeDecimalBytes(s);
    if (db.length >= 4) {
      return new DataView(db.buffer, db.byteOffset, 4).getUint32(0, true);
    }
    return parseInt(s || '0', 10); // fallback for short values
  }

  for (const f of files) {
    const parts = (f.FileChunkParts || []).map(cp => {
      const guid = cp.Guid || '';
      const offset = decodeDecimalUint32(cp.Offset);
      const size = decodeDecimalUint32(cp.Size);
      return { guid, offset, size };
    });

    const fileSize = parts.reduce((a, c) => a + c.size, 0);
    const fileHashDec = f.FileHash || '';
    // FileHash is decimal-encoded SHA1 (60 digits = 20 bytes)
    const fileHash = fileHashDec.length === 60 ? decodeDecimalHex(fileHashDec) : fileHashDec;

    fileManifestList.push({
      filename: f.Filename || '',
      fileSize,
      fileHash,
      chunkParts: parts,
    });
  }

  // JSON manifests use version 13 → ChunksV3
  return {
    version: 13,
    buildVersion,
    chunkDataList,
    fileManifestList,
  };
}

function readBody(body, mv) {
  const r = new Reader(new DataView(body.buffer, body.byteOffset, body.byteLength));

  // Meta
  const mStart = r.pos, mSize = r.u32();
  r.u8(); r.u32(); r.u8(); r.u32();
  r.fstring(); r.fstring(); r.fstring(); r.fstring();
  const pc = r.u32(); for (let i = 0; i < pc; i++) r.fstring();
  r.fstring(); r.fstring(); r.fstring();
  r.skip(Math.max(0, mSize - (r.pos - mStart)));

  // Chunk data list
  const cStart = r.pos, cSize = r.u32();
  r.u8(); const cc = r.u32();
  const cks = [];
  for (let i=0;i<cc;i++) cks.push({g:guidS(r.u32(),r.u32(),r.u32(),r.u32()),h:0n,sh:new Uint8Array(),gn:0,ws:0,fs:0});
  for (const ck of cks) ck.h = r.u64();
  for (const ck of cks) ck.sh = r.bytes(20);
  for (const ck of cks) ck.gn = r.u8();
  for (const ck of cks) ck.ws = r.u32();
  for (const ck of cks) ck.fs = r.i64();
  r.skip(Math.max(0, cSize - (r.pos - cStart)));

  // File manifest list
  const fStart = r.pos, fSize = r.u32();
  const fv = r.u8(); const fc = r.u32();
  const fls = [];
  for (let i=0;i<fc;i++) fls.push({fn:'',fh:new Uint8Array(),cp:[]});
  for (const f of fls) f.fn = r.fstring();
  for (const f of fls) { r.fstring(); } // symlink
  for (const f of fls) f.fh = r.bytes(20);
  for (const f of fls) r.u8(); // flags
  for (const f of fls) { const tc = r.u32(); for (let i=0;i<tc;i++) r.fstring(); }
  for (const f of fls) {
    const pc2 = r.u32();
    for (let i=0;i<pc2;i++) {
      const ps = r.pos, psz = r.u32();
      f.cp.push({guid:rGuid(r),offset:r.u32(),size:r.u32()});
      r.skip(Math.max(0, psz - (r.pos - ps)));
    }
  }
  r.skip(Math.max(0, fSize - (r.pos - fStart)));

  return {
    version: mv,
    buildVersion: '', // populated from the first FBL string if needed
    chunkDataList: cks.map(ck=>({guid:ck.g,hash:u64h(ck.h),shaHash:b2h(ck.sh),groupNumber:ck.gn,windowSize:ck.ws,fileSize:ck.fs})),
    fileManifestList: fls.map(f=>({filename:f.fn,fileSize:f.cp.reduce((a,c)=>a+c.size,0),fileHash:b2h(f.fh),chunkParts:f.cp})),
  };
}

// ==================== Chunk decompression ====================
export async function decodeChunkPayload(chunkBytes) {
  const r = new Reader(new DataView(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength));
  if (r.u32() !== CHUNK_MAGIC) throw new Error('Bad chunk magic');
  r.u32(); // headerVersion
  const headerSize = r.u32();
  const compressedSize = r.u32();
  r.skip(16); // guid
  r.skip(8);  // hash
  const storedAs = r.u8();
  if (storedAs & 2) throw new Error('Encrypted chunk not supported');
  r.seek(headerSize);
  const payload = chunkBytes.subarray(headerSize);
  if ((storedAs & STORED_COMPRESSED) === 0) return payload;
  try {
    return await decompressDeflate(payload);
  } catch (e) {
    if (payload.length > compressedSize * 0.9) return payload; // likely uncompressed
    throw new Error(`Chunk decompress: ${e.message}`);
  }
}

// ==================== Chunk URL builder ====================
/** Build a CDN chunk URL. */
export function chunkUrl(chunk, baseUrl, manifestVersion, token = null) {
  const base = baseUrl.replace(/\/+$/, '');
  const dir = manifestVersion >= 22 ? 'ChunksV5' : manifestVersion >= 15 ? 'ChunksV4'
    : manifestVersion >= 6 ? 'ChunksV3' : manifestVersion >= 3 ? 'ChunksV2' : 'Chunks';
  const group = (chunk.groupNumber ?? 0).toString().padStart(2, '0');
  let url = `${base}/${dir}/${group}/${chunk.hash}_${chunk.guid}.chunk`;
  if (token) url += (url.includes('?') ? '&' : '?') + token;
  return url;
}
