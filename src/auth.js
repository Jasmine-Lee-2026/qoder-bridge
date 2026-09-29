// Token store for the Qoder api2-v2 endpoint.
//
// Three sources, tried in order:
//   1. our own auth file    ~/.qoder-bridge/auth.json   (authoritative once seeded)
//   2. seed from cliproxy   ~/.cli-proxy-api/qoder-*.json  (one-time migration only)
//   3. device-flow login    npm run login  (opens the browser, polls for the token)
//
// Refresh: POST https://center.qoder.sh/algo/api/v3/user/refresh_token
// Note this route is currently gateway-blocked (403 "Request discarded") for
// this account, so a re-login via the device flow is the practical renewal path
// (tokens live ~30 days).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const CHAT_URL = 'https://api2-v2.qoder.sh/model/v1/chat/completions';
const POLL_URL = 'https://openapi.qoder.sh/api/v1/deviceToken/poll';
const LOGIN_URL = 'https://qoder.com/device/selectAccounts';
const REFRESH_URL = 'https://center.qoder.sh/algo/api/v3/user/refresh_token';
const USERINFO_URL = 'https://openapi.qoder.sh/api/v1/userinfo';

export const AUTH_FILE =
  process.env.QODER_AUTH_FILE || path.join(os.homedir(), '.qoder-bridge', 'auth.json');

const REFRESH_WINDOW_DAYS = Number(process.env.QODER_REFRESH_WINDOW_DAYS || 3);
const UA = process.env.QODER_UA || 'qoder/1.1.41';

let cache = null;
let inflight = null;
// verifiedToken: last token that passed userinfo verification, with a short
// TTL so one verification round-trip is shared across bursts of requests.
let verified = { token: null, until: 0 };
const VERIFY_TTL_MS = 60_000;

function log(...a) {
  console.log(new Date().toISOString(), '[auth]', ...a);
}

// Display form of the account email: keep the first character and the domain,
// mask the rest. The real value stays in auth.json only.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 0) return s;
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  const dir = path.dirname(AUTH_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2));
  fs.renameSync(tmp, AUTH_FILE);
  cache = auth;
}

// --- source 2: one-time seed from the cliproxy auth file ---------------------
function findCliproxyAuth() {
  const dir = path.join(os.homedir(), '.cli-proxy-api');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^qoder-.*\.json$/.test(name)) continue;
    const j = readJson(path.join(dir, name));
    if (j && j.token) return { file: path.join(dir, name), json: j };
  }
  return null;
}

function seedFromCliproxy() {
  const found = findCliproxyAuth();
  if (!found) return false;
  const src = found.json;
  saveAuth({
    version: 1,
    token: src.token,
    refresh_token: src.refresh_token || '',
    user_id: src.user_id || '',
    name: src.name || '',
    email: src.email || '',
    machine_id: src.machine_id || '',
    auth_mode: src.auth_mode || 'device-token',
    expire_time: Number(src.expire_time) || 0,
    refresh_token_expire_time: Number(src.refresh_token_expire_time) || 0,
    last_refresh: new Date().toISOString(),
    seeded_from: found.file,
    model_configs: src.model_configs || undefined,
  });
  log(`seeded from ${found.file} (token expires ${expiresIn(cache.expire_time)})`);
  return true;
}

function expiresIn(ms) {
  if (!ms) return 'unknown';
  const d = new Date(Number(ms));
  const days = Math.round((Number(ms) - Date.now()) / 86400000);
  return `${d.toISOString().slice(0, 10)} (${days}d)`;
}

export function loadAuth() {
  if (cache) return cache;
  const own = readJson(AUTH_FILE);
  if (own && own.token) {
    cache = own;
    return cache;
  }
  if (seedFromCliproxy()) return cache;
  return null;
}

export function authInfo() {
  const a = loadAuth();
  if (!a) return { present: false };
  return {
    present: true,
    file: AUTH_FILE,
    email: maskEmail(a.email),
    seeded_from: a.seeded_from || null,
    token: a.token.slice(0, 6) + '...' + a.token.slice(-4),
    expires: expiresIn(a.expire_time),
    refresh_expires: expiresIn(a.refresh_token_expire_time),
    modelConfigs: a.model_configs || null,
  };
}

function isUsable(a) {
  if (!a || !a.token) return false;
  if (!a.expire_time) return true; // unknown expiry: optimistically usable
  return Date.now() < Number(a.expire_time) - REFRESH_WINDOW_DAYS * 86400000;
}

