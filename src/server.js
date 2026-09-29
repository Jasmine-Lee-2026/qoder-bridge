// OpenAI-compatible server in front of the Qoder api2-v2 endpoint.
//
// Differences from the upstream wire format are deliberate:
//   - every forwarded SSE frame is re-serialized, so clients never see the raw
//     control characters the upstream leaves unescaped inside JSON strings;
//   - transitive upstream failures (10605 queue, "All models failed") are waited
//     out with a bounded backoff instead of being surfaced as an error;
//   - a stream cut mid-frame is closed cleanly with [DONE].

import http from 'node:http';
import crypto from 'node:crypto';
import { CHAT_URL, AUTH_FILE, authInfo, getToken, deviceLogin, loginState } from './auth.js';
import { listModels, resolveModel, upstreamKey } from './models.js';
import { sseChunks, repairJson } from './sse.js';
import { controlPageHandler } from './control.js';

const PORT = Number(process.env.QODER_PORT || 9528);
const HOST = process.env.QODER_HOST || '127.0.0.1';
const API_KEY = process.env.QODER_API_KEY || 'sk-qoder-bridge-local-2026';
const DEBUG = !!process.env.QODER_DEBUG;

const MAX_RETRIES = Number(process.env.QODER_MAX_RETRIES || 5);
const QUEUE_MAX_WAIT = Number(process.env.QODER_QUEUE_MAX_WAIT || 20);

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(5000, 800 * Math.pow(1.6, n));
const nowSec = () => Math.floor(Date.now() / 1000);

// Diagnostics for the SSE layer: log everything that cannot be forwarded.
function sseDrop(text, why) {
  const flat = String(text).replace(/\n/g, '\\n').slice(0, 140);
  log(`sse drop (${why}): ${flat}`);
}

const QUEUE_RE = /10605|isQueued|serviceAvailable/i;
const TRANSIENT_RE = /all models failed|upstream|temporar|timeout|timed out|overloaded|rate.?limit|5\d\d/i;
const FATAL_RE = /not allowed|permission|denied|unauthor|invalid_model|unsupported|invalid_request/i;

function looksLikeQueue(text) {
  return QUEUE_RE.test(String(text || ''));
}

function retryable(msg) {
  const m = String(msg || '');
  if (FATAL_RE.test(m)) return false;
  return TRANSIENT_RE.test(m);
}

// Upstream signals errors two ways: an OpenAI-style {"error":{...}} chunk and
// an SSE "event: error" frame whose payload is flat ({code, message, type}).
// Both must be recognized, or the failure turns into an empty 200 success.
function errChunk(text) {
  const o = repairJson(text);
  if (!o) return null;
  if (o.error && o.error.message) return { code: o.error.code || 'error', message: o.error.message };
  if (o.message && (o.type || o.code) && !o.choices && !o.id) {
    return { code: o.code || o.type || 'error', message: o.message };
  }
  return null;
}

function toolDelta(toolCalls, acc) {
  for (const tc of toolCalls) {
    const i = Number.isInteger(tc.index) ? tc.index : acc.length;
    while (acc.length <= i) acc.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
    const t = acc[i];
    if (typeof tc.id === 'string' && tc.id) t.id = tc.id;
    if (typeof tc.type === 'string' && tc.type) t.type = tc.type;
    const f = tc.function || {};
    if (typeof f.name === 'string') t.function.name += f.name;
    if (typeof f.arguments === 'string') t.function.arguments += f.arguments;
  }
}

function finalize(id, created, model, content, toolAcc, names, usage) {
  const toolCalls = toolAcc
    .filter((t) => t.function.name || t.function.arguments)
    .map((t, i) => ({
      id: t.id || `call_${id}_${i}`,
      type: t.type || 'function',
      function: {
        // Backfill a name the upstream never sent when only one tool was offered.
        name: t.function.name || (names && names.length === 1 ? names[0] : ''),
        arguments: t.function.arguments || '{}',
      },
    }));
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length ? (content || null) : content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function callUpstream(body, token) {
  return fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': process.env.QODER_UA || 'qoder/1.1.41',
    },
    body: JSON.stringify(body),
  });
}

