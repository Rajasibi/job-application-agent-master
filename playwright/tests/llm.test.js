// LLM backend: local, cloud, fallback, timeout, concurrency and redaction, against mock Ollama servers.
// No network and no real key needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createLlm } = require('../../helper-service/llm_backend');

const KEY = 'test-key-123.SECRET';
const REDACT = [['+91 9000000001', '[PHONE]'], ['9000000001', '[PHONE]'], ['me@example.com', '[EMAIL]'], ['4.2 LPA', '[CURRENT_CTC]']];

// behave(req, body, res, n) handles a request; the server records every request.
function mockOllama(behave) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ headers: req.headers, body, at: Date.now() });
      behave(req, body, res, seen.length);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}`, seen,
    close: () => new Promise(c => { server.closeAllConnections?.(); server.close(c); })
  })));
}
const reply = (res, content, extra = {}, delay = 0) => setTimeout(() => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done: true, eval_count: 5, prompt_eval_count: 9, ...extra }));
}, delay);

const REQ = {
  model: 'qwen2.5:7b-instruct', stream: false, format: 'json', keep_alive: '2h',
  options: { temperature: 0.2, num_predict: 50, num_ctx: 6144 },
  messages: [{ role: 'system', content: 'Score this.' }, { role: 'user', content: 'Candidate: me@example.com, +91 9000000001, current 4.2 LPA.' }]
};

function llmFor(env, logs = []) {
  return createLlm({ env: { LLM_CLOUD_RETRIES: '2', ...env }, log: m => logs.push(m), sleep: async () => {}, redactions: REDACT });
}

test('local backend forwards the request unchanged and keeps the Ollama response shape', async () => {
  const local = await mockOllama((req, body, res) => reply(res, '{"score":80}'));
  try {
    const r = await llmFor({ OLLAMA_BASE_URL: local.url }).chat(REQ);
    assert.equal(r.message.content, '{"score":80}');
    assert.equal(r.backend_used, 'local');
    assert.equal(r.eval_count, 5);
    assert.deepEqual(local.seen[0].body, REQ, 'local gets the exact request, incl. keep_alive and num_ctx');
    assert.equal(local.seen[0].headers.authorization, undefined);
  } finally { await local.close(); }
});

test('cloud backend: Bearer key, cloud model, local-only options dropped, key never logged', async () => {
  const cloud = await mockOllama((req, body, res) => reply(res, '{"score":81}'));
  const logs = [];
  try {
    const r = await llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'gemma4:31b' }, logs).chat(REQ);
    assert.equal(r.backend_used, 'ollama_cloud');
    assert.equal(r.fallback, false);
    assert.equal(r.message.content, '{"score":81}');
    const sent = cloud.seen[0];
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent.body.model, 'gemma4:31b');
    assert.equal(sent.body.keep_alive, undefined);
    assert.equal(sent.body.options.num_ctx, undefined);
    assert.equal(sent.body.options.num_predict, 50);
    assert.equal(sent.body.format, 'json', 'JSON contract preserved');
    assert.ok(!logs.join('\n').includes(KEY));
  } finally { await cloud.close(); }
});

test('cloud never receives the email, phone or current salary; the reply gets them restored', async () => {
  const cloud = await mockOllama((req, body, res) => reply(res, '# Raja\n[PHONE] | [EMAIL]\nCurrent: [CURRENT_CTC]'));
  try {
    const r = await llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'x' }).chat(REQ);
    const sentText = JSON.stringify(cloud.seen[0].body);
    for (const secret of ['me@example.com', '9000000001', '4.2 LPA']) assert.ok(!sentText.includes(secret), `${secret} must not leave the machine`);
    assert.match(sentText, /\[EMAIL\].*\[PHONE\].*\[CURRENT_CTC\]/);
    assert.equal(r.message.content, '# Raja\n+91 9000000001 | me@example.com\nCurrent: 4.2 LPA');
  } finally { await cloud.close(); }
});

test('fallback: cloud 500 / 429 exhausted after retries -> local answers', async () => {
  for (const status of [500, 429]) {
    const cloud = await mockOllama((req, body, res) => { res.statusCode = status; res.end('{"error":"busy"}'); });
    const local = await mockOllama((req, body, res) => reply(res, 'local-ok'));
    const logs = [];
    try {
      const llm = llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'x', OLLAMA_BASE_URL: local.url }, logs);
      const r = await llm.chat(REQ);
      assert.equal(cloud.seen.length, 3, `${status}: 1 attempt + 2 retries`);
      assert.equal(r.backend_used, 'local');
      assert.equal(r.fallback, true);
      assert.equal(r.message.content, 'local-ok');
      assert.equal(r.cloud_error.kind, status === 429 ? 'rate_limited' : 'http');
      assert.deepEqual(local.seen[0].body, { ...REQ, keep_alive: '10m' }, 'local gets the original (unredacted) request; Qwen unloads 10 min after a fallback');
      assert.match(logs.join('\n'), /cloud→local fallback/);
      assert.equal(llm.status().fallbacks, 1);
    } finally { await cloud.close(); await local.close(); }
  }
});

test('auth errors are not retried; fallback off -> structured error without the key', async () => {
  const cloud = await mockOllama((req, body, res) => { res.statusCode = 401; res.end(`{"error":"bad key ${KEY}"}`); });
  try {
    const llm = llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'x', LLM_FALLBACK_LOCAL: 'false' });
    await assert.rejects(llm.chat(REQ), e => {
      assert.equal(e.kind, 'auth');
      assert.equal(e.backend, 'ollama_cloud');
      assert.equal(e.status, 401);
      assert.ok(!JSON.stringify(e.toJSON()).includes(KEY), 'key scrubbed from the error');
      return true;
    });
    assert.equal(cloud.seen.length, 1);
  } finally { await cloud.close(); }
});

test('timeout: a hanging cloud is aborted at LLM_CLOUD_TIMEOUT_MS, then local answers', async () => {
  const cloud = await mockOllama(() => {}); // never replies
  const local = await mockOllama((req, body, res) => reply(res, 'local-after-timeout'));
  try {
    const t = Date.now();
    const r = await llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'x', OLLAMA_BASE_URL: local.url, LLM_CLOUD_TIMEOUT_MS: '300', LLM_CLOUD_RETRIES: '1' }).chat(REQ);
    assert.equal(r.cloud_error.kind, 'timeout');
    assert.equal(r.message.content, 'local-after-timeout');
    assert.ok(Date.now() - t < 5000, 'bounded by the timeout, not hanging');
  } finally { await cloud.close(); await local.close(); }
});

test('no key -> no_key error, falls back to local without calling the cloud', async () => {
  const local = await mockOllama((req, body, res) => reply(res, 'local'));
  try {
    const r = await llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: 'http://127.0.0.1:1', OLLAMA_CLOUD_MODEL: 'x', OLLAMA_BASE_URL: local.url }).chat(REQ);
    assert.equal(r.cloud_error.kind, 'no_key');
    assert.equal(r.backend_used, 'local');
  } finally { await local.close(); }
});

test('concurrency: cloud calls run in parallel, local calls strictly one at a time', async () => {
  const track = () => { const t = { active: 0, max: 0 }; return t; };
  const c = track();
  const l = track();
  const busy = t => (req, body, res) => { t.active++; t.max = Math.max(t.max, t.active); setTimeout(() => { t.active--; reply(res, 'ok'); }, 150); };
  const cloud = await mockOllama(busy(c));
  const local = await mockOllama(busy(l));
  try {
    const cloudLlm = llmFor({ LLM_BACKEND: 'ollama_cloud', OLLAMA_CLOUD_URL: cloud.url, OLLAMA_API_KEY: KEY, OLLAMA_CLOUD_MODEL: 'x' });
    const rs = await Promise.all([1, 2, 3, 4].map(() => cloudLlm.chat(REQ)));
    assert.ok(rs.every(r => r.message.content === 'ok'));
    assert.equal(c.max, 4, '4 cloud requests in flight together');

    const localLlm = llmFor({ OLLAMA_BASE_URL: local.url });
    await Promise.all([1, 2, 3, 4].map(() => localLlm.chat(REQ)));
    assert.equal(l.max, 1, 'local Qwen never gets more than one request at a time');
  } finally { await cloud.close(); await local.close(); }
});

test('streaming (benchmark): time to first token measured, content assembled', async () => {
  const local = await mockOllama((req, body, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n');
    setTimeout(() => res.end(JSON.stringify({ message: { content: 'lo' }, done: false }) + '\n' + JSON.stringify({ message: { content: '' }, done: true, eval_count: 2 }) + '\n'), 50);
  });
  try {
    const r = await llmFor({ OLLAMA_BASE_URL: local.url }).chat({ ...REQ, stream: true });
    assert.equal(r.message.content, 'Hello');
    assert.equal(r.eval_count, 2);
    assert.ok(r.ttft_ms !== null && r.ttft_ms <= r.total_ms);
  } finally { await local.close(); }
});

test('helper proxy /llm/api/chat returns the shape n8n reads (message.content)', async () => {
  // The proxy is a thin wrapper: llm.chat(body with stream:false) -> JSON. Check the module contract
  // n8n relies on: `$json.message.content` is a string for every backend.
  const local = await mockOllama((req, body, res) => reply(res, 'x'));
  try {
    const r = await llmFor({ OLLAMA_BASE_URL: local.url }).chat({ ...REQ, stream: false });
    assert.equal(typeof r.message.content, 'string');
  } finally { await local.close(); }
});
