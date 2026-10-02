// Pipeline statuses (forward-only), engine result -> status + next action, the Sheet's "Next action"
// column, the read-only visible check mode, and the reused per-site browser (browser_keeper).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fresh application_log bound to a temp file (never the real log).
function freshLog() {
  const p = require.resolve('../application_log');
  const prev = process.env.JOB_AGENT_LOG_PATH;
  process.env.JOB_AGENT_LOG_PATH = path.join(tmp, `log-${crypto.randomUUID()}.json`);
  delete require.cache[p];
  const mod = require('../application_log');
  delete require.cache[p];
  if (prev === undefined) delete process.env.JOB_AGENT_LOG_PATH; else process.env.JOB_AGENT_LOG_PATH = prev;
  return mod;
}

test('statuses only move forward; APPLIED and REJECTED are final; Retry may restart an outcome', () => {
  const log = freshLog();
  const url = 'https://www.naukri.com/job-listings-x-123456789012';
  assert.equal(log.upsert({ job_url: url, status: 'DISCOVERED' }).status, 'DISCOVERED');
  assert.equal(log.upsert({ job_url: url, status: 'SCORED', fit_score: 90 }).status, 'SCORED');
  assert.equal(log.upsert({ job_url: url, status: 'CV_READY' }).status, 'CV_READY');
  assert.equal(log.upsert({ job_url: url, status: 'DISCOVERED' }).status, 'CV_READY', 'a late DISCOVERED never moves it back');
  assert.equal(log.upsert({ job_url: url, status: 'APPLICATION_STARTED' }).status, 'APPLICATION_STARTED');
  const r = log.upsert({ job_url: url, status: 'AWAITING_MANUAL_SUBMIT', next_action: 'click Apply' });
  assert.equal(r.status, 'NEEDS_REVIEW');
  assert.equal(r.next_action, 'click Apply');
  assert.equal(log.upsert({ job_url: url, status: 'CV_READY' }).status, 'NEEDS_REVIEW', 'outcome not overwritten by an earlier stage');
  assert.equal(log.upsert({ job_url: url, status: 'APPLICATION_STARTED' }, { restart: true }).status, 'APPLICATION_STARTED', 'Retry / Re-check');
  assert.equal(log.upsert({ job_url: url, status: 'ALREADY_APPLIED' }).status, 'APPLIED');
  const after = log.upsert({ job_url: url, status: 'FAILED', notes: 'late error' });
  assert.equal(after.status, 'APPLIED', 'APPLIED is final');
  assert.equal(after.notes, 'late error', 'other fields still merge');
});

test('one-time migration: old names -> pipeline statuses with a next action', () => {
  const log = freshLog();
  log.save({ applications: [
    { id: 'a', job_url: 'https://x/1', status: 'AWAITING_MANUAL_SUBMIT' },
    { id: 'b', job_url: 'https://x/2', status: 'SECURITY_CHALLENGE' },
    { id: 'c', job_url: 'https://x/3', status: 'LOGIN_REQUIRED' },
    { id: 'd', job_url: 'https://x/4', status: 'ALREADY_APPLIED' },
    { id: 'e', job_url: 'https://x/5', status: 'REJECTED' }
  ] });
  const moved = log.migrate();
  const by = Object.fromEntries(log.load().applications.map(a => [a.id, a]));
  assert.equal(by.a.status, 'NEEDS_REVIEW');
  assert.equal(by.b.status, 'SECURITY_CHALLENGE');
  assert.match(by.b.next_action, /Re-check/);
  assert.equal(by.c.status, 'SECURITY_CHALLENGE');
  assert.match(by.c.next_action, /LOGIN_ONCE/);
  assert.equal(by.d.status, 'APPLIED');
  assert.ok(by.e.next_action);
  assert.equal(moved.length, 5);
  assert.equal(log.migrate().length, 0, 'running it again changes nothing');
});

test('outcome: engine result -> status + exact next action; APPLIED only from a site-confirmed state', () => {
  const { outcomeFor } = require('../../helper-service/outcome');
  const naukri = { source_platform: 'naukri' };
  const o = (r, job = naukri) => outcomeFor(r, job);
  assert.deepEqual([o({ status: 'AWAITING_MANUAL_SUBMIT', detail: 'READY_ONE_CLICK' }).status, o({ status: 'AWAITING_MANUAL_SUBMIT', detail: 'READY_ONE_CLICK' }).next_action],
    ['NEEDS_REVIEW', 'Open the job link and click Apply on Naukri (one click; your profile is ready)']);
  assert.match(o({ status: 'AWAITING_MANUAL_SUBMIT', detail: 'READY_ONE_CLICK' }, { source_platform: 'indeed' }).next_action, /never automated/);
  assert.equal(o({ status: 'ALREADY_APPLIED' }).status, 'APPLIED');
  assert.equal(o({ status: 'APPLIED', detail: 'SITE_CONFIRMED_APPLIED' }).status, 'APPLIED');
  const clicked = o({ status: 'NEEDS_HUMAN_INPUT', detail: 'CLICKED_UNCONFIRMED' });
  assert.equal(clicked.status, 'NEEDS_REVIEW', 'a click without confirmation is never APPLIED');
  const form = o({ status: 'NEEDS_HUMAN_INPUT', detail: 'COMPANY_FORM_NEEDS_INPUT', needs_input: ['Current CTC (Annual) *', 'Work Link / Online Portfolio *'] });
  assert.equal(form.status, 'NEEDS_REVIEW');
  assert.match(form.next_action, /Company form filled; still needed: Current CTC \(Annual\); Work Link/);
  assert.equal(o({ status: 'FAILED', detail: 'CLOSED' }).next_action, 'Nothing: the job is closed');
  assert.equal(o({ status: 'LOGIN_REQUIRED', detail: 'LOGIN' }).status, 'SECURITY_CHALLENGE');
  assert.match(o({ status: 'SECURITY_CHALLENGE', challenge: 'access_denied', detail: 'COMPANY_SITE_CHALLENGE_ACCESS_DENIED' }).next_action, /company site blocked automated access/);
  assert.match(o({ status: 'SECURITY_CHALLENGE', challenge: 'cloudflare' }).next_action, /Cloudflare/);
  assert.equal(o({ success: false, error: 'naukri_apply.js exited 1' }).status, 'FAILED');
});

