// Switchable LLM backend: local Ollama (default) or Ollama Cloud, with local as the fallback.
//
// Requests and responses use Ollama's /api/chat format, so the n8n workflows and prompts don't
// change: the helper's /llm/api/chat proxies to whichever backend is configured.
//
//   LLM_BACKEND          local | ollama_cloud              (default local)
//   OLLAMA_BASE_URL      local Ollama                       (default http://127.0.0.1:11434)
//   OLLAMA_CLOUD_URL     cloud API                          (default https://ollama.com)
//   OLLAMA_API_KEY       cloud key: env only, never logged or returned
//   OLLAMA_CLOUD_MODEL   cloud model name (the local model name isn't available in the cloud)
//   LLM_CLOUD_TIMEOUT_MS per attempt (default 90 s);  LLM_CLOUD_RETRIES (default 2)
//   LLM_LOCAL_TIMEOUT_MS default 20 min (under n8n's 25-min node timeout)
//   LLM_FALLBACK_LOCAL   true | false                       (default true)
//
// Local calls run strictly one at a time (the laptop can't hold more than one Qwen request), so
// cloud->local fallbacks during a concurrent cloud run never stack up on the CPU.
// Before a request leaves the machine, the user's email, phone and current salary are replaced by
// placeholders, and restored in the reply (so a tailored CV still shows the real contact line).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

class LlmError extends Error {
  constructor(kind, backend, message, status) {
    super(String(message || kind).slice(0, 200));
    this.kind = kind; // timeout | rate_limited | auth | http | network | bad_response | no_key
    this.backend = backend;
    this.status = status || null;
  }
  toJSON() { return { kind: this.kind, backend: this.backend, status: this.status, message: this.message }; }
}

const RETRYABLE = new Set(['timeout', 'rate_limited', 'network', 'http5xx']);

function makeSemaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => { active--; if (waiting.length) waiting.shift()(); };
  return async fn => {
    if (active >= max) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { release(); }
  };
}

