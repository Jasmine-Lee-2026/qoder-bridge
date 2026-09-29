// Model catalog for the Qoder api2-v2 endpoint.
//
// Clients see real model names (`glm-5.3`, `qwen3.7-plus`, ...); the endpoint
// itself still expects Qoder's internal keys (`gmodel`, `qmodel`, ...), so the
// mapping below is applied on the way out. The legacy internal keys remain
// valid as aliases so already-configured clients keep working.
//
// The authoritative catalog is `model_configs` in the auth file. Models are
// split in two groups:
//
//   ROUTED        - known to work on the live endpoint (probed 2026-09-29).
//   CATALOG_ONLY  - present in the account catalog but currently rejected by
//                   the endpoint. They are STILL ADVERTISED and still forwarded
//                   upstream on request: the upstream error is passed through
//                   verbatim, and if the backend starts routing them the bridge
//                   needs no change. Hard-coding a local refusal here would
//                   freeze today's outage into the proxy.
//
//   * `lite` is not in model_configs but is accepted by the endpoint.

export const ROUTED = [
  { id: 'auto', upstream: 'auto', display: 'Auto (router)' },
  { id: 'lite', upstream: 'lite', display: 'Lite (fast)' },
  { id: 'performance', upstream: 'performance', display: 'Performance' },
  { id: 'qwen3.7-plus', upstream: 'qmodel', display: 'Qwen3.7-Plus' },
  { id: 'deepseek-v4-pro', upstream: 'dmodel', display: 'DeepSeek-V4-Pro' },
  { id: 'glm-5.3', upstream: 'gmodel', display: 'GLM-5.3' },
  { id: 'kimi-k2.8-preview', upstream: 'kmodel', display: 'Kimi-K2.8-Preview' },
  { id: 'minimax-m3', upstream: 'mmodel', display: 'MiniMax-M3' },
  { id: 'ultimate', upstream: 'ultimate', display: 'Ultimate' },
];

export const CATALOG_ONLY = [
  { id: 'efficient', upstream: 'efficient', display: 'Efficient' },
  { id: 'deepseek-flash', upstream: 'dfmodel', display: 'DeepSeek-Flash' },
  { id: 'glm-5.3-flash', upstream: 'gfmodel', display: 'GLM-5.3-Flash' },
  { id: 'kimi-k3', upstream: 'kmodel_latest', display: 'Kimi-K3' },
  { id: 'qwen3.8-flash', upstream: 'qfmodel', display: 'Qwen3.8-Flash' },
  { id: 'qwen3.8-max', upstream: 'qmodel_38max', display: 'Qwen3.8-Max' },
  { id: 'qwen3.7-max', upstream: 'qmodel_latest', display: 'Qwen3.7-Max' },
];

const ALL = [...ROUTED, ...CATALOG_ONLY];

const BY_ID = new Map(ALL.map((m) => [m.id, m]));
const BY_UPSTREAM = new Map(ALL.map((m) => [m.upstream, m]));

// Public id -> endpoint key (null when the id is not in the catalog at all).
export function upstreamKey(id) {
  const m = BY_ID.get(id);
  return m ? m.upstream : null;
}

// Aliases: anything a client might plausibly ask for maps onto a routed id.
const ALIASES = {
  // generic
  'qoder/auto': 'auto',
  'qoder/lite': 'lite',
  'qoder/performance': 'performance',
  'qoder/ultimate': 'ultimate',
  default: 'auto',
  fast: 'lite',
  cheap: 'lite',
  small: 'lite',
  balanced: 'performance',
  best: 'ultimate',
  smart: 'ultimate',
  reasoning: 'ultimate',
  // other providers' names
  'gpt-4o': 'auto',
  'gpt-4.1': 'auto',
  'gpt-5': 'auto',
  'claude-sonnet-4.5': 'performance',
  'claude-opus-4.6': 'ultimate',
  'claude-3-5-sonnet': 'performance',
  'gemini-2.5-pro': 'ultimate',
  'deepseek-chat': 'deepseek-v4-pro',
  'glm-4.6': 'glm-5.3',
  'qwen-max': 'qwen3.7-plus',
  'kimi-k2': 'kimi-k2.8-preview',
  'minimax-m2': 'minimax-m3',
};

export const DEFAULT_MODEL = process.env.QODER_DEFAULT_MODEL || 'auto';

export function resolveModel(requested) {
  const key = String(requested || '').trim().toLowerCase();
  if (!key) return { key: DEFAULT_MODEL, exact: true, known: true };
  const norm = key.replace(/^qoder\//, '').replace(/^qoder-/, '');
  if (BY_ID.has(norm)) return { key: norm, exact: norm === key, known: true };
  // Legacy / internal endpoint keys (qmodel, dfmodel, ...) map to the public id.
  if (BY_UPSTREAM.has(norm)) return { key: BY_UPSTREAM.get(norm).id, exact: false, known: true };
  if (ALIASES[key] || ALIASES[norm]) return { key: ALIASES[key] || ALIASES[norm], exact: false, known: true };
  // Unknown model: fall back to the default so an editor with a stale model id
  // still gets an answer, but say so.
  return { key: DEFAULT_MODEL, exact: false, known: false };
}

export function listModels(modelConfigs) {
  const cfg = modelConfigs || {};
  return ALL.map((m) => {
    const meta = cfg[m.upstream] || cfg[m.id] || {};
    return {
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'qoder',
      display_name: m.display || meta.display_name || m.id,
      context_window: meta.max_input_tokens || 200000,
    };
  });
}
