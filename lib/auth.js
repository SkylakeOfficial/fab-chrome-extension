// Epic OAuth 2.0 client — authorization_code grant with manual code paste.
// Ported from E:\Playground\epic-fab\src\auth.ts for Chrome Extension environment.
// Uses the same launcherAppClient2 credentials as Legendary/Heroic/egs-api-rs.

import { debug } from './debug.js';

const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const TOKEN_ENDPOINT = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
const OAUTH_REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
const EPIC_USER_AGENT = "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh when token expires in < 5 minutes

export function buildOAuthUrl() {
  return OAUTH_REDIRECT_URL;
}

function basicAuthHeader() {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${btoa(creds)}`;
}

async function postToken(body) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": EPIC_USER_AGENT,
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      if (err.errorMessage) detail = `${detail} — ${err.errorCode || "error"}: ${err.errorMessage}`;
    } catch { debug.log('Error body was not JSON — using HTTP status only'); }
    throw new Error(`Epic token endpoint rejected request: ${detail}`);
  }

  const payload = await response.json();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accountId: payload.account_id,
    displayName: payload.displayName,
    expiresAt: payload.expires_at,
    refreshExpiresAt: payload.refresh_expires_at,
  };
}

export async function exchangeCode(code) {
  return postToken({
    grant_type: "authorization_code",
    code,
    token_type: "eg1",
  });
}

export async function refreshToken(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    token_type: "eg1",
  });
}

export function isTokenExpired(tokens, thresholdMs = REFRESH_THRESHOLD_MS) {
  if (!tokens?.expiresAt) return true;
  const expiresMs = Date.parse(tokens.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs - Date.now() < thresholdMs;
}

export function validateTokens(tokens) {
  return !!(tokens?.accessToken && tokens?.refreshToken && tokens?.accountId);
}