// Pairs [real, placeholder] for data the cloud doesn't need. Longest first so "+91 9025906485"
// is replaced before "9025906485".
function redactionsFromProfile(profilePath = path.join(ROOT, 'profile.json')) {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (_) { return []; }
  const pairs = [];
  if (p.email) pairs.push([p.email, '[EMAIL]']);
  const digits = String(p.phone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    const local = digits.slice(-10);
    const cc = digits.length > 10 ? digits.slice(0, -10) : '91';
    for (const v of [`+${cc} ${local}`, `+${cc}${local}`, `+${cc}-${local}`, local]) pairs.push([v, '[PHONE]']);
  }
  const cur = Number(String(p.currentSalary || '').replace(/[^\d.]/g, ''));
  if (cur > 0) {
    const lakhs = String(+(cur / 100000).toFixed(2));
    pairs.push([`${lakhs} LPA`, '[CURRENT_CTC]'], [String(p.currentSalary), '[CURRENT_CTC_INR]']);
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function redactRequest(req, pairs) {
  if (!pairs.length) return req;
  const sub = s => pairs.reduce((t, [real, ph]) => t.split(real).join(ph), String(s));
  return { ...req, messages: (req.messages || []).map(m => ({ ...m, content: sub(m.content) })) };
}

function restoreText(text, pairs) {
  // Restore to the first (longest, most complete) real value for each placeholder.
  const back = new Map();
  for (const [real, ph] of pairs) if (!back.has(ph)) back.set(ph, real);
  let out = String(text || '');
  for (const [ph, real] of back) out = out.split(ph).join(real);
  return out;
}

// One HTTP call in Ollama /api/chat format. Streams when body.stream is true (to measure time to
// first token) but always returns a single non-streamed-shaped response.
async function callOllama(fetchImpl, url, headers, body, timeoutMs, backend) {
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new LlmError('timeout', backend, `no response after ${Math.round(timeoutMs / 1000)} s`);
    throw new LlmError('network', backend, e.cause?.code || e.message);
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.text()).slice(0, 200); } catch (_) {}
    const kind = res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'http5xx' : 'http';
    const err = new LlmError(kind, backend, `HTTP ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    err.retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
    throw err;
  }
  try {
    if (!body.stream) {
      const j = await res.json();
      if (typeof j?.message?.content !== 'string') throw new Error('no message.content');
      return { ...j, total_ms: Date.now() - started, ttft_ms: null };
    }
    let content = '';
    let last = {};
    let ttft = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        const piece = j.message?.content || '';
        if (piece && ttft === null) ttft = Date.now() - started;
        content += piece;
        last = j;
      }
    }
    if (buf.trim()) { const j = JSON.parse(buf); content += j.message?.content || ''; last = j; }
    return { ...last, message: { role: 'assistant', content }, done: true, total_ms: Date.now() - started, ttft_ms: ttft };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new LlmError('timeout', backend, `no complete response after ${Math.round(timeoutMs / 1000)} s`);
    throw new LlmError('bad_response', backend, e.message);
  }
}

function createLlm({ env = process.env, log = () => {}, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), redactions } = {}) {
  const get = (k, d) => (env[k] === undefined || env[k] === '' ? d : env[k]);
  const cfg = () => ({
    backend: get('LLM_BACKEND', 'local') === 'ollama_cloud' ? 'ollama_cloud' : 'local',
    localUrl: `${get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`,
    cloudUrl: `${get('OLLAMA_CLOUD_URL', 'https://ollama.com').replace(/\/$/, '')}/api/chat`,
    key: get('OLLAMA_API_KEY', ''),
    cloudModel: get('OLLAMA_CLOUD_MODEL', ''),
    cloudTimeout: Number(get('LLM_CLOUD_TIMEOUT_MS', 90000)),
    cloudRetries: Number(get('LLM_CLOUD_RETRIES', 2)),
    localTimeout: Number(get('LLM_LOCAL_TIMEOUT_MS', 20 * 60 * 1000)),
    fallback: !/^(false|0|no)$/i.test(get('LLM_FALLBACK_LOCAL', 'true'))
  });
  const localGate = makeSemaphore(1);
  let pairs = null;
  const getPairs = () => (pairs = pairs || redactions || redactionsFromProfile());
  const state = { lastErrorKind: null, lastErrorAt: null, fallbacks: 0, calls: { local: 0, ollama_cloud: 0 } };
  const scrub = (msg, key) => (key ? String(msg).split(key).join('[key]') : String(msg));

  async function local(request, c) {
    // On the cloud backend local Qwen is only a fallback: unload it 10 min after use (frees ~5 GB)
    // instead of keeping it in memory for hours.
    const req = c.backend === 'ollama_cloud' ? { ...request, keep_alive: '10m' } : request;
    return localGate(async () => {
      state.calls.local++;
      return { ...(await callOllama(fetchImpl, c.localUrl, {}, req, c.localTimeout, 'local')), backend_used: 'local' };
    });
  }

  async function cloud(request, c, model) {
    const m = model || c.cloudModel;
    if (!c.key) throw new LlmError('no_key', 'ollama_cloud', 'OLLAMA_API_KEY is not set');
    if (!m) throw new LlmError('no_key', 'ollama_cloud', 'OLLAMA_CLOUD_MODEL is not set');
    const p = getPairs();
    const { keep_alive, ...rest } = redactRequest(request, p);
    const { num_ctx, ...options } = rest.options || {};
    const body = { ...rest, model: m, options };
    let lastErr;
    for (let attempt = 0; attempt <= c.cloudRetries; attempt++) {
      if (attempt) await sleep(Math.max(lastErr?.retryAfterMs || 0, attempt === 1 ? 2000 : 6000));
      try {
        state.calls.ollama_cloud++;
        const r = await callOllama(fetchImpl, c.cloudUrl, { Authorization: `Bearer ${c.key}` }, body, c.cloudTimeout, 'ollama_cloud');
        r.message = { ...r.message, content: restoreText(r.message.content, p) };
        return { ...r, backend_used: 'ollama_cloud', model: m, attempts: attempt + 1 };
      } catch (e) {
        e.message = scrub(e.message, c.key);
        lastErr = e;
        if (!RETRYABLE.has(e.kind)) break;
      }
    }
    if (lastErr.kind === 'http5xx') lastErr.kind = 'http';
    throw lastErr;
  }

  // backend: force one backend (benchmark). model: cloud model override (benchmark).
  async function chat(request, { backend, model, fallback } = {}) {
    const c = cfg();
    const which = backend || c.backend;
    if (which === 'local') {
      try { return await local(request, c); } catch (e) { state.lastErrorKind = e.kind; state.lastErrorAt = new Date().toISOString(); throw e; }
    }
    try {
      return { ...(await cloud(request, c, model)), fallback: false };
    } catch (e) {
      state.lastErrorKind = e.kind;
      state.lastErrorAt = new Date().toISOString();
      if (!(fallback ?? c.fallback)) throw e;
      state.fallbacks++;
      log(`LLM cloud→local fallback: ${e.kind} (${e.message})`);
      const r = await local(request, c);
      return { ...r, fallback: true, cloud_error: e.toJSON() };
    }
  }

  function status() {
    const c = cfg();
    return { backend: c.backend, cloud_configured: !!(c.key && c.cloudModel), cloud_model: c.cloudModel || null, fallback_local: c.fallback, last_error_kind: state.lastErrorKind, last_error_at: state.lastErrorAt, fallbacks: state.fallbacks, calls: { ...state.calls } };
  }

  return { chat, status };
}

module.exports = { createLlm, LlmError, redactionsFromProfile, redactRequest, restoreText, makeSemaphore };