// Rewrites the client's public model id to the endpoint's internal key.
// Catalog-only models are forwarded as-is: if the upstream rejects them the
// error is passed through, and when it starts routing them this needs no change.
function buildUpstreamBody(clientBody) {
  const { key, known } = resolveModel(clientBody.model);
  const upstream = upstreamKey(key) || key;
  const out = { ...clientBody, model: upstream, stream: true };
  delete out.stream_options;
  if (!known && DEBUG) log(`unknown model "${clientBody.model}" -> ${key}`);
  if (upstream !== String(clientBody.model || '').toLowerCase() && DEBUG) {
    log(`model ${clientBody.model} -> ${upstream}`);
  }
  return { out, publicModel: key };
}

// Tool names the client declared, used to backfill an upstream omission.
function declaredNames(body) {
  const out = [];
  for (const t of (body && body.tools) || []) {
    const n = t.function && t.function.name;
    if (n) out.push(n);
  }
  return out;
}

function hasToolName(tc) {
  return !!(tc && tc.function && tc.function.name);
}

function toolCallsOf(chunk) {
  const out = [];
  for (const ch of (chunk && chunk.choices) || []) {
    for (const tc of (ch.delta && ch.delta.tool_calls) || []) out.push(tc);
  }
  return out;
}

// Upstream occasionally drops the first delta of a tool call (the one carrying
// the function name), which leaves the client with a nameless tool call. When
// the caller declared exactly one tool we can reconstruct it; otherwise the
// stream ends with a single plain-text notice so the turn still completes.
function patchToolNames(frame, names) {
  if (names.length !== 1) return null; // ambiguous: never guess
  const o = repairJson(frame.slice(5).trim());
  if (!o) return null;
  let changed = false;
  for (const tc of toolCallsOf(o)) {
    if (!hasToolName(tc) && tc.function) { tc.function.name = names[0]; changed = true; }
  }
  return changed ? `data: ${JSON.stringify(o)}` : null;
}

function noticeFrame(text, id, created, model) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}`;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const remote = req.socket.remoteAddress || '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Local control page and its login endpoints - loopback only.
    if (url.pathname === '/' && req.method === 'GET') {
      if (!loopback) { sendJSON(res, 403, { error: { message: 'loopback only', type: 'forbidden' } }); return; }
      controlPageHandler(req, res, sendJSON);
      return;
    }
    if (url.pathname === '/internal/login' && req.method === 'POST') {
      if (!loopback) { sendJSON(res, 403, { error: { message: 'loopback only', type: 'forbidden' } }); return; }
      // The approval page must open in the user's browser; the control page
      // itself stays interactive, so the device URL is opened as a new tab.
      deviceLogin({ timeoutMs: 180000, openUrl: true }).catch((e) => {
        log('login failed:', String(e.message || e));
      });
      sendJSON(res, 202, { started: true });
      return;
    }
    if (url.pathname === '/internal/login-status' && req.method === 'GET') {
      if (!loopback) { sendJSON(res, 403, { error: { message: 'loopback only', type: 'forbidden' } }); return; }
      sendJSON(res, 200, {
        active: loginState.active,
        error: loginState.error,
        done: loginState.done,
        startedAt: loginState.startedAt,
        expiresAt: loginState.expiresAt,
      });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const info = authInfo();
      sendJSON(res, 200, {
        object: 'list',
        data: listModels(info.modelConfigs),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const info = authInfo();
      const { modelConfigs, ...rest } = info; // keep /health compact
      sendJSON(res, info.present ? 200 : 503, { ok: !!info.present, auth: rest });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      if (!checkAuth(req)) {
        sendJSON(res, 401, { error: { message: 'invalid API key', type: 'auth_error', code: 401 } });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        sendJSON(res, Number(e.status) || 400, { error: { message: String(e.message || e), type: 'bad_request' } });
        return;
      }
      try {
        const token = await getToken();
        const { out: upstreamBody, publicModel } = buildUpstreamBody(body);
        // OpenAI semantics: stream defaults to false when absent.
        if (body.stream) await handleStream(res, upstreamBody, token, publicModel);
        else await handleNonStream(res, upstreamBody, token, publicModel);
      } catch (e) {
        const status = Number(e.status) || 502;
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ error: { message: String(e.message || e), type: 'server_error', code: status } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendJSON(res, status, { error: { message: String(e.message || e), type: 'server_error', code: status } });
        }
      }
      return;
    }

    sendJSON(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}`, type: 'not_found' } });
  });
}

