// Zero-dependency control page (single HTML string) served on GET / from the
// bridge itself. Loopback-only by construction: the server binds 127.0.0.1 and
// the handler re-checks the remote address.
//
// Account endpoints (/health, /internal/*) require the API key, so the server
// injects it into the page at render time via the __KEY__ placeholder. Without
// CORS headers a malicious web page can neither read this HTML cross-origin
// nor send the Authorization header cross-origin (preflight fails), so the
// injected key does not leak beyond the local machine.
//
// Flow: the page shows token state; "Renew token" POSTs /internal/login, which
// opens the Qoder approval page in a NEW browser tab; the page polls
// /internal/login-status every 2s and turns green on success. The token is
// hot-reloaded by the auth layer, no restart needed.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qoder-bridge</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  main { max-width: 560px; margin: 8vh auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8f98; font-size: 13px; margin-bottom: 24px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 18px 20px; margin-bottom: 14px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 5px 0; font-size: 14px; }
  .k { color: #8a8f98; flex-shrink: 0; }
  .v { text-align: right; word-break: break-all; }
  .ok { color: #4ade80; } .warn { color: #fbbf24; } .bad { color: #f87171; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #2d6cdf;
           background: #1d4ed8; color: #fff; cursor: pointer; }
  button:hover { background: #1e50c8; }
  button:disabled { opacity: .5; cursor: default; }
  #msg { margin-top: 12px; font-size: 14px; min-height: 20px; }
  .spin { display: inline-block; animation: r 1s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
  code { background: #232833; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>qoder-bridge</h1>
  <div class="sub">OpenAI-compatible bridge &middot; 127.0.0.1:9528</div>

  <div class="card">
    <div class="row"><span class="k">State</span><span class="v" id="state">loading...</span></div>
    <div class="row"><span class="k">Account</span><span class="v" id="account">-</span></div>
    <div class="row"><span class="k">Token</span><span class="v" id="token">-</span></div>
    <div class="row"><span class="k">Expires</span><span class="v" id="expires">-</span></div>
    <div class="row"><span class="k">Base URL</span><span class="v"><code>http://127.0.0.1:9528/v1</code></span></div>
    <div class="row"><span class="k">API key</span><span class="v"><code>see server log / .env equivalent</code></span></div>
  </div>

  <div class="card">
    <button id="renew">Renew token (browser approval)</button>
    <div id="msg"></div>
  </div>

  <div class="sub">Start / stop the service with start.vbs / stop.vbs in the project folder. This page is only reachable from this machine.</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const KEY = '__KEY__';
const authHeaders = () => ({ authorization: 'Bearer ' + KEY });
let polling = null;

function daysLeft(s) {
  const m = /\\((\\d+)d\\)/.exec(s || '');
  return m ? parseInt(m[1], 10) : null;
}

async function refresh() {
  try {
    const r = await fetch('/health', { headers: authHeaders() });
    if (r.status === 403) throw new Error('forbidden');
    const j = await r.json();
    const a = j.auth || {};
    $('state').textContent = j.ok ? 'running' : 'no token';
    $('state').className = 'v ' + (j.ok ? 'ok' : 'bad');
    $('account').textContent = a.email || '-';
    $('token').textContent = a.token || '-';
    const d = daysLeft(a.expires);
    const cls = d === null ? '' : d <= 3 ? 'bad' : d <= 10 ? 'warn' : 'ok';
    $('expires').textContent = a.expires || '-';
    $('expires').className = 'v ' + cls;
  } catch {
    $('state').textContent = 'unreachable';
    $('state').className = 'v bad';
  }
}

async function pollLogin() {
  for (;;) {
    const r = await fetch('/internal/login-status', { headers: authHeaders() });
    const j = await r.json();
    if (j.active) {
      $('msg').innerHTML = '<span class="spin">&#8635;</span> waiting for your approval in the browser tab...';
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    if (j.done) {
      $('msg').innerHTML = '<span class="ok">&#10003; Token updated. Valid until ' + j.done.expires + ' (' + j.done.email + ').</span>';
      await refresh();
    } else if (j.error) {
      $('msg').innerHTML = '<span class="bad">&#10007; ' + j.error + '</span>';
    }
    return;
  }
}

$('renew').onclick = async () => {
  $('renew').disabled = true;
  $('msg').textContent = '';
  try {
    const r = await fetch('/internal/login', { method: 'POST', headers: authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) {
      $('msg').textContent = 'A login is already in progress...';
    } else if (!r.ok) {
      $('msg').innerHTML = '<span class="bad">&#10007; ' + (j.error || 'failed to start login') + '</span>';
      $('renew').disabled = false;
      return;
    } else {
      $('msg').innerHTML = 'Approval page opened in a new browser tab. Approve the login there.';
    }
    await pollLogin();
  } catch (e) {
    $('msg').innerHTML = '<span class="bad">&#10007; ' + e.message + '</span>';
  }
  $('renew').disabled = false;
};

refresh();
</script>
</body>
</html>`;

export function controlPageHandler(req, res, send, apiKey) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  // split/join instead of replace(): a replacement string containing "$&"
  // would otherwise be interpreted as a pattern. Escape HTML-significant
  // characters so a key with quotes or angle brackets cannot break the page.
  const safeKey = String(apiKey).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const body = PAGE.split('__KEY__').join(safeKey).replace(/\n/g, '\r\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
  return true;
}
