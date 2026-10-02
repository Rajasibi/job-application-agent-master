// Discovery sources: job-alert email parsers, public ATS-board parsers, cross-source dedupe, and the
// conditional human-assisted recovery (checkpoint / attended-gating / park / resume). No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const mail = require('../../helper-service/mail_intake');
const ats = require('../../helper-service/ats_boards');
const { jobIdFor } = require('../../helper-service/discovery');

// ---------- email alert parsers ----------
test('Naukri alert email: jobs with title, company, location, real (unwrapped) URL', () => {
  const jobs = mail.parseAlertEmail(fs.readFileSync(path.join(FIX, 'naukri_alert.html'), 'utf8'));
  assert.equal(jobs.length, 2, JSON.stringify(jobs));
  const gen = jobs.find(j => /Generative AI/.test(j.job_title));
  assert.equal(gen.job_url, 'https://www.naukri.com/job-listings-generative-ai-engineer-acme-ai-chennai-2-to-5-years-280926500870', 'tracking redirect unwrapped');
  assert.equal(gen.company, 'Acme AI Labs');
  assert.match(gen.location, /Chennai/);
  assert.equal(gen.platform, 'naukri');
  assert.ok(jobs.every(j => !/unsubscribe/i.test(j.job_title)));
});

test('foundit alert email: entity-decoded, canonical job URL', () => {
  const jobs = mail.parseAlertEmail(fs.readFileSync(path.join(FIX, 'foundit_alert.html'), 'utf8'));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_url, 'https://www.foundit.in/job/ai-engineer-gamma-tech-coimbatore-india-68339604');
  assert.match(jobs[0].location, /Coimbatore/);
});

test('Indeed alert email: jk extracted from redirect; short snippet flagged for description', () => {
  const jobs = mail.parseAlertEmail(fs.readFileSync(path.join(FIX, 'indeed_alert.html'), 'utf8'));
  const ml = jobs.find(j => /Machine Learning/.test(j.job_title));
  assert.equal(ml.job_url, 'https://in.indeed.com/viewjob?jk=abc123def456');
  const pipe = mail.toPipelineJob(ml, jobIdFor);
  assert.equal(pipe.job_id, 'indeed_abc123def456');
  const short = jobs.find(j => /Intern/.test(j.job_title));
  assert.equal(short.job_url, 'https://in.indeed.com/viewjob?jk=deadbeef1234');
  assert.ok(mail.toPipelineJob(short, jobIdFor).snippet.length < 80, 'thin snippet -> build step asks for a description');
});

test('email dedupe uses the same job ids as the scrapers (no double-queue with search)', () => {
  const jobs = mail.parseAlertEmail(fs.readFileSync(path.join(FIX, 'naukri_alert.html'), 'utf8'));
  const p = mail.toPipelineJob(jobs[0], jobIdFor);
  assert.equal(p.job_id, jobIdFor('naukri', p.job_url), 'same id a Naukri search would produce');
  assert.equal(p.discovered_via, 'email');
});

test('Gmail body extraction decodes base64url html parts', () => {
  const html = '<a href="https://www.foundit.in/job/x-12345">Role</a>';
  const payload = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('plain').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }
  ] };
  assert.equal(mail.bodyOf(payload), html);
});

