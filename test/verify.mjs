// Validate the bridge end-to-end: every SSE frame must be valid JSON and the
// stream must terminate cleanly. This reproduces the "JSON parsing failed /
// Unexpected end of JSON input" case that Cline hit at the end of a stream.
const BASE = 'http://127.0.0.1:9528/v1/chat/completions';
const KEY = 'sk-qoder-bridge-local-2026';

async function chat(body) {
  return fetch(BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- 1. streaming: long prose (many newlines) -------------------------------
{
  const r = await chat({
    model: 'auto',
    stream: true,
    messages: [{ role: 'user', content: 'Write a 12-line poem about the sea. One line per line, no markdown.' }],
  });
  const text = await r.text();
  const frames = text.split('\n\n').filter(Boolean);
  let bad = 0;
  let content = '';
  let done = false;
  for (const f of frames) {
    if (!f.startsWith('data:')) { bad++; console.log(`  NON-DATA FRAME: ${JSON.stringify(f.slice(0, 60))}`); continue; }
    const p = f.slice(5).trim();
    if (p === '[DONE]') { done = true; continue; }
    try {
      const j = JSON.parse(p);
      content += j.choices?.[0]?.delta?.content || '';
    } catch (e) {
      bad++;
      console.log(`  INVALID JSON: ${e.message}: ${p.slice(0, 80)}`);
    }
  }
  console.log(`1. STREAM prose      frames=${frames.length} invalid=${bad} terminated=${done} chars=${content.length}`);
  console.log(`   first line: ${JSON.stringify(content.split('\n')[0])}`);
}

// --- 2. streaming: tool call ------------------------------------------------
{
  const r = await chat({
    model: 'auto',
    stream: true,
    messages: [{ role: 'user', content: 'Read package.json with the read_file tool.' }],
    tools: [
      { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'run_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
    ],
  });
  const text = await r.text();
  const frames = text.split('\n\n').filter(Boolean);
  let bad = 0;
  let done = false;
  const toolAcc = [];
  let finish = null;
  for (const f of frames) {
    if (!f.startsWith('data:')) { bad++; continue; }
    const p = f.slice(5).trim();
    if (p === '[DONE]') { done = true; continue; }
    try {
      const j = JSON.parse(p);
      const c = j.choices?.[0];
      if (c?.finish_reason) finish = c.finish_reason;
      for (const tc of c?.delta?.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : toolAcc.length;
        while (toolAcc.length <= i) toolAcc.push({ id: '', name: '', args: '' });
        if (tc.id) toolAcc[i].id = tc.id;
        if (tc.function?.name) toolAcc[i].name += tc.function.name;
        if (tc.function?.arguments) toolAcc[i].args += tc.function.arguments;
      }
    } catch (e) { bad++; console.log(`  INVALID JSON: ${e.message}: ${p.slice(0, 80)}`); }
  }
  console.log(`2. STREAM tool call  frames=${frames.length} invalid=${bad} terminated=${done} finish=${finish}`);
  for (const t of toolAcc) console.log(`   -> ${t.name}(${t.args})  valid_json=${(() => { try { JSON.parse(t.args); return true; } catch { return false; } })()}`);
}

// --- 3. non-stream tool call ------------------------------------------------
{
  const r = await chat({
    model: 'performance',
    stream: false,
    messages: [{ role: 'user', content: 'Run the command "pwd" with the run_command tool.' }],
    tools: [{ type: 'function', function: { name: 'run_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } }],
  });
  const j = await r.json();
  const m = j.choices?.[0]?.message || {};
  console.log(`3. NON-STREAM tool   status=${r.status} finish=${j.choices?.[0]?.finish_reason} tools=${(m.tool_calls || []).length}`);
  for (const t of m.tool_calls || []) console.log(`   -> ${t.function.name}(${t.function.arguments})`);
}

// --- 4. catalog-only model is forwarded; upstream error passes through ------
{
  const r = await chat({ model: 'qfmodel', stream: false, messages: [{ role: 'user', content: 'hi' }] });
  const j = await r.json();
  const ok = !r.ok && j.error?.message; // any upstream rejection, verbatim
  console.log(`4. CATALOG-ONLY model status=${r.status} forwarded=${ok ? 'yes' : 'NO'} -> ${JSON.stringify(j.error?.message || j).slice(0, 110)}`);
}

// --- 5. auth guard ---------------------------------------------------------
{
  const r = await fetch(BASE, { method: 'POST', headers: { authorization: 'Bearer WRONG', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }) });
  console.log(`5. AUTH guard        status=${r.status} (expect 401)`);
}

// --- 6. plain text ---------------------------------------------------------
{
  const r = await chat({ model: 'lite', stream: false, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] });
  const j = await r.json();
  console.log(`6. PLAIN text        status=${r.status} content=${JSON.stringify(j.choices?.[0]?.message?.content)}`);
}