// Rewrites the endpoint's internal key back to the client-facing model id in
// a forwarded SSE frame.
function withPublicModel(frame, publicModel) {
  if (!publicModel) return frame;
  const o = repairJson(frame.slice(5).trim());
  if (!o || o.model === publicModel) return frame;
  o.model = publicModel;
  return `data: ${JSON.stringify(o)}`;
}

async function handleStream(res, upstreamBody, token, publicModel) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const started = Date.now();
  const streamId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const streamCreated = nowSec();
  let bytes = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let r;
    try {
      r = await callUpstream(upstreamBody, token);
    } catch (e) {
      writeErr(res, Object.assign(new Error(`upstream unreachable: ${e.message}`), { status: 502 }));
      return;
    }

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const queued = looksLikeQueue(text);
      if ((queued || r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES) {
        const wait = queued ? Math.min(QUEUE_MAX_WAIT, 60) : Math.round(backoff(attempt) / 1000);
        log(`upstream ${r.status} ${queued ? 'queue' : 'transient'} -> wait ${wait}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }
      writeErr(res, Object.assign(new Error(`upstream ${r.status}: ${text.slice(0, 300)}`), { status: r.status }));
      return;
    }

    const reader = r.body.getReader();
    let failed = null;
    let retry = false;
    let wrote = false;

    // Upstream occasionally omits the delta that carries the tool name. While
    // that is unresolved, every frame is held back so a reconstructed name can
    // still be placed ahead of the arguments (clients accumulate in order).
    const names = declaredNames(upstreamBody);
    let sawToolCall = false;
    let nameSeen = false;
    const held = [];

    const flushHeld = (reconstruct) => {
      if (!held.length) return;
      // The name may only be injected into the FIRST held delta: clients
      // concatenate `name` across deltas, so patching every frame would yield
      // "read_fileread_file...".
      const frames = held.splice(0);
      if (reconstruct && names.length !== 1) {
        // Unreachable via call sites today (reconstruct implies one tool), kept
        // as a guard: say why instead of forwarding silently broken deltas.
        res.write(noticeFrame('[tool call dropped: upstream never sent the function name]', streamId, streamCreated, publicModel) + '\n\n');
        wrote = true;
      }
      if (reconstruct === false && frames.some((f) => f.includes('"tool_calls"'))) {
        // Multi-tool: the name cannot be reconstructed, so the forwarded tool
        // call will have an empty name. Warn before it, then forward anyway.
        res.write(noticeFrame('[warning: upstream omitted the tool name; the tool call below may have an empty name]', streamId, streamCreated, publicModel) + '\n\n');
        wrote = true;
      }
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const patched = reconstruct && i === 0 ? patchToolNames(f, names) : null;
        if (patched) { res.write(withPublicModel(patched, publicModel) + '\n\n'); wrote = true; continue; }
        res.write(withPublicModel(f, publicModel) + '\n\n');
        wrote = true;
      }
    };

    for await (const frame of sseChunks(reader, sseDrop)) {
      if (frame === '[DONE]') {
        flushHeld(names.length === 1);
        res.write('data: [DONE]\n\n');
        wrote = true;
        break;
      }
      const payload = frame.slice(5).trim();
      if (looksLikeQueue(payload) && attempt < MAX_RETRIES && !wrote && !held.length) {
        // Nothing has reached the client yet, so a retry stays invisible.
        log('in-stream queue signal -> waiting');
        await reader.cancel().catch(() => {});
        await sleep(2000);
        retry = true;
        break;
      }
      const err = errChunk(payload);
      if (err) { failed = err; break; }

      const tcs = toolCallsOf(repairJson(payload));
      if (tcs.length) {
        sawToolCall = true;
        if (tcs.some(hasToolName)) nameSeen = true;
      }

      if (sawToolCall && !nameSeen) { held.push(frame); continue; }
      // The name (if any) is already in the stream, so never reconstruct here.
      flushHeld(false);

      wrote = true;
      res.write(withPublicModel(frame, publicModel) + '\n\n');
      bytes += frame.length;
    }

    try { await reader.cancel(); } catch { /* ignore */ }

    flushHeld(names.length === 1);

    if (failed) {
      // Retrying after content was already streamed would duplicate it, so a
      // transient failure mid-stream is surfaced instead of retried.
      if (!wrote && !held.length && retryable(failed.message) && attempt < MAX_RETRIES) {
        const wait = backoff(attempt);
        log(`transient ${failed.code} -> retry in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      writeErr(res, Object.assign(new Error(`upstream ${failed.code}: ${failed.message}`), { status: 502 }));
      return;
    }
    if (retry) continue;
    if (!wrote) res.write('data: [DONE]\n\n');
    res.end();
    if (DEBUG) log(`stream done: ${bytes}B in ${Date.now() - started}ms`);
    return;
  }
  res.end();
}

