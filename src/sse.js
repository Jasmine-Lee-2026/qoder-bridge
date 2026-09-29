// Upstream SSE reassembly.
//
// Two defects in the raw upstream stream are handled here:
//
//  1. JSON string literals contain UNESCAPED control characters, so a data line
//     can carry raw newlines. Splitting on '\n' corrupts frames; splitting on
//     '\n\n' is also wrong when the payload itself contains a blank line.
//  2. The stream can be cut off mid-frame. Forwarding that partial frame makes
//     the client fail with "Unexpected end of JSON input" (observed in Cline).
//
// Strategy: split on the blank-line boundary, then judge frames by parseability.
// Consecutive unparseable fragments are re-joined (they were one JSON value cut
// in half by a raw blank line). Every frame that survives is re-serialized, so
// what reaches the client is always valid JSON. A truncated tail is dropped and
// the stream is always terminated with [DONE].

export function repairJson(text) {
  const t = String(text || '').trim();
  if (!t || t === '[DONE]') return null;
  try {
    return JSON.parse(t);
  } catch { /* fall through */ }
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      if (c.charCodeAt(0) < 0x20) { out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += c;
      continue;
    }
    if (c === '"') { out += c; inStr = true; continue; }
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// data lines of one SSE frame, joined the way the spec says.
export function frameData(frame) {
  const parts = [];
  for (const line of String(frame).split('\n')) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!l.startsWith('data:')) continue;
    let v = l.slice(5);
    if (v.startsWith(' ')) v = v.slice(1);
    parts.push(v);
  }
  return parts.join('\n');
}

function payloadOf(text) {
  const data = frameData(text).trim();
  if (!data) return null;
  if (data === '[DONE]') return '[DONE]';
  // A well-formed frame parses as-is; otherwise try each data line separately
  // (covers a frame whose lines were joined by the spec but are individual JSON).
  const direct = repairJson(data);
  if (direct) return `data: ${JSON.stringify(direct)}`;
  for (const line of data.split('\n')) {
    const o = repairJson(line);
    if (o) return `data: ${JSON.stringify(o)}`;
  }
  return null;
}

// Yields normalized frames: either 'data: {"...valid JSON..."}' or '[DONE]'.
// onDrop(text, reason) is called whenever a frame cannot be used, so the
// caller can log exactly what was thrown away.
export async function* sseChunks(reader, onDrop) {
  const dec = new TextDecoder();
  let carry = '';
  let pending = '';
  let sawDone = false;

  const emit = (text) => {
    const frame = payloadOf(text);
    return frame;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });

    let i;
    while ((i = carry.indexOf('\n\n')) >= 0) {
      const raw = carry.slice(0, i);
      carry = carry.slice(i + 2);

      const data = frameData(raw).trim();
      if (!data) { pending = ''; continue; } // keep-alive / blank event

      if (data === '[DONE]') { pending = ''; sawDone = true; yield '[DONE]'; continue; }

      const frame = emit(raw);
      if (frame) {
        if (pending && onDrop) onDrop(pending, 'discarded: next frame parsed standalone');
        pending = '';
        yield frame;
        continue;
      }

      // Unparseable on its own: probably one JSON value split by a raw blank
      // line inside a string literal. Re-join and retry.
      pending = pending ? `${pending}\n\n${raw}` : raw;
      const rejoined = emit(pending);
      if (rejoined) { pending = ''; yield rejoined; }
    }
  }

  carry += dec.decode();
  const tail = carry.trim();
  if (tail) {
    const candidate = pending ? `${pending}\n\n${carry}` : carry;
    const frame = emit(candidate) || emit(carry);
    if (frame === '[DONE]') { sawDone = true; yield '[DONE]'; }
    else if (frame) yield frame;
    else if (onDrop) onDrop(carry, 'unparsable tail at end of stream');
  }

  if (pending && onDrop) onDrop(pending, 'unjoined fragments discarded');
  pending = '';
  if (!sawDone) yield '[DONE]';
}