async function verify(token) {
  try {
    const r = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UA },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Best-effort refresh. Currently the gateway answers 403 for this route, so a
// failure is not fatal: the caller falls back to asking for a device re-login.
export async function refresh() {
  const a = loadAuth();
  if (!a) throw new Error('no auth file; run: npm run login');
  if (!a.refresh_token) throw new Error('no refresh token; run: npm run login');

  const r = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${a.token}`,
      accept: 'application/json',
      'user-agent': UA,
    },
    body: JSON.stringify({ refreshToken: a.refresh_token }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`refresh rejected: HTTP ${r.status} ${text.slice(0, 160)}`);
  }
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`refresh returned non-JSON: ${text.slice(0, 160)}`);
  }
  const token = j.token || j.access_token || j.device_token;
  if (!token) throw new Error('refresh returned no token');
  saveAuth({
    ...a,
    token,
    refresh_token: j.refreshToken || j.refresh_token || a.refresh_token,
    expire_time: j.expiresAt
      ? Date.parse(j.expiresAt)
      : j.expiresIn
        ? Date.now() + Number(j.expiresIn) * 1000
        : a.expire_time,
    last_refresh: new Date().toISOString(),
  });
  log('refreshed; token now expires', expiresIn(cache.expire_time));
  return cache;
}

// Returns a usable access token, refreshing or re-seeding as needed.
export async function getToken() {
  if (inflight) return inflight;
  inflight = (async () => {
    let a = loadAuth();
    if (!a) {
      if (!seedFromCliproxy()) {
        throw Object.assign(new Error('not authenticated - run: npm run login'), { status: 401 });
      }
      a = cache;
    }
    if (verified.token === a.token && Date.now() < verified.until) return a.token;
    if (isUsable(a) && (await verify(a.token))) {
      verified = { token: a.token, until: Date.now() + VERIFY_TTL_MS };
      return a.token;
    }

    log('access token stale, refreshing');
    try {
      await refresh();
    } catch (e) {
      const detail = String(e.message || e);
      cache = null;
      const seeded = seedFromCliproxy();
      if (seeded && isUsable(cache) && (await verify(cache.token))) {
        verified = { token: cache.token, until: Date.now() + VERIFY_TTL_MS };
        log('recovered from cliproxy seed after refresh failure');
        return cache.token;
      }
      throw Object.assign(
        new Error(`token expired and refresh failed (${detail}). Re-login: npm run login`),
        { status: 401 }
      );
    }
    verified = { token: cache.token, until: Date.now() + VERIFY_TTL_MS };
    return cache.token;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// --- device flow login -------------------------------------------------------
// Login state is global so the control page can poll it. CLI login and
// web-triggered login share this state machine.
export const loginState = {
  active: false,
  startedAt: 0,
  expiresAt: 0, // deadline of the pending login
  error: null,
  done: null, // { email, expires } on success
};

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function openBrowser(url) {
  // Not "cmd /c start": cmd splits the URL at every '&' and the browser would
  // receive a truncated login link. rundll32 takes the URL as one argument and
  // no shell is involved.
  const cmd = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

export async function deviceLogin({ timeoutMs = 180000, openUrl = true } = {}) {
  if (loginState.active) throw Object.assign(new Error('login already in progress'), { status: 409 });
  const { verifier, challenge } = pkce();
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  const loginUrl = `${LOGIN_URL}?challenge=${encodeURIComponent(challenge)}&challenge_method=S256&machine_id=${encodeURIComponent(machineId)}&nonce=${encodeURIComponent(nonce)}`;

  loginState.active = true;
  loginState.startedAt = Date.now();
  loginState.expiresAt = Date.now() + timeoutMs;
  loginState.error = null;
  loginState.done = null;

  try {
    console.log('\n  1. Open this URL in your browser and approve the login:\n');
    console.log('     ' + loginUrl + '\n');
    if (openUrl) openBrowser(loginUrl);
    console.log('  2. Waiting for approval (up to 3 minutes)...\n');

    const poll = `${POLL_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
    const deadline = loginState.expiresAt;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let r;
      try {
        r = await fetch(poll, { headers: { accept: 'application/json', 'user-agent': UA } });
      } catch {
        continue; // transient network error: keep polling
      }
      if (r.status === 202 || r.status === 404) continue; // pending
      const text = await r.text();
      if (!r.ok) throw new Error(`device poll failed: HTTP ${r.status} ${text.slice(0, 200)}`);
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        continue;
      }
      if (!j.token) continue;

      let name = '';
      let email = '';
      try {
        const u = await fetch(USERINFO_URL, {
          headers: { authorization: `Bearer ${j.token}`, accept: 'application/json', 'user-agent': UA },
        });
        if (u.ok) {
          const uj = await u.json();
          name = uj.name || '';
          email = uj.email || '';
        }
      } catch { /* non-fatal */ }

      saveAuth({
        version: 1,
        token: j.token,
        refresh_token: j.refresh_token || '',
        user_id: j.user_id || '',
        name,
        email,
        machine_id: machineId,
        auth_mode: 'device-token',
        expire_time: j.expires_at
          ? Date.parse(j.expires_at)
          : j.expires_in
            ? Date.now() + Number(j.expires_in) * 1000
            : Date.now() + 30 * 86400000,
        refresh_token_expire_time: j.refresh_token_expires_at
          ? Date.parse(j.refresh_token_expires_at)
          : j.refresh_token_expires_in
            ? Date.now() + Number(j.refresh_token_expires_in) * 1000
            : 0,
        last_refresh: new Date().toISOString(),
      });
      loginState.done = { email: maskEmail(email || name || 'unknown account'), expires: expiresIn(cache.expire_time) };
      log(`login OK: ${loginState.done.email}; token expires ${loginState.done.expires}`);
      return cache;
    }
    throw new Error('login timed out; run: npm run login again');
  } catch (e) {
    loginState.error = String(e.message || e);
    throw e;
  } finally {
    loginState.active = false;
  }
}
