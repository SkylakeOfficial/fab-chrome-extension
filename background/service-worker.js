// Fab Content Downloader — Background Service Worker
// Handles: OAuth token lifecycle, Fab API calls, manifest download
import { exchangeCode, refreshToken, isTokenExpired, validateTokens, buildOAuthUrl } from "../lib/auth.js";
import { getAuth, setAuth, clearAuth, getLibraryCache, setLibraryCache, isLibraryCacheValid } from "../lib/storage.js";
import { debug } from "../lib/debug.js";

// Convert Uint8Array to base64 string (URL.createObjectURL is unavailable in MV3 service workers)
function toBase64(bytes) {
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join("");
  return btoa(binary);
}

// ==================== Auth Handlers ====================

/** Shared token load + optional refresh. Returns tokens or null. */
async function ensureValidTokens() {
  let tokens = await getAuth();
  if (!tokens || !validateTokens(tokens)) return null;
  if (isTokenExpired(tokens)) {
    try {
      tokens = await refreshToken(tokens.refreshToken);
      await setAuth(tokens);
    } catch {
      debug.warn('Token refresh failed, clearing auth');
      await clearAuth();
      return null;
    }
  }
  return tokens;
}

async function handleAuthStart() {
  const url = buildOAuthUrl();
  await chrome.tabs.create({ url });
  return { status: "pending", message: "OAuth tab opened. Log in to Epic Games." };
}

