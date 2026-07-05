// Popup UI — manages auth state display and user actions
const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.warn('[Fab]', ...args); };
const $ = (sel) => document.querySelector(sel);
const states = {
  "logged-out": $("#state-logged-out"),
  loading: $("#state-loading"),
  pending: $("#state-pending"),
  "logged-in": $("#state-logged-in"),
  error: $("#state-error"),
};

function showState(name) {
  Object.values(states).forEach(el => { if (el) el.style.display = "none"; });
  const target = states[name];
  if (target) target.style.display = "flex";
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3000);
}

async function checkAuth() {
  showState("loading");
  try {
    const resp = await chrome.runtime.sendMessage({ action: "auth:status" });
    if (resp?.status === "logged_in") {
      $("#account-name").textContent = resp.displayName || "Unknown";
      $("#account-id").textContent = resp.accountId ? resp.accountId.slice(0, 8) + "..." : "";
      $("#account-avatar").textContent = (resp.displayName || "U")[0].toUpperCase();
      loadCacheStatus();
      showState("logged-in");
    } else if (resp?.status === "expired") {
      showState("logged-out");
    } else {
      showState("logged-out");
    }
  } catch (e) {
    showState("error");
    $("#error-message").textContent = e.message;
  }
}

async function loadCacheStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "library:list" });
    if (resp?.status === "ok") {
      const label = resp.cached ? (resp.stale ? " (stale, refresh failed)" : " (cached)") : " (fresh)";
      $("#cache-status").textContent = `Library: ${resp.totalCount || resp.items?.length || 0} items${label}`;
    }
  } catch (e) { dbg('Failed to load cache status:', e.message); $("#cache-status").textContent = ""; }
}

// ====== Button handlers ======

$("#btn-login").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ action: "auth:start" });
    showState("pending");
  } catch (e) {
    showToast(e.message, "error");
  }
});

$("#btn-manual").addEventListener("click", async () => {
  const code = $("#manual-code").value.trim();
  if (!code) { showToast("Paste the authorization code first.", "error"); return; }
  try {
    const resp = await chrome.runtime.sendMessage({ action: "auth:manual-code", code });
    if (resp?.status === "ok") {
      showToast(`Logged in as ${resp.displayName}`);
      setTimeout(checkAuth, 500);
    } else {
      showToast(resp?.message || "Auth failed", "error");
    }
  } catch (e) {
    showToast(e.message, "error");
  }
});

$("#btn-open-library").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html") });
});

$("#btn-logout").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "auth:logout" });
  showState("logged-out");
});

$("#btn-retry").addEventListener("click", checkAuth);

// ====== Listen for auth completion ======
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "auth:complete") {
    checkAuth();
  }
});

// Initial check
checkAuth();
