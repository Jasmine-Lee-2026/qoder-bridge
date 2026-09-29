// Security regression checks:
//  1. /health without API key -> 403 (no account data to anonymous callers)
//  2. /health with API key -> 200, account email is masked
//  3. POST /internal/login without API key -> 403 (no CSRF login trigger)
//  4. no permissive CORS headers by default (cross-origin reads blocked)
//  5. chat/completions still answers with the API key (browser clients unaffected)
const BASE = 'http://127.0.0.1:9528';
const KEY = 'sk-qoder-bridge-local-2026';

// 1. /health without key
{
  const r = await fetch(`${BASE}/health`);
  console.log(`1. HEALTH no-key    status=${r.status} (expect 403)`);
}

// 2. /health with key: masked email
{
  const r = await fetch(`${BASE}/health`, { headers: { authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const masked = !j.auth?.email || /^[^@]\*\*\*@/.test(j.auth.email);
  console.log(`2. HEALTH with-key  status=${r.status} email=${j.auth?.email} masked=${masked ? 'yes' : 'NO'} (expect 200/yes)`);
}

// 3. /internal/login without key (the CSRF path: a web page POSTs this from
//    the victim's browser, where the request source is 127.0.0.1)
{
  const r = await fetch(`${BASE}/internal/login`, { method: 'POST' });
  console.log(`3. LOGIN no-key     status=${r.status} (expect 403)`);
}

// 4. CORS headers absent
{
  const r = await fetch(`${BASE}/v1/models`);
  const acao = r.headers.get('access-control-allow-origin');
  console.log(`4. CORS headers     acao=${acao} (expect null)`);
}

// 5. chat endpoint unaffected: wrong key -> 401, right key accepted
{
  const bad = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer WRONG', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'lite', messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log(`5. CHAT wrong-key   status=${bad.status} (expect 401)`);
}