async function handleNonStream(res, upstreamBody, token, publicModel) {
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = nowSec();
  const model = publicModel || upstreamBody.model;
  let content = '';
  let usage = null;
  const toolAcc = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let r;
    try {
      r = await callUpstream(upstreamBody, token);
    } catch (e) {
      writeErr(res, Object.assign(new Error(`upstream unreachable: ${e.message}`), { status: 502 }));
      return;
    }

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const queued = looksLikeQueue(text);
      if ((queued || r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES) {
        const wait = queued ? Math.min(QUEUE_MAX_WAIT, 60) : Math.round(backoff(attempt) / 1000);
        log(`upstream ${r.status} ${queued ? 'queue' : 'transient'} -> wait ${wait}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }
      writeErr(res, Object.assign(new Error(`upstream ${r.status}: ${text.slice(0, 300)}`), { status: r.status }));
      return;
    }

    const reader = r.body.getReader();
    let failed = null;
    let retry = false;

    for await (const frame of sseChunks(reader, sseDrop)) {
      if (frame === '[DONE]') continue;
      const payload = frame.slice(5).trim();
      if (looksLikeQueue(payload) && attempt < MAX_RETRIES) {
        log('in-stream queue signal -> waiting');
        await reader.cancel().catch(() => {});
        await sleep(2000);
        retry = true;
        break;
      }
      const err = errChunk(payload);
      if (err) { failed = err; break; }
      const o = repairJson(payload);
      if (!o) continue;
      if (o.usage) usage = o.usage;
      for (const ch of o.choices || []) {
        const d = ch.delta || {};
        if (typeof d.content === 'string') content += d.content;
        if (Array.isArray(d.tool_calls)) toolDelta(d.tool_calls, toolAcc);
      }
    }

    try { await reader.cancel(); } catch { /* ignore */ }

    if (failed) {
      if (retryable(failed.message) && attempt < MAX_RETRIES) {
        const wait = backoff(attempt);
        log(`transient ${failed.code} -> retry in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      writeErr(res, Object.assign(new Error(`upstream ${failed.code}: ${failed.message}`), { status: 502 }));
      return;
    }
    if (retry) continue;
    break;
  }

  sendJSON(res, 200, finalize(id, created, model, content, toolAcc, declaredNames(upstreamBody), usage));
}

function writeErr(res, e) {
  const code = Number(e.status) || 500;
  const msg = String(e.message || e);
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'server_error', code } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    sendJSON(res, code, { error: { message: msg, type: 'server_error', code } });
  }
}

function sendJSON(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const a = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(a);
  return !!m && m[1] === API_KEY;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      chunks.push(c);
      len += c.length;
      if (len > 40_000_000) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('invalid JSON: ' + e.message), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function start() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    log(`qoder-bridge listening on http://${HOST}:${PORT}/v1`);
    log(`  endpoint : ${CHAT_URL}`);
    log(`  auth file: ${AUTH_FILE}`);
    log(`  api key  : ${API_KEY}`);
    log(`  models   : ${listModels().map((m) => m.id).join(', ')}`);
    const info = authInfo();
    if (info.present) {
      log(`  account  : ${info.email || 'unknown'}  token ${info.token}  expires ${info.expires}`);
      if (info.seeded_from) log(`  (seeded from ${info.seeded_from} - safe to remove cliproxy)`);
    } else {
      log(`  account  : MISSING - run "npm run login"`);
    }
  });
  return server;
}