async function handleAuthCode({ code }) {
  if (!code || code.length < 10) {
    return { status: "error", message: "Invalid authorization code." };
  }
  try {
    const tokens = await exchangeCode(code);
    await setAuth(tokens);
    // Open library page directly (popup may have closed when user switched to OAuth tab)
    chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html") });
    // Also broadcast so any open extension pages can refresh UI
    chrome.runtime.sendMessage({ action: "auth:complete", displayName: tokens.displayName }).catch(() => {});
    return { status: "ok", displayName: tokens.displayName, accountId: tokens.accountId };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

async function handleAuthStatus() {
  const tokens = await ensureValidTokens();
  if (!tokens) return { status: "logged_out" };
  return {
    status: "logged_in",
    displayName: tokens.displayName,
    accountId: tokens.accountId,
    expiresAt: tokens.expiresAt,
  };
}

async function handleAuthLogout() {
  await clearAuth();
  return { status: "logged_out" };
}

// (auth:manual-code handled directly by handleAuthCode)

// ==================== Library & Manifest Handlers ====================

async function loadTokens() {
  return ensureValidTokens();
}

async function handleLibraryList() {
  const tokens = await loadTokens();
  if (!tokens) return { status: "auth_expired", message: "Please log in again." };

  // Check cache
  const cache = await getLibraryCache();
  if (cache && isLibraryCacheValid(cache)) {
    return { status: "ok", items: cache.items, cached: true, totalCount: cache.totalCount, displayName: tokens.displayName };
  }

  // Fetch all pages
  try {
    const items = [];
    let cursor = null;
    let page = 0;
    do {
      page++;
      const params = new URLSearchParams({ count: "100" });
      if (cursor) params.set("cursor", cursor);
      const url = `https://www.fab.com/e/accounts/${encodeURIComponent(tokens.accountId)}/ue/library?${params}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const results = data.results || [];
      items.push(...results);
      cursor = data.cursors?.next;
    } while (cursor);

    await setLibraryCache(items);
    return { status: "ok", items, cached: false, totalCount: items.length, displayName: tokens.displayName };
  } catch (e) {
    // Fall back to stale cache if available
    if (cache) {
      return { status: "ok", items: cache.items, cached: true, stale: true, totalCount: cache.totalCount, displayName: tokens.displayName };
    }
    return { status: "error", message: e.message };
  }
}

async function handleLibraryRefresh() {
  // Force clear cache and re-fetch
  await chrome.storage.local.remove("libraryCache");
  return handleLibraryList();
}

/** Fetch binary manifest from CDN URLs. Returns { manifestBase64, bytes } or null. */
async function fetchManifestFromCDNs(manifestUrls) {
  for (const mu of manifestUrls) {
    try {
      debug.log('Fetching manifest from CDN:', mu.substring(0, 100));
      const r = await fetch(mu);
      debug.log('CDN response:', r.status, r.statusText);
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        const manifestBase64 = toBase64(bytes);
        debug.log('Manifest fetched:', bytes.length, 'bytes');
        return { manifestBase64, bytes };
      }
    } catch (e) {
      debug.warn('CDN fetch failed:', e.message, 'for', mu.substring(0, 80));
    }
  }
  return null;
}

async function handleManifestFetch({ assetId, assetNamespace, artifactId }) {
  const tokens = await loadTokens();
  if (!tokens) return { status: "auth_expired", message: "Please log in again." };

  try {
    const resp = await fetch(`https://www.fab.com/e/artifacts/${encodeURIComponent(artifactId)}/manifest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item_id: assetId,
        namespace: assetNamespace,
        platform: "Windows",
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Extract distribution points and base URLs, matching by CDN host.
    // distributionPoints[i].manifestUrl has the CDN token; baseUrls don't.
    // The two arrays may be in different orders, so we match by host.
    const downloadInfo = data.downloadInfo || data.download_info || [];
    const manifestUrls = [];
    const baseUrls = [];
    const baseUrlTokens = []; // parallel to baseUrls — CDN token for chunk access

    for (const artifact of downloadInfo) {
      const points = artifact.distributionPoints || [];
      const bases = artifact.distributionPointBaseUrls || [];

      // Build a host → point lookup for matching
      const pointByHost = new Map();
      for (const p of points) {
        const mu = p?.manifestUrl || p?.manifest_url || "";
        if (mu) {
          try { pointByHost.set(new URL(mu).host, { url: mu, point: p }); }
          catch { /* skip malformed URL */ }
        }
      }

      for (const bu of bases) {
        if (!bu) continue;
        let host;
        try { host = new URL(bu).host; }
        catch { continue; }

        const match = pointByHost.get(host);
        if (match) {
          manifestUrls.push(match.url);
          baseUrls.push(bu);
          // Extract token from manifest URL for chunk access
          const tokenParams = match.url.includes('?') ? match.url.split('?')[1] : '';
          baseUrlTokens.push(tokenParams || null);
        }
      }
    }

    if (manifestUrls.length === 0) {
      return { status: "error", message: "No download URLs in manifest response." };
    }

    const fetched = await fetchManifestFromCDNs(manifestUrls);
    debug.log('manifestBase64 present:', !!fetched);
    return {
      status: "ok",
      manifestUrls,
      baseUrls,
      baseUrlTokens,
      manifestBase64: fetched?.manifestBase64 || null,
      buildVersion: downloadInfo[0]?.buildVersion || "",
      manifestHash: downloadInfo[0]?.manifestHash || "",
    };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

// Proxy fetch — library page can't CORS to CDN, so bg worker fetches and returns base64
async function handleProxyFetch({ url }) {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { status: "error", message: `HTTP ${r.status}: ${body.substring(0, 200)}` };
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: "ok", data: toBase64(bytes) };
  } catch (e) {
    return { status: "error", message: e.message };
  }
}

// Batch proxy — sends multiple URLs, fetches in parallel, returns all results
async function handleProxyBatch({ urls }) {
  if (!Array.isArray(urls) || urls.length === 0) return { status: "error", message: "No URLs" };
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return { url, error: `HTTP ${r.status}: ${body.substring(0, 150)}` };
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { url, data: toBase64(bytes) };
    } catch (e) {
      return { url, error: e.message };
    }
  }));
  return { status: "ok", results };
}

// ==================== Message Router ====================

const HANDLERS = {
  "auth:start":          handleAuthStart,
  "auth:code":           handleAuthCode,
  "auth:status":         handleAuthStatus,
  "auth:logout":         handleAuthLogout,
  "auth:manual-code":    handleAuthCode,
  "library:list":        handleLibraryList,
  "library:refresh":     handleLibraryRefresh,
  "manifest:fetch":      handleManifestFetch,
  "proxy:fetch":         handleProxyFetch,
  "proxy:batch":         handleProxyBatch,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message.action];
  if (!handler) {
    sendResponse({ status: "error", message: `Unknown action: ${message.action}` });
    return false;
  }

  Promise.resolve().then(() => handler(message)).then(sendResponse).catch(err => {
    sendResponse({ status: "error", message: err?.message || "Internal error" });
  });

  return true; // Keep channel open for async response
});

// Service worker ready (no-op — activation is silent in production).
