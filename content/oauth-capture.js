// Content script injected into Epic OAuth redirect page.
// Auto-extracts the authorizationCode from the JSON response body.
// Runs at document_end on https://www.epicgames.com/id/api/redirect*

(function () {
  "use strict";

  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[Fab]', ...args); };

  if (window.__fabOAuthProcessed) return;
  window.__fabOAuthProcessed = true;

  function extractCode() {
    try {
      // Epic's redirect page returns JSON directly in the body
      // It may be wrapped in <pre> or just raw text
      const bodyText = document.body?.innerText || document.body?.textContent || "";
      if (!bodyText.trim()) return null;

      // Try to parse as JSON
      const trimmed = bodyText.trim();
      if (trimmed.startsWith("{")) {
        const data = JSON.parse(trimmed);
        if (data.authorizationCode && typeof data.authorizationCode === "string") {
          return data.authorizationCode;
        }
      }
    } catch {
      dbg('OAuth capture: body not JSON yet (user likely on login form)');
    }
    return null;
  }

  function notifyBackground(code) {
    chrome.runtime.sendMessage({ action: "auth:code", code }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Fab Extension: Failed to send code to background:", chrome.runtime.lastError.message);
        return;
      }
      if (response?.status === "ok") {
        // Replace page with success message
        document.body.innerHTML = `
          <div style="
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e; color: #e0e0e0; text-align: center; padding: 2rem;
          ">
            <div style="font-size: 4rem; margin-bottom: 1rem;">&#10003;</div>
            <h1 style="color: #4ade80; margin-bottom: 0.5rem;">Login Successful!</h1>
            <p style="font-size: 1.1rem; color: #94a3b8;">
              Logged in as <strong style="color: #e0e0e0;">${escapeHtml(response.displayName)}</strong>
            </p>
            <p style="color: #64748b; margin-top: 2rem;">You can close this tab and return to the Fab Downloader extension.</p>
          </div>
        `;
      } else {
        // Show error state
        document.body.innerHTML = `
          <div style="
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e; color: #e0e0e0; text-align: center; padding: 2rem;
          ">
            <div style="font-size: 4rem; margin-bottom: 1rem;">&#9888;</div>
            <h1 style="color: #f87171; margin-bottom: 0.5rem;">Authentication Failed</h1>
            <p style="color: #94a3b8;">${escapeHtml(response?.message || "Unknown error")}</p>
            <p style="color: #64748b; margin-top: 2rem;">Please try again from the Fab Downloader popup.</p>
          </div>
        `;
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Try immediately
  const code = extractCode();
  if (code) {
    notifyBackground(code);
    return;
  }

  // If not found, observe the DOM for changes (login form → redirect → JSON)
  const observer = new MutationObserver(() => {
    const code = extractCode();
    if (code) {
      observer.disconnect();
      notifyBackground(code);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Timeout after 120 seconds
  setTimeout(() => {
    observer.disconnect();
  }, 120000);
})();
