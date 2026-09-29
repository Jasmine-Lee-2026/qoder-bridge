# qoder-bridge

A standalone, zero-dependency OpenAI-compatible bridge for the Qoder `api2-v2`
endpoint. Run it on your own machine, point any OpenAI-speaking client at it,
and use the same models the Qoder IDE uses -- with native `tool_calls`, no
queue gate, and a built-in web page for token renewal.

Pure Node.js (>= 20), no npm dependencies, ~1700 lines total.

## Why

Qoder's IDE talks to `api2-v2.qoder.sh` using a plain OpenAI-style protocol.
This bridge speaks that protocol directly instead of shelling through a
multi-platform proxy. Concretely it gives you:

- **Native tool calling** -- upstream returns OpenAI `tool_calls` as-is; the
  bridge does not emulate, merge, or queue them.
- **Honest SSE** -- upstream SSE frames contain raw unescaped newlines inside
  JSON strings; the bridge reassembles frames on blank-line boundaries,
  validates each by parseability, and re-serializes every forwarded frame.
  Truncated tails are dropped and a guaranteed `[DONE]` terminator is sent.
- **Device-flow login** -- a 30-day token obtained through Qoder's official
  device login flow. Refresh via the control page; the new token hot-reloads
  without a restart.
- **Control page** -- `http://127.0.0.1:9528/` shows token state and has a
  "Renew token" button that opens the approval page in a new browser tab.

## Quick start

```bat
git clone https://github.com/Jasmine-Lee-2026/qoder-bridge.git qoder-bridge
cd qoder-bridge
npm start
```

On first start there is no token. Two ways to log in:

- **Web (recommended):** open <http://127.0.0.1:9528/>, click
  **Renew token**, approve in the browser tab that opens.
- **CLI:** `npm run login`

Then point your client (Cline, Cherry Studio, anything OpenAI-compatible) at:

| Setting  | Value                          |
| -------- | ------------------------------ |
| Base URL | `http://127.0.0.1:9528/v1`     |
| API key  | `sk-qoder-bridge-local-2026`   |
| Model    | `auto` (see Models below)      |

## Models

Routed models (mapped to upstream model keys):

| Public id           | Upstream    | Note              |
| ------------------- | ----------- | ----------------- |
| `auto`              | `auto`      | Router            |
| `lite`              | `lite`      | Fast tier         |
| `performance`       | `performance` | Higher tier     |
| `ultimate`          | `ultimate`  | Top tier          |
| `qwen3.7-plus`      | `qmodel`    | Qwen 3.7 Plus     |
| `deepseek-v4-pro`   | `dmodel`    | DeepSeek V4 Pro   |
| `glm-5.3`           | `gmodel`    | GLM 5.3           |
| `kimi-k2.8-preview` | `kmodel`    | Kimi K2.8 preview |
| `minimax-m3`        | `mmodel`    | MiniMax M3        |

Catalog-only models are accepted and forwarded verbatim (upstream resolves
them; no local rejection): `efficient`, `deepseek-flash`, `glm-5.3-flash`,
`kimi-k3`, `qwen3.8-flash`, `qwen3.8-max`, `qwen3.7-max`.

If Qoder's catalog changes, only `src/models.js` needs an update.

## Token lifecycle

The token is valid for about 30 days and lives in
`~/.qoder-bridge/auth.json` (never inside the repo). When it nears expiry,
open the control page and click **Renew token**. The server picks up the new
token immediately; no restart. Renewal uses the device login flow, which is
why the upstream `refresh_token` endpoint being WAF-blocked is not a problem.

CLI equivalents: `npm run login` (fresh login), `npm run info` (status).

## Configuration

All via environment variables; defaults are fine for local use.

| Variable          | Default                        | Meaning                     |
| ----------------- | ------------------------------ | --------------------------- |
| `QODER_PORT`      | `9528`                         | Listen port                 |
| `QODER_HOST`      | `127.0.0.1`                    | Bind address (keep loopback)|
| `QODER_API_KEY`   | `sk-qoder-bridge-local-2026`   | Key clients must send       |
| `QODER_AUTH_FILE` | `~/.qoder-bridge/auth.json`    | Token store location        |
| `QODER_CORS`      | off                            | Set to `1` to send permissive CORS headers (for browser-based clients on another origin) |

## Security notes

- The server binds `127.0.0.1` only, and the control page re-checks the remote
  address per request. Do not port-forward or reverse-proxy it to a network.
- Cross-origin reads are blocked by default: no CORS headers are sent unless
  `QODER_CORS=1`, so a web page you visit cannot read `/health` (account data)
  or call `/internal/login` from your browser.
- `/health`, `/internal/login`, and `/internal/login-status` additionally
  require the API key; the control page gets it injected at render time.
- The token lives in `~/.qoder-bridge/auth.json` outside the repo, written
  atomically. Logs mask the account email (`j***@example.com`).
- Change `QODER_API_KEY` from the default if other people use this machine.

## Windows helpers

- `start.vbs` -- silent launcher (writes `run/proxy.pid`)
- `stop.vbs` -- stops the PID from `run/proxy.pid`
- `run.cmd` -- console launcher with live logs

## Tests

```bat
node test\verify.mjs
node test\review-checks.mjs
node test\security-checks.mjs
```

Covers: auth rejection, model resolution and aliases, catalog-only passthrough,
streaming with SSE repair, non-streaming, tool-call name backfill; plus the
security posture: anonymous access to account endpoints, email masking, and
default-off CORS.

## API surface

- `POST /v1/chat/completions` -- OpenAI-compatible, streaming and non-streaming (API key)
- `GET /v1/models` -- model list (open: model names only)
- `GET /health` -- server + token state (API key)
- `GET /` -- control page (loopback only)
- `POST /internal/login` -- start device login (loopback + API key)
- `GET /internal/login-status` -- poll login progress (loopback + API key)

## Project layout

```
src/index.js    entrypoint (serve / --login / --refresh / --info)
src/server.js   HTTP server, request routing, retry logic
src/sse.js      SSE frame reassembly and repair
src/models.js   model catalog and resolution
src/auth.js     token store, device-flow login
src/control.js  control page HTML
test/           self-contained regression tests
```

## Disclaimer

This project talks to a Qoder endpoint that is normally used by the Qoder
IDE, using a token obtained through Qoder's own device login flow, for
interoperability with standard OpenAI clients. It is a personal, local tool:
no accounts are created, no rate limits are bypassed, and traffic stays on
your machine. Upstream protocol changes may break it at any time; the fix is
usually a small patch to `src/sse.js` or `src/models.js`. Use at your own
 discretion with an account you own.