// ---------- Sheets: column L "Next action" ----------
function mockSheets(header) {
  const calls = [];
  let row1 = header;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (_) { parsed = body; } // the token request is a form
      calls.push({ method: req.method, url: decodeURIComponent(req.url), body: parsed });
      const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/token')) return json({ access_token: 't', expires_in: 3600 });
      const u = decodeURIComponent(req.url);
      if (req.method === 'GET' && /A1:O1/.test(u)) return json({ values: [row1] });
      if (req.method === 'PUT' && /!L1:O1/.test(u)) { row1 = [...row1, 'Next action', 'Source', 'Security status', 'Checkpoint']; return json({}); }
      if (req.method === 'GET' && /J:J/.test(u)) return json({ values: [['Job URL']] });
      return json({});
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(c => server.close(c)) })));
}

test('Sheets: an existing 11-column sheet gets "Next action" in L1 once; rows carry 12 values', async () => {
  const { createSheetsSync, COLUMNS } = require('../../helper-service/sheets_sync');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(tmp, 'sa.json');
  fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const m = await mockSheets(COLUMNS.slice(0, 11));
  try {
    const s = createSheetsSync({ sheetId: 'sheet', keyFile, outboxPath: path.join(tmp, 'outbox.json'), baseUrl: m.base, tokenUrl: `${m.base}/token` });
    s.enqueue({ job_url: 'https://x/1', company: 'Acme', status: 'NEEDS_REVIEW', next_action: 'Open the job link and click Apply on Naukri' });
    await s.flush();
    assert.ok(m.calls.some(c => c.method === 'PUT' && /!L1:O1/.test(c.url)), 'L1:O1 headers written');
    const append = m.calls.find(c => /:append/.test(c.url));
    assert.equal(append.body.values[0].length, 15);
    assert.equal(append.body.values[0][11], 'Open the job link and click Apply on Naukri');
    assert.equal(s.status().pending, 0);
  } finally { await m.close(); }
});

// ---------- engine check mode (read-only) + browser reuse ----------
test('check mode + reused browser: one-click -> ready (no click); applied / closed detected; tabs reuse ONE browser', async () => {
  process.env.JOB_AGENT_HEADLESS = '1';
  process.env.JOB_AGENT_PROFILE_DIR = path.join(tmp, 'profiles');
  process.env.JOB_AGENT_HITL_FILE = path.join(tmp, 'hitl.json');
  process.env.JOB_AGENT_HUMAN_WAIT_MS = '300';
  const { run } = require('../application_engine');
  const naukri = { ...require('../naukri_apply').handler, storageState: undefined };
  const { startServer, testProfile, tempFiles } = require('./helpers');
  const { createKeeper } = require('../../helper-service/browser_keeper');
  const srv = await startServer();
  const files = tempFiles();
  const keeper = createKeeper({ profileRoot: process.env.JOB_AGENT_PROFILE_DIR, headless: true });
  const base = extra => ({ mode: 'check', platform: 'naukri', company: 'Acme', title: 'AI Engineer', profile: testProfile, score: 99,
    policy: { default: 'manual', platforms: { naukri: 'auto' }, autoMinScore: 80 }, cv: files.cv, coverLetter: files.coverLetter, outputDir: files.outputDir, llm: null, handler: naukri, ...extra });
  try {
    await keeper.use('naukri', async () => {
      const pid = keeper.status().naukri.pid;
      const ready = await run(base({ url: `${srv.base}/naukri_auto.html` }));
      assert.equal(ready.status, 'AWAITING_MANUAL_SUBMIT');
      assert.equal(ready.detail, 'READY_ONE_CLICK');
      const applied = await run(base({ url: `${srv.base}/naukri_applied.html` }));
      assert.equal(applied.status, 'ALREADY_APPLIED');
      const closed = await run(base({ url: `${srv.base}/naukri_closed.html` }));
      assert.equal(closed.detail, 'CLOSED');
      const ext = await run(base({ url: `${srv.base}/naukri_external.html` }));
      assert.notEqual(ext.status, 'APPLIED');
      assert.equal(keeper.status().naukri.pid, pid, 'every check used the same live browser');
    });
    assert.equal(srv.hits.submitted, 0, 'check mode never clicks Apply or Submit, even with an auto policy');
    assert.ok(fs.existsSync(keeper.endpointFile('naukri')));
  } finally {
    await keeper.closeAll();
    await srv.close();
    files.cleanup();
  }
  assert.ok(!fs.existsSync(keeper.endpointFile('naukri')), 'endpoint removed when the browser closes');
});
