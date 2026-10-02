// Job discovery on local mock search pages (never the real sites): NORMAL and VISIBLE modes,
// stop-on-first-block (no retries), empty results, duplicates, and the paste-a-job / feeder logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const discovery = require('../../helper-service/discovery');

const PW = path.join(__dirname, '..');
const LONG = 'Build RAG pipelines with LangChain and vector databases, LLM chatbots with guardrails, FastAPI services on AWS, fine-tune open-source LLMs with LoRA. Python and SQL required. Work with product and engineering teams in Chennai.';

// ---------- mock job sites ----------
const CARDS = [
  { id: '100000001', title: 'GenAI Engineer', company: 'Acme AI', loc: 'Chennai', desc: LONG },
  { id: '100000002', title: 'LLM Engineer', company: 'Beta Labs', loc: 'Chennai', desc: LONG },
  { id: '100000003', title: 'AI Engineer', company: 'Gamma Tech', loc: 'Remote', desc: 'short snippet' }, // needs detail page
  { id: '100000004', title: 'Senior Staff Architect', company: 'Delta', loc: 'Chennai', desc: LONG } // excluded by title filter
];
const FOUNDIT = [
  { jobId: 5550001, title: 'GenAI Engineer', companyName: 'Foundit Co', locations: 'Chennai, India', seoJdUrl: '/job/genai-engineer-foundit-co-chennai-5550001', minimumExperience: { years: 2 }, maximumExperience: { years: 5 }, skills: 'LangChain, RAG' },
  { jobId: 5550002, title: 'AI Engineer', companyName: 'LinkedIn Repost', locations: 'Chennai, India', seoJdUrl: '/job/ai-engineer-repost-chennai-5550002', applyUrl: 'https://www.linkedin.com/jobs/view/1', minimumExperience: { years: 1 } },
  { jobId: 5550003, title: 'ML Engineer', companyName: 'Too Senior', locations: 'Chennai, India', seoJdUrl: '/job/ml-engineer-too-senior-chennai-5550003', minimumExperience: { years: 9 } }
];
const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>Jobs</title></head><body>${body}</body></html>`;
const naukriCards = cards => cards.map(c => `
  <div class="srp-jobtuple-wrapper"><a class="title" href="/job-listings-${c.title.toLowerCase().replace(/\s+/g, '-')}-${c.id}">${c.title}</a>
  <a class="comp-name">${c.company}</a>${c.exp ? `<span class="expwdth">${c.exp}</span>` : ''}<span class="locWdth">${c.loc}</span><span class="job-desc">${c.desc}</span></div>`).join('');
const naukriSrp = cards => page(naukriCards(cards));
// 30 distinct jobs over 3 search pages (10 per page, like Naukri), plus location/experience cases.
const MANY = Array.from({ length: 30 }, (_, i) => ({ id: String(200000000 + i), title: `GenAI Engineer ${i}`, company: `Co ${i}`, loc: 'Chennai', desc: LONG }));
const FILTER_CASES = [
  { id: '300000001', title: 'AI Engineer Kochi', company: 'K', loc: 'Kochi', desc: LONG },
  { id: '300000002', title: 'AI Engineer Multi', company: 'M', loc: 'Pune, Chennai, Bengaluru', desc: LONG },
  { id: '300000003', title: 'AI Engineer WFH', company: 'R', loc: 'Remote', desc: LONG },
  { id: '300000004', title: 'AI Engineer Senior', company: 'S', loc: 'Chennai', exp: '8-12 Yrs', desc: LONG },
  { id: '300000005', title: 'AI Engineer Mid', company: 'X', loc: 'Chennai', exp: '2-5 Yrs', desc: LONG }
];
const INDEED = [
  { jk: 'aaa111', title: 'GenAI Engineer', company: 'Indeed Co', loc: 'Chennai, Tamil Nadu', desc: LONG },
  { jk: 'bbb222', title: 'LLM Engineer', company: 'Another Co', loc: 'Remote', desc: 'short' }
];
const indeedSrp = cards => page(cards.map(c => `
  <div class="job_seen_beacon" data-jk="${c.jk}"><h2><a data-jk="${c.jk}" href="/viewjob?jk=${c.jk}"><span title="${c.title}">${c.title}</span></a></h2>
  <span data-testid="company-name">${c.company}</span><div data-testid="text-location">${c.loc}</div><div class="job-snippet">${c.desc}</div></div>`).join(''));

function startMock(scenario) {
  const hits = { srp: 0, detail: 0, api: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = s => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(s); };
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const cookie = req.headers.cookie || '';
    const block = () => {
      if (scenario.mode === 'cloudflare') return html('<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Additional Verification Required</h1></body></html>'), true;
      if (scenario.mode === 'denied') return html('<!doctype html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don\'t have permission to access this server. Reference #18.abc</p></body></html>'), true;
      if (scenario.mode === 'login-gated' && !/session=ok/.test(cookie)) return html(page('<h2>Login</h2><input type="email"><input type="password"><button>Login</button>')), true;
      return false;
    };
    // Naukri-like
    if (/-jobs/.test(u.pathname) && !u.pathname.startsWith('/job-listings')) {
      hits.srp++;
      if (scenario.mode === 'challenge-once') {
        // A human check that "you" complete in the window after 7 s (after the scraper's 4.5 s page
        // wait, so the scraper does see it): the results then appear in place.
        return html(`<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Verify you are human</h1>
          <script>setTimeout(() => { document.title = 'Jobs'; document.body.innerHTML = ${JSON.stringify(naukriCards(CARDS))}; }, 7000);</script></body></html>`);
      }
      if (block()) return;
      if (scenario.mode === 'many') return html(naukriSrp(MANY.slice((hits.srp - 1) * 10, hits.srp * 10)));
      if (scenario.mode === 'filters') return html(naukriSrp(FILTER_CASES));
      return html(naukriSrp(scenario.mode === 'empty' ? [] : CARDS));
    }
    // Indeed-like
    if (u.pathname === '/jobs') {
      hits.srp++;
      if (block()) return;
      return html(indeedSrp(scenario.mode === 'empty' ? [] : INDEED));
    }
    if (u.pathname === '/viewjob') { hits.detail++; return html(page(`<div id="jobDescriptionText">${LONG}</div>`)); }
    if (u.pathname.startsWith('/job-listings')) { hits.detail++; return html(page(`<main><h1>Job</h1><section class="job-desc">${LONG}</section></main>`)); }
    // foundit-like
    if (u.pathname === '/srp/results') {
      hits.srp++;
      if (block()) return;
      return html(page(`<div id="r">loading</div><script>fetch('/middleware/jobsearch?' + location.search.slice(1)).then(r => r.json()).then(d => { document.getElementById('r').textContent = d.jobSearchResponse.data.length + ' results'; });</script>`));
    }
    if (u.pathname === '/middleware/jobsearch') { hits.api++; return json({ jobSearchResponse: { data: scenario.mode === 'empty' ? [] : FOUNDIT } }); }
    const d = u.pathname.match(/^\/middleware\/jobdetail\/(\d+)$/);
    if (d) return json({ jobDetailResponse: { description: `<p>${LONG}</p>` } });
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(c => server.close(c)) })));
}

// ---------- run a scraper as a child process against the mock ----------
function tmpEnv({ visibleMaxSearches = 6, roles = ['GenAI Engineer', 'LLM Engineer'], cookieFor, maxJobsPerRun = 15, cardFilters = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-test-'));
  const cfg = {
    _configured: true, maxJobsPerRun, minSalaryLPA: 9,
    india: { enabled: true, locations: ['Chennai'], roles },
    abroad: { enabled: false, locations: [], roles: [] },
    foundit: { maxMinExperience: 5, skipApplyHosts: ['linkedin.com'] },
    discovery: { visibleMaxSearches, ...(cardFilters ? { allowedLocations: ['Chennai', 'Coimbatore', 'Tamil Nadu', 'Remote'], maxMinExperience: 5 } : {}) },
    exclude: { titlePatterns: ['\\bstaff\\b', '\\barchitect\\b', '\\bintern\\b'], companyPatterns: [] }
  };
  fs.writeFileSync(path.join(dir, 'search.json'), JSON.stringify(cfg));
  let state = path.join(dir, 'none.json');
  if (cookieFor) {
    state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
  }
  return { dir, state, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function scrape(script, base, env, visible, { humanWaitMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(PW, script), ...(visible ? ['--visible'] : [])], {
      cwd: path.join(PW, '..'), timeout: 180000,
      env: {
        ...process.env, NAUKRI_BASE_URL: base, FOUNDIT_BASE_URL: base, INDEED_BASE_URL: base, JOB_AGENT_HEADLESS: '1', JOB_AGENT_VISIBLE_PAUSE_MS: '50',
        JOB_AGENT_CACHE_DIR: path.join(env.dir, 'cache'), JOB_AGENT_SEARCH_CONFIG: path.join(env.dir, 'search.json'), JOB_AGENT_STORAGE_STATE: env.state,
        JOB_AGENT_HUMAN_WAIT_MS: String(humanWaitMs), JOB_AGENT_HITL_FILE: path.join(env.dir, 'hitl.json'),
        JOB_AGENT_FORCE_ATTENDED: '1', JOB_AGENT_CHECKPOINT_DIR: path.join(env.dir, 'checkpoints')
      }
    }, (err, stdout) => {
      const line = String(stdout).trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
      try { resolve(JSON.parse(line)); } catch (_) { reject(err || new Error(`no JSON output: ${stdout}`)); }
    });
  });
}

// ---------- scraper tests ----------
test('NORMAL mode: accessible Naukri-like results -> structured jobs (filtered, deduped across searches)', async () => {
  const m = await startMock({ mode: 'ok' }); const env = tmpEnv();
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, false);
    assert.equal(r.mode, 'NORMAL');
    assert.equal(r.blocked, null);
    assert.equal(r.count, 3, `3 unique jobs (the architect job is excluded, the same cards on both searches are deduped): ${JSON.stringify(r.jobs.map(j => j.job_title))}`);
    for (const j of r.jobs) {
      assert.ok(j.job_title && j.company && /^http/.test(j.job_url) && j.description.length > 100, JSON.stringify(j));
      assert.equal(j.source_platform, 'naukri');
    }
    assert.equal(m.hits.detail, 1, 'the short-snippet job got its detail page read once');
    const again = await scrape('scrape_naukri.js', m.base, env, false);
    assert.equal(again.count, 0, 'second run: all jobs already in the seen cache');
  } finally { await m.close(); env.cleanup(); }
});

test('VISIBLE mode with the saved session reads logged-in results', async () => {
  const m = await startMock({ mode: 'login-gated' }); const env = tmpEnv({ cookieFor: true });
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, true);
    assert.equal(r.mode, 'VISIBLE');
    assert.equal(r.blocked, null);
    assert.equal(r.count, 3);
  } finally { await m.close(); env.cleanup(); }
});

test('VISIBLE mode without a valid session stops at the login wall (1 request, no retry)', async () => {
  const m = await startMock({ mode: 'login-gated' }); const env = tmpEnv();
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, true);
    assert.equal(r.blocked && r.blocked.kind, 'login');
    assert.equal(r.count, 0);
    assert.equal(m.hits.srp, 1, 'stopped after the first page');
  } finally { await m.close(); env.cleanup(); }
});

for (const [mode, kind] of [['cloudflare', 'cloudflare'], ['denied', 'access_denied']]) {
  test(`${kind} -> BLOCKED after the first page, never retried (NORMAL and VISIBLE)`, async () => {
    for (const visible of [false, true]) {
      const m = await startMock({ mode }); const env = tmpEnv();
      try {
        const r = await scrape('scrape_naukri.js', m.base, env, visible);
        assert.equal(r.blocked && r.blocked.kind, kind, JSON.stringify(r));
        assert.equal(r.count, 0);
        assert.equal(m.hits.srp, 1, `exactly one search page requested (visible=${visible})`);
        assert.match(r.note, /stopped, not retried or bypassed/);
      } finally { await m.close(); env.cleanup(); }
    }
  });
}

test('empty search -> 0 jobs, no error, no block', async () => {
  const m = await startMock({ mode: 'empty' }); const env = tmpEnv();
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, false);
    assert.equal(r.count, 0);
    assert.equal(r.blocked, null);
    assert.equal(r.error, undefined);
  } finally { await m.close(); env.cleanup(); }
});

test('VISIBLE mode respects the search limit (slow, observable)', async () => {
  const m = await startMock({ mode: 'ok' }); const env = tmpEnv({ visibleMaxSearches: 1 });
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, true);
    assert.equal(r.searches, 1);
    assert.equal(m.hits.srp, 1);
  } finally { await m.close(); env.cleanup(); }
});

test('foundit-like: API results + job details; LinkedIn reposts and over-experienced roles skipped', async () => {
  const m = await startMock({ mode: 'ok' }); const env = tmpEnv({ roles: ['GenAI Engineer'] });
  try {
    const r = await scrape('scrape_foundit.js', m.base, env, true);
    assert.equal(r.blocked, null);
    assert.equal(r.count, 1, JSON.stringify(r.jobs.map(j => j.company)));
    assert.equal(r.jobs[0].company, 'Foundit Co');
    assert.match(r.jobs[0].description, /RAG pipelines/);
    assert.equal(r.jobs[0].source_platform, 'foundit');
  } finally { await m.close(); env.cleanup(); }
});

test('foundit-like Access Denied -> BLOCKED, no API calls', async () => {
  const m = await startMock({ mode: 'denied' }); const env = tmpEnv();
  try {
    const r = await scrape('scrape_foundit.js', m.base, env, true);
    assert.equal(r.blocked && r.blocked.kind, 'access_denied');
    assert.equal(m.hits.api, 0);
    assert.equal(m.hits.srp, 1);
  } finally { await m.close(); env.cleanup(); }
});

test('maxJobsPerRun: every unique card is sent (30 > the old 15); jobs over the limit stay unseen', async () => {
  const m = await startMock({ mode: 'many' }); const env = tmpEnv({ roles: ['A', 'B', 'C'], maxJobsPerRun: 100 });
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, false);
    assert.equal(r.count, 30, JSON.stringify(r.stats));
  } finally { await m.close(); env.cleanup(); }
  const m2 = await startMock({ mode: 'many' }); const env2 = tmpEnv({ roles: ['A', 'B', 'C'], maxJobsPerRun: 12 });
  try {
    const r = await scrape('scrape_naukri.js', m2.base, env2, false);
    assert.equal(r.count, 12);
    assert.equal(r.stats.notSentOverLimit, 18, 'the rest are left for the next run');
  } finally { await m2.close(); env2.cleanup(); }
});

test('card pre-filter: Kochi-only and 8-12 years skipped; multi-city with Chennai and Remote kept', async () => {
  const m = await startMock({ mode: 'filters' }); const env = tmpEnv({ roles: ['A'], cardFilters: true });
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, false);
    const titles = r.jobs.map(j => j.job_title).sort();
    assert.deepEqual(titles, ['AI Engineer Mid', 'AI Engineer Multi', 'AI Engineer WFH']);
    assert.equal(r.stats.filteredLocation, 1);
    assert.equal(r.stats.filteredExperience, 1);
  } finally { await m.close(); env.cleanup(); }
});

test('VISIBLE mode: a check that you solve in the window -> the search continues (no second request)', async () => {
  const m = await startMock({ mode: 'challenge-once' }); const env = tmpEnv({ roles: ['GenAI Engineer'] });
  try {
    const r = await scrape('scrape_naukri.js', m.base, env, true, { humanWaitMs: 15000 });
    assert.equal(r.blocked, null, JSON.stringify(r));
    assert.equal(r.count, 3);
    assert.equal(r.stats.checksSolvedByYou, 1);
    assert.equal(m.hits.srp, 1, 'resumed on the same page');
  } finally { await m.close(); env.cleanup(); }
});

test('Indeed visible search: accessible results -> jobs; Cloudflare -> BLOCKED after 1 page', async () => {
  const m = await startMock({ mode: 'ok' }); const env = tmpEnv({ roles: ['GenAI Engineer'] });
  try {
    const r = await scrape('scrape_indeed.js', m.base, env, true);
    assert.equal(r.blocked, null);
    assert.equal(r.count, 2, JSON.stringify(r.jobs));
    assert.ok(r.jobs.every(j => j.source_platform === 'indeed' && /^indeed_/.test(j.job_id)));
    assert.match(r.jobs.find(j => j.company === 'Another Co').description, /RAG pipelines/, 'short snippet -> job page read');
  } finally { await m.close(); env.cleanup(); }
  const b = await startMock({ mode: 'cloudflare' }); const envB = tmpEnv();
  try {
    const r = await scrape('scrape_indeed.js', b.base, envB, true);
    assert.equal(r.blocked && r.blocked.kind, 'cloudflare');
    assert.equal(b.hits.srp, 1, 'stopped at the first page, no retries');
  } finally { await b.close(); envB.cleanup(); }
});

test('schedule: a slot fires once; a missed slot runs once the same day, never the next day', () => {
  const at = (h, m, day = 29) => new Date(2026, 8, day, h, m);
  const times = ['09:30', '18:30'];
  assert.equal(discovery.dueSlot(at(9, 0), times, null), null, 'before the first slot');
  assert.equal(discovery.dueSlot(at(9, 31), times, null), '2026-09-29T09:30');
  assert.equal(discovery.dueSlot(at(9, 45), times, '2026-09-29T09:30'), null, 'already ran');
  assert.equal(discovery.dueSlot(at(20, 0), times, '2026-09-29T09:30'), '2026-09-29T18:30', 'missed 18:30 runs at 20:00');
  assert.equal(discovery.dueSlot(at(8, 0, 30), times, '2026-09-29T09:30'), null, "yesterday's missed slot is not run next morning");
  assert.equal(discovery.nextSlot(at(10, 0), times), '2026-09-29T18:30');
  assert.equal(discovery.nextSlot(at(19, 0), times), '2026-09-30T09:30');
});

test('card filter unit: locations, "India", remote-only jobs, experience ranges', () => {
  const { makeCardFilter } = require('../common');
  const f = makeCardFilter({ discovery: { allowedLocations: ['Chennai', 'Remote', 'Tamil Nadu'], maxMinExperience: 5 } });
  assert.equal(f({ location: 'Hyderabad' }), 'location');
  assert.equal(f({ location: 'Hybrid - Chennai' }), null);
  assert.equal(f({ location: 'India' }), null);
  assert.equal(f({ location: '' }), null);
  assert.equal(f({ location: 'Bengaluru', remote_only: true }), null, 'foundit remote search: decided from the description');
  assert.equal(f({ location: 'Chennai', experience: '6-10 Yrs' }), 'experience');
  assert.equal(f({ location: 'Chennai', experience: '5-8 years' }), null);
  assert.equal(f({ location: 'Chennai', experience: '10+ years' }), 'experience');
});

test('daily limit: null in config = no limit; a number still caps', () => {
  const p = require.resolve('../application_log');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-test-'));
  const prev = process.env.JOB_AGENT_SEARCH_CONFIG;
  try {
    for (const [value, expected] of [[null, null], [25, 25]]) {
      fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ dailyLimitPerSite: value }));
      process.env.JOB_AGENT_SEARCH_CONFIG = path.join(dir, 's.json');
      delete require.cache[p];
      assert.equal(require('../application_log').dailyLimit(), expected);
    }
  } finally {
    if (prev === undefined) delete process.env.JOB_AGENT_SEARCH_CONFIG; else process.env.JOB_AGENT_SEARCH_CONFIG = prev;
    delete require.cache[p];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- paste-a-job + feeder ----------
test('platform detection and scraper-compatible job ids', () => {
  assert.equal(discovery.detectPlatform('https://www.naukri.com/job-listings-ai-engineer-acme-chennai-123456789'), 'naukri');
  assert.equal(discovery.detectPlatform('https://www.foundit.in/job/genai-engineer-x-chennai-5550001'), 'foundit');
  assert.equal(discovery.detectPlatform('https://in.indeed.com/viewjob?jk=abc123'), 'indeed');
  assert.equal(discovery.detectPlatform('https://boards.greenhouse.io/acme/jobs/42'), 'external');
  assert.equal(discovery.jobIdFor('naukri', 'https://www.naukri.com/job-listings-ai-engineer-acme-chennai-123456789'), 'naukri_123456789');
  assert.equal(discovery.jobIdFor('foundit', 'https://www.foundit.in/job/genai-engineer-x-chennai-5550001'), 'foundit_5550001');
  assert.equal(discovery.jobIdFor('indeed', 'https://in.indeed.com/viewjob?jk=abc123'), 'indeed_abc123');
});

test('paste a job: Indeed needs a pasted description; blocked pages need one too; filters apply', () => {
  const keep = j => !/architect/i.test(j.job_title);
  assert.match(discovery.buildManualJob({ url: 'https://in.indeed.com/viewjob?jk=abc' }).error, /Indeed pages are not read automatically/);
  const indeed = discovery.buildManualJob({ url: 'https://in.indeed.com/viewjob?jk=abc', title: 'AI Engineer', description: LONG });
  assert.equal(indeed.job.source_platform, 'indeed');
  assert.equal(indeed.job.region, 'india');
  assert.match(discovery.buildManualJob({ url: 'https://www.naukri.com/job-listings-x-123456789' }, { fetched: { blocked: { kind: 'access_denied' } } }).error, /blocked automatic reading \(access_denied\)/);
  const fetched = discovery.buildManualJob({ url: 'https://boards.greenhouse.io/acme/jobs/42' }, { fetched: { title: 'GenAI Engineer', company: 'Acme', description: LONG } });
  assert.equal(fetched.job.job_title, 'GenAI Engineer');
  assert.equal(fetched.job.source_platform, 'external');
  assert.match(discovery.buildManualJob({ url: 'https://boards.greenhouse.io/a/1', title: 'Principal Architect', description: LONG }, { keep }).error, /exclusion filters/);
  assert.match(discovery.buildManualJob({ url: 'ftp://x' }).error, /https/);
});

test('feeder: one job at a time into the pipeline, skips logged URLs, survives errors', async () => {
  const logged = new Set(['https://x/already-logged']);
  const order = []; let active = 0; let maxActive = 0;
  const postScoreJob = async job => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 30));
    order.push(job.job_url);
    active--;
    if (job.job_url.endsWith('/boom')) throw new Error('pipeline down');
  };
  const f = discovery.createFeeder({ postScoreJob, isLogged: u => logged.has(u) });
  const n = f.enqueue([{ job_url: 'https://x/1' }, { job_url: 'https://x/already-logged' }, { job_url: 'https://x/boom' }, { job_url: 'https://x/2' }, { job_url: 'https://x/1' }]);
  assert.equal(n, 3, 'logged + duplicate URLs are not queued');
  await f.idle();
  assert.deepEqual(order, ['https://x/1', 'https://x/boom', 'https://x/2']);
  assert.equal(maxActive, 1, 'never more than one job in the pipeline at a time');
  assert.equal(f.stats.failed, 1);
  assert.equal(f.stats.sent, 2);
});

test('feeder concurrency: at most N jobs in the pipeline, no job sent twice, in-flight URLs deduped', async () => {
  let active = 0; let maxActive = 0;
  const sent = [];
  const postScoreJob = async job => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 40));
    sent.push(job.job_url);
    active--;
  };
  const f = discovery.createFeeder({ postScoreJob, isLogged: () => false, concurrency: () => 3 });
  const urls = Array.from({ length: 8 }, (_, i) => ({ job_url: `https://x/${i}` }));
  f.enqueue(urls);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(f.enqueue([{ job_url: 'https://x/0' }]), 0, 'a job already in the pipeline is not queued again');
  await f.idle();
  assert.equal(maxActive, 3);
  assert.equal(sent.length, 8);
  assert.equal(new Set(sent).size, 8);
  assert.equal(f.pending(), 0);
});

test('feeder: "n8n not ready" (503) is retried after a pause; HTTP 500 is not', async () => {
  const calls = {};
  const postScoreJob = async job => {
    calls[job.job_url] = (calls[job.job_url] || 0) + 1;
    if (job.job_url.endsWith('/flaky') && calls[job.job_url] < 3) throw new Error('HTTP 503');
    if (job.job_url.endsWith('/half-run')) throw new Error('HTTP 500');
  };
  const pauses = [];
  const f = discovery.createFeeder({ postScoreJob, isLogged: () => false, sleep: async ms => { pauses.push(ms); }, retryDelays: [5, 10, 20] });
  f.enqueue([{ job_url: 'https://x/flaky' }, { job_url: 'https://x/half-run' }, { job_url: 'https://x/ok' }]);
  await f.idle();
  assert.equal(calls['https://x/flaky'], 3, '2 transient failures then success');
  assert.deepEqual(pauses, [5, 10]);
  assert.equal(calls['https://x/half-run'], 1, 'a possibly half-run chain is never re-sent');
  assert.deepEqual({ sent: f.stats.sent, failed: f.stats.failed, retried: f.stats.retried }, { sent: 2, failed: 1, retried: 2 });
});