// ---------- ATS board parsers ----------
test('ATS parsers: Greenhouse / Lever / Ashby / SmartRecruiters / Workable -> normalized jobs', () => {
  const gh = ats.NORMALIZE.greenhouse({ jobs: [{ id: 5, title: 'AI Engineer', location: { name: 'Chennai' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/5', content: '&lt;p&gt;Build LLMs&lt;/p&gt;' }] }, { id: 'acme' });
  assert.deepEqual([gh[0].title, gh[0].location, gh[0].url, gh[0].description], ['AI Engineer', 'Chennai', 'https://boards.greenhouse.io/acme/jobs/5', 'Build LLMs']);
  const lv = ats.NORMALIZE.lever([{ id: 'l1', text: 'ML Engineer', categories: { location: 'Remote' }, hostedUrl: 'https://jobs.lever.co/x/l1', descriptionPlain: 'Do ML' }], { id: 'x' });
  assert.equal(lv[0].url, 'https://jobs.lever.co/x/l1');
  const ash = ats.NORMALIZE.ashby({ jobs: [{ id: 'a1', title: 'NLP Engineer', location: 'Coimbatore', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/x/a1', descriptionPlain: 'NLP' }] }, { id: 'x' });
  assert.match(ash[0].location, /Coimbatore.*Remote/);
  const sr = ats.NORMALIZE.smartrecruiters({ content: [{ id: 's1', name: 'AI Developer', location: { city: 'Chennai', country: 'in' } }] }, { id: 'x' });
  assert.equal(sr[0].title, 'AI Developer');
  const wk = ats.NORMALIZE.workable({ jobs: [{ shortcode: 'w1', title: 'GenAI Engineer', city: 'Chennai', description: '<p>GenAI</p>' }] }, { id: 'x' });
  assert.equal(wk[0].id, 'w1');
});

test('ATS filter: keeps relevant AI/ML roles in allowed locations; drops the rest', () => {
  const cfg = { discovery: { allowedLocations: ['Chennai', 'Coimbatore', 'Remote'], maxMinExperience: 5 } };
  const { makeJobFilter, makeCardFilter } = require('../common');
  const raw = [
    { job_title: 'Generative AI Engineer', job_url: 'https://boards.greenhouse.io/a/1', location: 'Chennai' },
    { job_title: 'Senior Sales Manager', job_url: 'https://boards.greenhouse.io/a/2', location: 'Chennai' },
    { job_title: 'AI Engineer', job_url: 'https://boards.greenhouse.io/a/3', location: 'Berlin' },
    { job_title: 'ML Engineer', job_url: 'not-a-url', location: 'Remote' }
  ];
  const { jobs, stats } = ats.filterJobs(raw, cfg, { keep: makeJobFilter({ ...cfg, exclude: { titlePatterns: ['\\bsales\\b'] } }), cardSkip: makeCardFilter(cfg) });
  assert.deepEqual(jobs.map(j => j.job_title), ['Generative AI Engineer']);
  assert.equal(stats.notRelevant + stats.filteredTitle, 1); // "Sales Manager" (not relevant / excluded)
  assert.equal(stats.filteredLocation, 1); // Berlin
  assert.equal(stats.noLink, 1);
});

test('ATS board detection + seeding from links already in the log', () => {
  assert.deepEqual(ats.boardFromUrl('https://jobs.lever.co/netomi/abc'), { ats: 'lever', id: 'netomi' });
  assert.deepEqual(ats.boardFromUrl('https://boards.greenhouse.io/stripe/jobs/12'), { ats: 'greenhouse', id: 'stripe' });
  assert.deepEqual(ats.boardFromUrl('https://apply.workable.com/quantumloopai/j/B7F8'), { ats: 'workable', id: 'quantumloopai' });
  assert.equal(ats.boardFromUrl('https://www.naukri.com/job-listings-x-123'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companies-'));
  const file = path.join(dir, 'companies.json');
  const added = ats.seedCompanies([
    { company: 'Netomi', external_apply_url: 'https://jobs.lever.co/netomi/abc' },
    { company: 'Quantum', form_url: 'https://apply.workable.com/quantumloopai/j/B7F8' },
    { company: 'Netomi again', external_apply_url: 'https://jobs.lever.co/netomi/def' } // same board -> once
  ], file);
  assert.equal(added.length, 2);
  assert.equal(ats.loadCompanies(file).length, 2);
  assert.equal(ats.seedCompanies([{ company: 'Netomi', external_apply_url: 'https://jobs.lever.co/netomi/xyz' }], file).length, 0, 'idempotent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ATS fetchAll: per-board errors are reported, not thrown', async () => {
  const cfg = { discovery: { allowedLocations: ['Chennai'], maxMinExperience: 5 } };
  const companies = [{ name: 'Good', ats: 'greenhouse', id: 'good' }, { name: 'Bad', ats: 'lever', id: 'bad' }];
  const fetchImpl = async url => url.includes('greenhouse')
    ? { ok: true, json: async () => ({ jobs: [{ id: 1, title: 'AI Engineer', location: { name: 'Chennai' }, absolute_url: 'https://boards.greenhouse.io/good/jobs/1', content: 'LLM work' }] }) }
    : { ok: false, status: 500 };
  const { makeJobFilter, makeCardFilter } = require('../common');
  const r = await ats.fetchAll({ cfg, keep: makeJobFilter({ exclude: {} }), cardSkip: makeCardFilter(cfg), fetchImpl, companies });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source_platform, 'external');
  assert.ok(r.boards.find(b => b.company === 'Bad').error, 'the failing board is reported');
});

// ---------- recovery: checkpoint / attended-gating / park / resume ----------
function recoveryEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
  const p = require.resolve('../recovery');
  const bmP = require.resolve('../browser_modes');
  process.env.JOB_AGENT_CHECKPOINT_DIR = path.join(dir, 'cp');
  process.env.JOB_AGENT_ATTENDED_FILE = path.join(dir, 'attended.json');
  process.env.JOB_AGENT_HITL_FILE = path.join(dir, 'hitl.json');
  delete require.cache[p]; delete require.cache[bmP];
  return { dir, rec: require('../recovery'), cleanup: () => { delete require.cache[p]; fs.rmSync(dir, { recursive: true, force: true }); for (const k of ['JOB_AGENT_CHECKPOINT_DIR', 'JOB_AGENT_ATTENDED_FILE', 'JOB_AGENT_FORCE_ATTENDED']) delete process.env[k]; } };
}
// A stand-in page: a challenge that clears after `clearAfter` calls to detectChallenge.
function fakePage(url, { clearAfter = Infinity, kind = 'cloudflare', bodyLen = 500 } = {}) {
  let n = 0;
  return {
    _closed: false, isClosed() { return this._closed; }, url() { return url; },
    async bringToFront() {}, async waitForLoadState() {}, async waitForTimeout() {}, async goto() {},
    async title() { return n++ < clearAfter ? 'Just a moment...' : 'Job page'; },
    locator() { return { async innerText() { return n < clearAfter ? 'Verify you are human' : 'x'.repeat(bodyLen); }, async count() { return 0; } }; },
    async evaluate(fn) { return n >= clearAfter ? bodyLen : 0; }
  };
}

test('recovery off -> stop (no wait); access_denied is never sent here', async () => {
  const e = recoveryEnv();
  try {
    process.env.JOB_AGENT_RECOVERY = 'off';
    const r = await e.rec.recover(fakePage('https://x/1'), { kind: 'cloudflare' }, { id: 'a', url: 'https://x/1' });
    assert.deepEqual(r, { stop: true });
    delete process.env.JOB_AGENT_RECOVERY;
    assert.deepEqual(await e.rec.recover(fakePage('https://x/1'), { kind: 'access_denied' }, { id: 'b' }), { stop: true });
  } finally { delete process.env.JOB_AGENT_RECOVERY; e.cleanup(); }
});

test('unattended -> park immediately with a checkpoint (no 5-min block for nobody)', async () => {
  const e = recoveryEnv();
  try {
    process.env.JOB_AGENT_FORCE_ATTENDED = '0';
    const t = Date.now();
    const r = await e.rec.recover(fakePage('https://naukri/1'), { kind: 'cloudflare' }, { id: 'job1', kind: 'job_page', site: 'naukri', url: 'https://naukri/1' });
    assert.ok(r.parked);
    assert.ok(Date.now() - t < 2000, 'did not wait');
    const cps = e.rec.loadCheckpoints();
    assert.equal(cps.length, 1);
    assert.equal(cps[0].kind, 'job_page');
    assert.equal(cps[0].challenge, 'cloudflare');
  } finally { e.cleanup(); }
});

test('attended + the check clears -> verified -> resumed, checkpoint deleted', async () => {
  const e = recoveryEnv();
  try {
    process.env.JOB_AGENT_FORCE_ATTENDED = '1';
    process.env.JOB_AGENT_HUMAN_WAIT_MS = '4000';
    const page = fakePage('https://naukri/2', { clearAfter: 1 });
    const r = await e.rec.recover(page, { kind: 'cloudflare' }, { id: 'job2', kind: 'job_page', site: 'naukri', url: 'https://naukri/2' });
    assert.deepEqual(r, { resumed: true });
    assert.equal(e.rec.loadCheckpoints().length, 0, 'checkpoint cleared after success');
  } finally { delete process.env.JOB_AGENT_HUMAN_WAIT_MS; e.cleanup(); }
});

test('attended but the check never clears -> parked with the checkpoint kept', async () => {
  const e = recoveryEnv();
  try {
    process.env.JOB_AGENT_FORCE_ATTENDED = '1';
    process.env.JOB_AGENT_HUMAN_WAIT_MS = '600';
    const r = await e.rec.recover(fakePage('https://naukri/3', { clearAfter: Infinity }), { kind: 'captcha' }, { id: 'job3', url: 'https://naukri/3' });
    assert.ok(r.parked);
    assert.equal(e.rec.loadCheckpoints().length, 1);
  } finally { delete process.env.JOB_AGENT_HUMAN_WAIT_MS; e.cleanup(); }
});

test('attended flag: heartbeat within 2 min counts, older does not', () => {
  const e = recoveryEnv();
  try {
    delete process.env.JOB_AGENT_FORCE_ATTENDED;
    fs.writeFileSync(process.env.JOB_AGENT_ATTENDED_FILE, JSON.stringify({ at: new Date().toISOString() }));
    assert.equal(e.rec.attended(), true);
    fs.writeFileSync(process.env.JOB_AGENT_ATTENDED_FILE, JSON.stringify({ at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }));
    assert.equal(e.rec.attended(), false);
  } finally { e.cleanup(); }
});
