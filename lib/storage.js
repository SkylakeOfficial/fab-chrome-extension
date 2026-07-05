// chrome.storage.local wrapper with TTL support
// Keys stored: "auth" (AuthTokens), "libraryCache" ({ items, cachedAt, totalCount })

const LIBRARY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getAuth() {
  const data = await chrome.storage.local.get("auth");
  return data.auth || null;
}

export async function setAuth(tokens) {
  await chrome.storage.local.set({ auth: tokens });
}

export async function clearAuth() {
  await chrome.storage.local.remove("auth");
}

export async function getLibraryCache() {
  const data = await chrome.storage.local.get("libraryCache");
  return data.libraryCache || null;
}

export async function setLibraryCache(items) {
  await chrome.storage.local.set({
    libraryCache: {
      items,
      cachedAt: new Date().toISOString(),
      totalCount: items.length,
    },
  });
}

export function isLibraryCacheValid(cache) {
  if (!cache?.cachedAt) return false;
  const age = Date.now() - new Date(cache.cachedAt).getTime();
  return age < LIBRARY_CACHE_MAX_AGE_MS;
}

export async function get(key) {
  const data = await chrome.storage.local.get(key);
  return data[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
