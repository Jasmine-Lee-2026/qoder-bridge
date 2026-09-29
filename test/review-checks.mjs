// Follow-up checks for the review fixes:
//  1. legacy alias request still routes and answers with the public name
//  2. every streamed frame echoes the public model id (never the internal key)
//  3. stream default: absent `stream` field must return a non-stream JSON body
//  4. unknown model falls back to default instead of erroring
const BASE = 'http://127.0.0.1:9528/v1/chat/completions';
const KEY = 'sk-qoder-bridge-local-2026';

function headers() {
  return { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
}

// 1+2. legacy alias, streaming: check every frame's model field
{
  const r = await fetch(BASE, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: 'gmodel',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: ALIAS-STREAM-OK' }],
    }),
  });
  const text = await r.text();
  const frames = text.split('\n\n').filter((f) => f.startsWith('data:') && f !== 'data: [DONE]');
  let badModel = 0;
  let content = '';
  for (const f of frames) {
    const j = JSON.parse(f.slice(5));
    if (j.model !== 'glm-5.3') { badModel++; console.log(`  BAD MODEL FIELD: ${j.model}`); }
    content += j.choices?.[0]?.delta?.content || '';
  }
  console.log(`1. ALIAS stream      frames=${frames.length} bad_model=${badModel} content=${JSON.stringify(content.trim())}`);
}

// 2. new id streaming
{
  const r = await fetch(BASE, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: DS-OK' }],
    }),
  });
  const text = await r.text();
  const frames = text.split('\n\n').filter((f) => f.startsWith('data:') && f !== 'data: [DONE]');
  let badModel = 0;
  let content = '';
  for (const f of frames) {
    const j = JSON.parse(f.slice(5));
    if (j.model !== 'deepseek-v4-pro') badModel++;
    content += j.choices?.[0]?.delta?.content || '';
  }
  console.log(`2. NEW ID stream     frames=${frames.length} bad_model=${badModel} content=${JSON.stringify(content.trim())}`);
}

// 3. absent stream field -> non-stream JSON (OpenAI default)
{
  const r = await fetch(BASE, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: 'lite', messages: [{ role: 'user', content: 'Reply with exactly: NOSTREAM-OK' }] }),
  });
  const ct = r.headers.get('content-type') || '';
  const j = await r.json();
  const isBody = j.object === 'chat.completion' && j.choices?.[0]?.message?.content;
  console.log(`3. DEFAULT non-stream content-type=${ct.includes('json') ? 'json' : ct} object=${j.object} content=${JSON.stringify(j.choices?.[0]?.message?.content)} ok=${!!isBody}`);
}

// 4. unknown model -> falls back to default, does not error; also check a
//    catalog-only model is accepted locally (forwarded upstream)
{
  const r = await fetch(BASE, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: 'totally-unknown-model', stream: false, messages: [{ role: 'user', content: 'Reply with exactly: FALLBACK-OK' }] }),
  });
  const j = await r.json();
  console.log(`4. UNKNOWN model     status=${r.status} model=${j.model} content=${JSON.stringify(j.choices?.[0]?.message?.content)}`);

  const r2 = await fetch(BASE, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: 'glm-5.3-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log(`5. CATALOG-ONLY id   status=${r2.status} (upstream verdict passed through, not a local 400)`);
}
