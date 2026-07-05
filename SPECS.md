# Fab Content Downloader — Technical Specification

## Architecture

```
┌────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)                     │
│                                                    │
│  popup/          library/        background/       │
│  (auth UI)       (browse + DL)   (service worker)  │
│     │                │                │            │
│     └──────┬─────────┘       ┌────────┘            │
│            │                 │                      │
│     chrome.storage     chrome.runtime              │
│         .local         .sendMessage()               │
│                            │                        │
│              ┌─────────────┴──────────┐            │
│              │   proxy:fetch/batch    │            │
│              ▼                        ▼            │
│     ┌──────────────┐    ┌──────────────────────┐   │
│     │ Fab REST API  │    │ Epic CDNs (3 mirrors) │   │
│     │ www.fab.com   │    │ Fastly/Akamai/CF      │   │
│     └──────────────┘    └──────────────────────┘   │
└────────────────────────────────────────────────────┘
```

## Module Map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, content scripts, icons |
| `background/service-worker.js` | Auth lifecycle, Fab API proxy, CDN fetch proxy (batch), manifest binary fetch |
| `content/oauth-capture.js` | Auto-extract Epic authorizationCode from redirect page |
| `popup/popup.{html,js,css}` | Auth status dashboard, login/logout, manual code input |
| `library/library.{html,js,css}` | Asset browser: card grid, search, filter, version select, download trigger, progress bar |
| `lib/auth.js` | Epic OAuth client: authorization_code exchange, token refresh, UA spoofing |
| `lib/storage.js` | chrome.storage.local wrapper with TTL (24h library cache) |
| `lib/browser-manifest-parser.js` | Manifest parser for binary (magic `0x44BEC00C`) and JSON formats, chunk decompression, SHA1 via Web Crypto, chunk URL builder |
| `lib/debug.js` | Gated debug logging utility (DEBUG flag) |
| `vendor/fab-download-browser.js` | Chunk downloader (batched proxy, 16-concurrent, 3-CDN pool), TAR archive builder (USTAR, 512-byte padding), SHA1 verification per file |

## Manifest Formats

Epic uses two manifest formats depending on the asset type:

### Binary format (newer assets)

Magic header `0x44BEC00C`. Compressed binary structure with separate `chunkDataList` containing per-chunk metadata (`hash`, `groupNumber`, `shaHash`). Chunks stored at:

```
{baseUrl}/ChunksV4/{group:02d}/{hash:016X}_{GUID:032X}.chunk
```

Directory version determined by manifest version field (>=22 → ChunksV5, >=15 → ChunksV4).

### JSON format (older / engine-plugin assets)

Plain JSON with PascalCase fields. Chunk metadata stored in top-level sections:

| Section | Content |
|---|---|
| `ChunkHashList` | 64-bit rolling hash (decimal-encoded bytes) |
| `ChunkShaList` | SHA1 hash (hex) |
| `ChunkFilesizeList` | Compressed chunk size |
| `DataGroupList` | Chunk group number |

All numeric values (hash, offset, size, file size) are decimal-encoded bytes (3 digits per byte, little-endian). Chunks stored at:

```
{baseUrl}/ChunksV3/{group:02d}/{hash:016X}_{GUID:032X}.chunk
```

## Key API Endpoints

| Operation | Method | URL | Context |
|---|---|---|---|
| OAuth redirect | GET | `www.epicgames.com/id/api/redirect?clientId=...&responseType=code` | Browser tab |
| Token exchange | POST | `account-public-service-prod03.ol.epicgames.com/account/api/oauth/token` | Service worker |
| Library listing | GET | `www.fab.com/e/accounts/{id}/ue/library?count=100` | Service worker |
| Manifest | POST | `www.fab.com/e/artifacts/{artifactId}/manifest` | Service worker |
| Manifest file | GET | CDN signed URL (`.manifest` file) | Service worker |
| Chunk download | GET | `{base}/ChunksV{x}/{group}/{hash}_{guid}.chunk` | Service worker (proxy) |

## Auth Flow

1. Popup → `chrome.runtime.sendMessage("auth:start")` → SW opens Epic OAuth URL in new tab
2. Content script (`oauth-capture.js`) injects into the redirect page, detects `authorizationCode` JSON
3. Content script → `sendMessage("auth:code", { code })` → SW exchanges for tokens
4. SW stores `{ accessToken, refreshToken, accountId, displayName }` in `chrome.storage.local`
5. Auto-refresh when token < 5 min from expiry

## Download Pipeline

1. **Library page** sends `manifest:fetch` → SW POSTs Fab API → CDN match by host → returns `{ manifestUrls, baseUrls, baseUrlTokens, manifestBase64 }`
2. **Library page** decodes base64 → parses manifest (auto-detects binary vs JSON format)
3. **ChunkCache** queues chunk URLs → batches 8 at a time → `proxy:batch` to SW → SW fetches CDN in parallel → returns base64 array → page decodes and decompresses
4. **buildTar()** streams each file into a USTAR archive via `FileSystemWritableFileStream`
5. Single `.tar` output — bypasses Chrome's `.dll`/`.exe` FSAA blocking

## CORS Bypass Strategy

The library page (`chrome-extension://` origin) cannot `fetch()` CDN resources directly (CORS blocks). The service worker has no CORS restrictions. Therefore:

- **Manifest file**: SW fetches from CDN, returns as base64
- **Chunks**: SW exposes `proxy:batch` handler — library page sends up to 8 chunk URLs per message, SW fetches all in parallel and returns base64-encoded results

## TAR Format

USTAR format, 512-byte headers. Fields:

| Offset | Size | Field |
|---|---|---|
| 0 | 100 | Filename |
| 100 | 8 | Mode (octal, `000644`) |
| 124 | 12 | Size (octal) |
| 136 | 12 | Mtime (octal, Unix timestamp) |
| 148 | 8 | Checksum (byte sum of header with spaces in checksum field) |
| 156 | 1 | Type flag (`0` = regular file) |
| 345 | 155 | USTAR prefix (directory part) |

Each file entry: header → file data → padding to 512 bytes. Archive ends with two zero blocks.

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Token + library cache persistence |
| Host: `*.epicgames.com` | OAuth redirect detection |
| Host: `*.fab.com` | Library + manifest API |
| Host: `*.fastly-edge.com` / `*.akamaized.net` / `*.epicgamescdn.com` | CDN chunk downloads |
