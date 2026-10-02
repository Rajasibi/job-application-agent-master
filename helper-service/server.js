// Job Agent Helper Service — http://127.0.0.1:9999
// n8n orchestrates; this service does everything that needs files or a browser:
// prompt building, score parsing, CV/cover-letter saving + PDF, scraping, preparing
// applications (review mode, never submits), the local log, and the review queue.
//
//   GET  /health                 service status
//   GET  /applications           full local log
//   GET  /pending                NEEDS_REVIEW + SECURITY_CHALLENGE records (what's left for you)
//   POST /recheck                {which: applied|all} visible read-only re-check (site's Applied state)
//   POST /prompt                 {kind: score|cv|cover, job} -> Ollama request + settings
//   POST /parse-score            {job, content, final} -> job with score fields
//   POST /save-cv                {job, content} -> job + cv_md/cv_pdf
//   POST /save-cover-letter      {job, content} -> job + cover_letter_path
//   POST /scrape/:platform       run a scraper -> {jobs}
//   POST /apply                  {job} -> prefill the application form (headless)
//   POST /log                    {record} -> local upsert, returns Sheets settings
//   POST /review/:id             open the filled form in a visible browser
//   POST /mark/:id               {status: APPLIED|REJECTED, notes} -> update log + Sheet
//   POST /retry/:id              re-prepare a FAILED job (e.g. after LOGIN_ONCE); rebuilds the CV if missing
//   POST /sheets/backfill        queue all local records for the Google Sheet (upsert by Job URL)
//   POST /discover/visible/:p    visible search (naukri | foundit) with the saved session -> pipeline
//   POST /discover/manual        {url, title?, company?, location?, description?} "paste a job" -> pipeline
//   GET  /discovery/status       last discovery run per platform + feeder queue
//   POST /llm/api/chat           Ollama-format chat -> configured LLM backend (llm_backend.js)
//   POST /auto-apply/pending     auto-apply the waiting jobs that qualify (policy auto + score)

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PW = path.join(ROOT, 'playwright');
const OUTPUT_DIR = path.join(ROOT, 'output');
const LOGFILE = path.join(ROOT, 'setup', 'logs', 'helper.log');
const PORT = 9999;
const ALLOWED_ORIGINS = new Set(['http://localhost:8765', 'http://127.0.0.1:8765']);

const appLog = require(path.join(PW, 'application_log.js'));
const { makeJobFilter, loadSearchConfig, seenCache } = require(path.join(PW, 'common.js'));
const discovery = require('./discovery');
const { waitingStatus } = require(path.join(PW, 'browser_modes.js'));
const VISIBLE_SEARCH = ['naukri', 'foundit', 'indeed']; // visible search (your saved session, slow, stops at a block)

// ---------- env ----------

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnv();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
// n8n posts every LLM request to ollama_url. It points at this helper's /llm/api/chat proxy, which
// sends it to the configured backend (local Ollama or Ollama Cloud, local as fallback).
const settings = () => ({
  ollama_url: `http://127.0.0.1:${PORT}/llm/api/chat`,
  model: env('OLLAMA_MODEL', 'qwen2.5:7b-instruct'),
  threshold: Number(env('FIT_THRESHOLD', 70)),
  n8n_url: env('N8N_WEBHOOK_URL', 'http://localhost:5678').replace(/\/$/, '')
});

fs.mkdirSync(path.dirname(LOGFILE), { recursive: true });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOGFILE, line);
  process.stdout.write(line);
}

const llm = require('./llm_backend').createLlm({ log: m => log(m) });
const { outcomeFor } = require('./outcome');
const atsBoards = require('./ats_boards');
const mailIntake = require('./mail_intake');
const recovery = require(path.join(PW, 'recovery.js'));
// Human-readable "Source" for the Sheet.
const SOURCE_LABEL = { email: 'Email alert', manual: 'Pasted link', 'ats:greenhouse': 'Greenhouse', 'ats:lever': 'Lever', 'ats:ashby': 'Ashby', 'ats:smartrecruiters': 'SmartRecruiters', 'ats:workable': 'Workable' };
// One reused visible browser per site for visible searches and checks (browser_keeper.js).
const keeper = require('./browser_keeper').createKeeper({ log: m => log(m) });

// Google Sheets sync runs in the background from an outbox (see sheets_sync.js), so a slow
// or unavailable Sheets API never blocks the pipeline. n8n's inline Sheets node is kept off
// by returning sheets_enabled: false from /log.
const sheetIdEnv = env('GOOGLE_SHEETS_ID', '');
const sheets = require('./sheets_sync').createSheetsSync({
  sheetId: /your_google_sheets_id/i.test(sheetIdEnv) ? '' : sheetIdEnv,
  keyFile: path.resolve(ROOT, env('GOOGLE_SERVICE_ACCOUNT_FILE', 'config/google-service-account.json')),
  outboxPath: path.join(ROOT, 'setup', 'sheets_outbox.json'),
  log
});

// ---------- discovery feeder ----------
// Discovered jobs (visible search, pasted jobs) go through the SAME pipeline as scheduled scrapes:
// n8n /webhook/score-job, one at a time, waiting for each chain to finish.
function postScoreJob(job) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(job);
    const req = http.request(`${settings().n8n_url}/webhook/score-job`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); res.on('end', () => (res.statusCode < 400 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)))); });
    req.setTimeout(90 * 60 * 1000, () => req.destroy(new Error('no response after 90 min')));
    req.on('error', reject);
    req.end(body);
  });
}
// Jobs in the pipeline at once: LLM_CONCURRENCY on the cloud backend, always 1 on local Qwen.
const pipelineConcurrency = () => (llm.status().backend === 'ollama_cloud' ? Number(env('LLM_CONCURRENCY', 1)) || 1 : 1);
// "Already handled": a record exists beyond DISCOVERED (a DISCOVERED record is just the queue entry).
const alreadyHandled = url => { const r = appLog.findByUrl(url); return !!r && r.status !== 'DISCOVERED'; };
const feeder = discovery.createFeeder({
  postScoreJob, isLogged: alreadyHandled, log, concurrency: pipelineConcurrency,
  onQueued: job => recordStage(job, 'DISCOVERED')
});

// Writes a pipeline stage for a job (forward-only, see application_log.canMove) and pushes it to the
// Google Sheet right away. Returns the stored record.
function recordStage(job, status, extra = {}, opts = {}) {
  if (!job || !job.job_url) return null;
  const stored = appLog.upsert(toRecord({ ...job, ...extra, status }), opts);
  sheets.enqueue(stored);
  return stored;
}
const discoveryStatus = discovery.statusStore(path.join(ROOT, 'setup', 'discovery_status.json'));

// "Paste a job": validate -> read the page if allowed (never Indeed) -> filters -> dedupe -> pipeline.
async function manualIntake(body) {
  let platform;
  try { platform = discovery.detectPlatform(String(body.url || '').trim()); } catch (_) { return { error: 'Paste a full job link starting with https://' }; }
  const existing = appLog.findByUrl(new URL(String(body.url).trim()).toString());
  if (existing && existing.status !== 'DISCOVERED') return { error: `Already in your log as ${existing.status} (${existing.company} - ${existing.job_title}).` };

  let fetched = null;
  const hasDescription = String(body.description || '').trim().length >= discovery.MIN_DESCRIPTION;
  if (!hasDescription && platform !== 'indeed') {
    fetched = await runScript('fetch_job.js', ['--url', String(body.url).trim()], 60 * 1000);
    if (fetched.error) fetched = { error: fetched.error };
  }
  let keep = () => true;
  try { keep = makeJobFilter(loadSearchConfig()); } catch (_) {}
  const built = discovery.buildManualJob(body, { fetched, keep });
  if (built.error) return built;

  const job = built.job;
  const cache = seenCache(job.source_platform);
  cache.add(job.job_id);
  cache.save();
  const queued = feeder.enqueue([job]);
  if (queued) {
    const b = inflight.manual && Date.now() - inflight.manual.at < INFLIGHT_TTL_MS ? inflight.manual : (inflight.manual = { urls: new Set(), at: Date.now() });
    b.urls.add(job.job_url);
    saveInflight();
    updateKeepAwake();
  }
  discoveryStatus.record('manual', { mode: 'PASTE', found: 1, queued, note: `${job.company} - ${job.job_title} (${job.source_platform})` });
  log(`manual job: ${job.company} - ${job.job_title} (${job.source_platform}) -> ${queued ? 'sent to the pipeline' : 'already queued'}`);
  return { queued: queued > 0, job: { job_url: job.job_url, company: job.company, job_title: job.job_title, platform: job.source_platform }, read_from_page: !!(fetched && !fetched.blocked && !fetched.error) };
}

// ---------- helpers ----------

const readText = rel => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const readJson = rel => JSON.parse(readText(rel));
const slug = (s, n = 40) => String(s || 'unknown').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, n) || 'unknown';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// One browser task at a time per queue, so scrapes and applies never pile up on this machine.
function makeQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  const queue = fn => {
    pending++;
    const run = tail.then(fn, fn);
    tail = run.catch(() => {}).finally(() => { pending--; });
    return run;
  };
  queue.busy = () => pending > 0;
  return queue;
}
const scrapeQueue = makeQueue();
const applyQueue = makeQueue();

// Kills a process and all its children (Chromium). proc.kill() alone leaves browsers
// running on Windows, and they keep the stdout pipe open so 'close' never fires.
function killTree(pid) {
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
}

// Runs a node script and returns the JSON object printed on its last stdout line.
// Resolves exactly once: on exit (not 'close', which orphaned children can block) or on timeout.
function runScript(script, args, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [path.join(PW, script), ...args], { cwd: ROOT, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const last = stdout.trim().split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop();
      try { return resolve(JSON.parse(last)); } catch (_) {}
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 60000)} min` : `exited ${code}`;
      resolve({ success: false, error: `${script} ${why}: ${(stderr || stdout).trim().slice(-400) || 'no output'}` });
    };
    const timer = setTimeout(() => { killTree(proc.pid); setTimeout(() => finish(null, true), 3000); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', e => { stderr += e.message; finish(null, false); });
    // Give buffered stdout a moment to flush after exit.
    proc.on('exit', code => setTimeout(() => finish(code, false), 500));
  });
}

// Jobs handed to n8n per scraper that haven't been logged yet. A new scrape of the same
// platform is skipped while its previous batch is still in the pipeline (expires after 6 h).
// Persisted to setup/inflight.json so a helper restart keeps the lock and keep-awake state.
const INFLIGHT_TTL_MS = 6 * 60 * 60 * 1000;
const INFLIGHT_PATH = path.join(ROOT, 'setup', 'inflight.json');
const inflight = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(INFLIGHT_PATH, 'utf8'));
    return Object.fromEntries(Object.entries(raw).map(([p, b]) => [p, { urls: new Set(b.urls), at: b.at }]));
  } catch (_) { return {}; }
})();
function saveInflight() {
  try {
    const plain = Object.fromEntries(Object.entries(inflight).map(([p, b]) => [p, { urls: [...b.urls], at: b.at }]));
    fs.writeFileSync(INFLIGHT_PATH, JSON.stringify(plain));
  } catch (_) {}
}
function batchBusy(platform) {
  const b = inflight[platform];
  return !!b && b.urls.size > 0 && Date.now() - b.at < INFLIGHT_TTL_MS;
}

// Keep Windows from idle-sleeping while jobs are in the pipeline, so a batch isn't cut off
// halfway (the display may still turn off; closing the lid still sleeps the laptop).
// A hidden PowerShell holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED until it's killed.
let awakeProc = null;
const KEEP_AWAKE_PS = [
  "$t = Add-Type -Name KA -Namespace JobAgent -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
  '$null = $t::SetThreadExecutionState([uint32]2147483649)',
  'while ($true) { Start-Sleep -Seconds 60 }'
].join('; ');
function pipelineBusy() {
  return Object.keys(inflight).some(batchBusy) || scrapeQueue.busy() || applyQueue.busy() || feeder.pending() > 0 || autoPendingRunning || scheduleRunning || !!recheckRunning || keeper.busy();
}
function updateKeepAwake() {
  const busy = pipelineBusy();
  if (busy && !awakeProc) {
    awakeProc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', KEEP_AWAKE_PS], { windowsHide: true, stdio: 'ignore' });
    awakeProc.on('exit', () => { awakeProc = null; });
    awakeProc.on('error', e => { log(`keep-awake failed: ${e.message}`); awakeProc = null; });
    log('keep-awake on (jobs in progress)');
  } else if (!busy && awakeProc) {
    killTree(awakeProc.pid);
    awakeProc = null;
    log('keep-awake off (idle; normal sleep allowed)');
  }
}
process.on('exit', () => { if (awakeProc) try { process.kill(awakeProc.pid); } catch (_) {} });

function profile() {
  try { return readJson('profile.json'); } catch (_) { return {}; }
}

function searchConfig() {
  try { return readJson('config/search.json'); } catch (_) { return {}; }
}

function fillTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function templateVars() {
  const p = profile();
  const cfg = searchConfig();
  const roles = [...new Set([...(cfg.india?.roles || []), ...(cfg.abroad?.roles || [])])];
  const locs = [
    ...(cfg.india?.enabled ? cfg.india.locations || [] : []),
    ...(cfg.abroad?.enabled ? (cfg.abroad.locations || []).map(l => `${l.city}, ${l.country}`) : [])
  ];
  let master = '';
  try { master = readText('cv/master_profile.md'); } catch (_) {}
  return {
    NAME: p.fullName || 'the candidate',
    PROFILE: master,
    TARGET_ROLES: roles.join(', ') || 'see profile',
    LOCATIONS: locs.join('; ') || 'see profile',
    MIN_SALARY: cfg.minSalaryLPA ? `${cfg.minSalaryLPA} LPA (India)` : 'not specified',
    THRESHOLD: settings().threshold
  };
}

function jobText(job) {
  return `Job Title: ${job.job_title || ''}\nCompany: ${job.company || ''}\nLocation: ${job.location || ''}\nPlatform: ${job.source_platform || ''}\n\nJob Description:\n${String(job.description || '').slice(0, 4000)}`;
}

const NUM_CTX = 6144;

function buildPrompt(kind, job) {
  const s = settings();
  const vars = templateVars();
  let system;
  let user;
  let options;
  let format;

  if (kind === 'score') {
    system = fillTemplate(readText('prompts/fit_scorer.md'), vars);
    user = jobText(job);
    // Every request kind must use the SAME num_ctx: Ollama reloads the whole model whenever
    // it changes, and on this low-RAM machine that reload times out mid-pipeline.
    options = { temperature: 0.2, num_predict: 700, num_ctx: NUM_CTX };
    format = 'json';
  } else if (kind === 'cv') {
    const variant = String(job.cv_variant || 'A').toUpperCase() === 'B' ? 'b' : 'a';
    system = fillTemplate(readText('prompts/cv_tailor.md'), vars);
    user = `JOB DESCRIPTION:\n${jobText(job)}\n\n---\n\nBASE CV:\n${readText(`cv/cv_variant_${variant}.md`)}`;
    // ~2.8k prompt tokens + 2.2k output fits in NUM_CTX; a tailored CV is about as long as the base CV.
    options = { temperature: 0.4, num_predict: 2200, num_ctx: NUM_CTX };
  } else if (kind === 'cover') {
    system = fillTemplate(readText('prompts/cover_letter.md'), vars);
    user = `${jobText(job)}\n\nTop matching signals:\n${(job.top_matches || []).join('\n')}\n\nCandidate profile:\n${vars.PROFILE}`;
    options = { temperature: 0.6, num_predict: 700, num_ctx: NUM_CTX };
  } else {
    throw new Error(`Unknown prompt kind: ${kind}`);
  }

  // keep_alive keeps Qwen loaded between jobs, avoiding the 30-90s cold start on every request.
  const request = { model: s.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, keep_alive: '2h', options };
  if (format) request.format = format;
  return { ollama_url: s.ollama_url, ollama_request: request, threshold: s.threshold, job };
}

const toBool = v => v === true || /^(true|yes|1)$/i.test(String(v || '').trim());

// Qwen usually returns clean JSON with format:"json", but tolerate fences / prose / trailing commas.
function parseScore(job, content, final) {
  const text = String(content || '');
  let data = null;
  const candidates = [text, text.replace(/```(?:json)?/gi, ''), (text.match(/\{[\s\S]*\}/) || [''])[0]];
  for (const c of candidates) {
    try { data = JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); break; } catch (_) {}
  }
  const threshold = settings().threshold;
  if (!data || data.score === undefined || Number.isNaN(Number(data.score))) {
    if (!final) return { ok: false, threshold, job };
    return {
      ok: true, passed: false, threshold,
      job: { ...job, score: 0, verdict: 'REJECT', rejection_reason: `LLM returned unparseable output: ${text.slice(0, 150)}`, scored_at: new Date().toISOString() }
    };
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(data.score))));
  const scored = {
    ...job,
    score,
    verdict: data.verdict || (score >= threshold ? 'GOOD_MATCH' : 'REJECT'),
    top_matches: Array.isArray(data.top_matches) ? data.top_matches.map(String) : [],
    gaps: Array.isArray(data.gaps) ? data.gaps.map(String) : [],
    cv_variant: String(data.cv_variant || 'A').toUpperCase() === 'B' ? 'B' : 'A',
    cover_letter_needed: toBool(data.cover_letter_needed),
    rejection_reason: data.rejection_reason || (score < threshold ? `Score ${score} below threshold ${threshold}` : ''),
    scored_at: new Date().toISOString()
  };
  return { ok: true, passed: score >= threshold, threshold, job: scored };
}

function stripFences(text) {
  return String(text || '').trim().replace(/^```(?:markdown|md|text)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
}

async function saveDocument(job, content, kind) {
  const body = stripFences(content);
  if (body.length < 100) throw new Error(`Ollama returned an empty ${kind}`);
  const dir = path.join(OUTPUT_DIR, `${stamp().slice(0, 10)}_${slug(job.company, 30)}_${slug(job.job_title, 30)}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = kind === 'cv' ? 'cv' : 'cover_letter';
  const md = path.join(dir, `${base}.md`);
  const pdf = path.join(dir, `${base}.pdf`);
  fs.writeFileSync(md, body, 'utf-8');
  const r = await runScript('render_pdf.js', ['--in', md, '--out', pdf], 120000);
  if (!r.success) throw new Error(`PDF render failed: ${r.error}`);
  return { md, pdf };
}

const SCRAPERS = {
  naukri: 'scrape_naukri.js', indeed: 'scrape_indeed.js', foundit: 'scrape_foundit.js',
  linkedin: 'scrape_linkedin.js', wttj: 'scrape_wttj.js', tier1: 'scrape_tier1.js'
};

function applyScriptFor(platform) {
  const p = String(platform || '');
  if (p.startsWith('tier1')) return 'tier1_form_fill.js';
  return {
    naukri: 'naukri_apply.js', indeed: 'indeed_apply.js', foundit: 'foundit_apply.js',
    linkedin: 'linkedin_apply.js', wttj: 'wttj_apply.js', external: 'external_apply.js'
  }[p] || null;
}

function applyArgs(rec, mode) {
  const args = ['--url', rec.job_url, '--company', rec.company || 'unknown', '--title', rec.job_title || 'unknown', '--mode', mode];
  if (rec.cv_pdf) args.push('--cv', rec.cv_pdf);
  if (rec.cover_letter_path) args.push('--coverletter', rec.cover_letter_path);
  if (rec.external_apply_url && validUrl(rec.external_apply_url)) args.push('--external', rec.external_apply_url);
  return args;
}

function validUrl(u) {
  try { return ['https:', 'http:'].includes(new URL(u).protocol); } catch (_) { return false; }
}

// Auto-apply (config/submission_policy.json): only native one-click jobs (no company-site link) on a
// platform whose policy is 'auto', with a verified handler and score >= autoMinScore.
const engine = require(path.join(PW, 'application_engine.js'));
const AUTO_HANDLERS = { naukri: 'naukri_apply.js', foundit: 'foundit_apply.js' };
const AUTO_GAP_MS = 20 * 1000; // fixed pause between automatic applications (slow, observable)
function wantsAutoApply(job) {
  const file = AUTO_HANDLERS[job.source_platform];
  if (!file || job.external_apply_url) return false;
  try {
    const { handler } = require(path.join(PW, file));
    return engine.autoApplyAllowed(engine.loadPolicy(), { platform: job.source_platform, handler, score: job.score ?? job.fit_score });
  } catch (_) { return false; }
}

// Which engine mode a job gets:
//   auto   - only if the site's terms permit it and policy + score allow (currently never: manual)
//   check  - Naukri / foundit: the visible browser with your profile finds out exactly what the job
//            needs (one-click ready, company form + missing fields, closed, already applied). Read-only.
//   prefill- everything else (Indeed: Indeed Apply is never automated).
const CHECK_PLATFORMS = ['naukri', 'foundit'];
function applyMode(job) {
  if (wantsAutoApply(job)) return 'auto';
  return CHECK_PLATFORMS.includes(job.source_platform) ? 'check' : 'prefill';
}
const OUTCOME_PAUSE_MS = 5000; // fixed pause between visible checks (slow, observable)

// Runs the application engine (via the platform script), records APPLICATION_STARTED, and maps the
// result to the stored status + next action (outcome.js). A crash or bad output becomes FAILED for
// this job only, never for the whole loop.
async function prepareApplication(job, { force = false } = {}) {
  if (!validUrl(job.job_url)) return { ...job, status: 'FAILED', notes: 'Invalid job URL', next_action: 'Nothing: invalid job link' };
  const platform = job.source_platform;
  const script = applyScriptFor(platform);
  if (!script) return { ...job, status: 'FAILED', notes: `No apply script for platform ${platform}` };
  const gate = appLog.canPrepare(job.job_url, platform, { force });
  if (!gate.ok) return { ...job, skipped: true, status: '', notes: gate.reason };

  const mode = applyMode(job);
  recordStage(job, 'APPLICATION_STARTED', { next_action: mode === 'prefill' ? 'Nothing yet: preparing the application' : `Nothing yet: checking the job on ${platform} in the agent's window` }, { restart: true });
  const args = mode === 'auto' ? [...applyArgs(job, 'auto'), '--score', String(job.score ?? job.fit_score)] : applyArgs(job, mode);
  const run = () => runScript(script, args, mode === 'prefill' ? 5 * 60 * 1000 : 15 * 60 * 1000);
  const r = mode === 'prefill' ? await run() : await keeper.use(platform, run);
  if (mode !== 'prefill') {
    log(`${mode} ${job.company} - ${job.job_title} (${platform}): ${r.status || r.error}${r.detail ? ` [${r.detail}]` : ''}`);
    await new Promise(res => setTimeout(res, mode === 'auto' ? AUTO_GAP_MS : OUTCOME_PAUSE_MS));
  }
  const o = outcomeFor(r, job);
  const needs = Array.isArray(r.needs_input) ? r.needs_input : (r.unanswered || []);
  const parked = o.status === 'SECURITY_CHALLENGE' && recovery.enabled() && recovery.HUMAN_SOLVABLE.has(r.challenge || '');
  return {
    ...job,
    status: o.status,
    next_action: o.next_action,
    detail: o.detail,
    security_status: o.status === 'SECURITY_CHALLENGE' ? (r.challenge || 'blocked') : (o.status === 'APPLIED' ? 'clear' : ''),
    checkpoint_status: parked ? 'Parked — press Resolve now while at the laptop' : '',
    screenshot: r.screenshot || '',
    form_url: r.form_url || '',
    external_apply_url: r.external_apply_url || job.external_apply_url,
    needs_input: needs.length ? needs.slice(0, 10).join(' | ') : '',
    notes: o.notes
  };
}

function toRecord(d) {
  return {
    job_url: d.job_url,
    company: d.company,
    job_title: d.job_title,
    platform: d.source_platform || d.platform,
    region: d.region,
    location: d.location,
    fit_score: d.score ?? d.fit_score,
    cv_variant: d.cv_variant,
    cover_letter: d.cover_letter_path ? 'Yes' : (d.cover_letter || 'No'),
    status: d.status,
    notes: d.notes || d.rejection_reason || '',
    cv_pdf: d.cv_pdf,
    cover_letter_path: d.cover_letter_path,
    screenshot: d.screenshot,
    form_url: d.form_url,
    external_apply_url: d.external_apply_url,
    needs_input: d.needs_input,
    next_action: d.next_action,
    detail: d.detail,
    job_id: d.job_id,
    source: d.source || SOURCE_LABEL[d.discovered_via] || (d.discovered_via ? String(d.discovered_via) : undefined),
    discovered_via: d.discovered_via,
    security_status: d.security_status,
    checkpoint_status: d.checkpoint_status,
    // Kept (trimmed) so /retry can rebuild a missing CV without re-scraping.
    description: d.description ? String(d.description).slice(0, 4000) : undefined
  };
}

// Rebuilds the pipeline job object from a stored log record.
function recordToJob(rec) {
  return {
    job_url: rec.job_url,
    company: rec.company,
    job_title: rec.job_title,
    source_platform: rec.platform,
    region: rec.region || 'india',
    location: rec.location,
    description: rec.description,
    score: rec.fit_score,
    cv_variant: rec.cv_variant,
    cover_letter_needed: rec.cover_letter === 'Yes',
    cv_pdf: rec.cv_pdf,
    cover_letter_path: rec.cover_letter_path,
    external_apply_url: rec.external_apply_url,
    job_id: rec.job_id,
    detail: rec.detail
  };
}

// Auto-apply the jobs already waiting in the log that qualify now (policy auto + score), one by one.
let autoPendingRunning = false;
function qualifiesForAutoNow(rec) {
  return !appLog.FINAL.includes(rec.status) && rec.status !== 'REJECTED' && !!rec.cv_pdf && fs.existsSync(rec.cv_pdf) && wantsAutoApply(recordToJob(rec));
}
async function autoApplyPending() {
  if (autoPendingRunning) return { error: 'Already applying the waiting jobs.' };
  const list = appLog.load().applications.filter(qualifiesForAutoNow);
  if (!list.length) return { queued: 0 };
  autoPendingRunning = true;
  (async () => {
    for (const rec of list) {
      const r = await retryApplication(appLog.find(rec.id) || rec).catch(e => ({ error: e.message }));
      log(`auto-apply waiting job ${rec.company} - ${rec.job_title}: ${r.error || r.record?.status}`);
    }
  })().finally(() => { autoPendingRunning = false; updateKeepAwake(); });
  updateKeepAwake();
  return { queued: list.length, jobs: list.map(r => `${r.company} - ${r.job_title} (${r.fit_score})`) };
}

// Re-check jobs in the visible browser (read-only), one at a time, 5 s apart:
//   'applied' - jobs waiting for you to click Apply: if the site now shows Applied -> APPLIED
//   'all'     - every open Naukri / foundit job (e.g. the ones whose earlier headless check was blocked)
let recheckRunning = null;
function recheckTargets(which) {
  return appLog.load().applications.filter(a => {
    if (!CHECK_PLATFORMS.includes(a.platform) || appLog.FINAL.includes(a.status) || !a.cv_pdf) return false;
    if (which === 'applied') return a.status === 'NEEDS_REVIEW' && a.detail === 'READY_ONE_CLICK';
    return ['NEEDS_REVIEW', 'SECURITY_CHALLENGE', 'FAILED', 'APPLICATION_STARTED', 'CV_READY'].includes(a.status) && a.detail !== 'CLOSED';
  });
}
function startRecheck(which) {
  if (recheckRunning) return { error: `A re-check (${recheckRunning.which}) is already running: ${recheckRunning.done}/${recheckRunning.total} done.` };
  const list = recheckTargets(which);
  if (!list.length) return { queued: 0 };
  recheckRunning = { which, total: list.length, done: 0, changed: {}, started: new Date().toISOString() };
  updateKeepAwake();
  (async () => {
    for (const rec of list) {
      const r = await retryApplication(appLog.find(rec.id) || rec).catch(e => ({ error: e.message }));
      recheckRunning.done++;
      const s = r.record ? r.record.status : 'ERROR';
      recheckRunning.changed[s] = (recheckRunning.changed[s] || 0) + 1;
    }
  })().finally(() => {
    log(`re-check ${which}: ${JSON.stringify(recheckRunning.changed)}`);
    lastRecheck = { ...recheckRunning, finished: new Date().toISOString() };
    recheckRunning = null;
    updateKeepAwake();
  });
  return { queued: list.length };
}
let lastRecheck = null;

function autoApplySummary() {
  const policy = engine.loadPolicy();
  return {
    platforms: Object.entries(policy.platforms || {}).filter(([, v]) => v === 'auto').map(([k]) => k),
    min_score: typeof policy.autoMinScore === 'number' ? policy.autoMinScore : 80,
    running: autoPendingRunning,
    waiting_jobs_that_qualify: appLog.load().applications.filter(qualifiesForAutoNow).length
  };
}

async function retryApplication(rec) {
  if (appLog.FINAL.includes(rec.status)) return { error: `This job is already ${rec.status}` };
  const job = recordToJob(rec);
  if (!job.cv_pdf || !fs.existsSync(job.cv_pdf)) {
    if (!job.description) return { error: 'No tailored CV and no stored job description, so it cannot be rebuilt' };
    // Re-run CV tailoring + routing in n8n; the pipeline logs the new outcome itself.
    fetch(`${settings().n8n_url}/webhook/build-cv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
    }).catch(e => log(`retry build-cv failed: ${e.message}`));
    return { queued: true, message: 'Rebuilding the tailored CV; the job will reappear when ready.' };
  }
  const result = await applyQueue(() => prepareApplication(job, { force: true }));
  if (result.skipped) return { error: result.notes };
  const updated = appLog.upsert(toRecord(result));
  sheets.enqueue(updated);
  return { record: updated };
}

// ---------- check-free discovery sources (email alerts, public ATS boards) ----------

function searchHelpers() {
  const cfg = loadSearchConfig();
  let keep = () => true;
  let cardSkip = () => null;
  try { keep = makeJobFilter(cfg); } catch (_) {}
  try { cardSkip = require(path.join(PW, 'common.js')).makeCardFilter(cfg); } catch (_) {}
  return { cfg, keep, cardSkip };
}

// Reads job-alert emails (read-only Gmail) -> feeder. Naukri/foundit descriptions are read later in
// the visible application check; a thin Indeed snippet becomes NEEDS_REVIEW "paste the description".
async function runEmailIntake({ trigger = 'timer' } = {}) {
  if (!mailIntake.configured()) return { skipped: 'Gmail not connected (run setup/gmail_auth.js)' };
  const { keep } = searchHelpers();
  let read;
  try { read = await mailIntake.readAlerts({}); } catch (e) { discoveryStatus.record('email', { mode: 'EMAIL', trigger, error: e.message }); return { error: e.message }; }
  const jobs = [];
  let filtered = 0;
  for (const j of read.jobs) {
    const job = mailIntake.toPipelineJob(j, discovery.jobIdFor);
    if (!keep(job)) { filtered++; continue; }
    jobs.push(job);
  }
  const queued = jobs.length ? feeder.enqueue(jobs) : 0;
  if (queued) updateKeepAwake();
  const entry = discoveryStatus.record('email', { mode: 'EMAIL', trigger, found: jobs.length, queued, stats: { emails: read.stats.emails, perSite: read.stats.perSite, filteredTitle: filtered } });
  log(`email intake (${trigger}): ${read.stats.emails} email(s) -> ${jobs.length} job(s), ${queued} new to the pipeline`);
  return entry;
}

// Reads public ATS job boards -> feeder.
async function runAtsBoards({ trigger = 'timer' } = {}) {
  const companies = atsBoards.loadCompanies();
  if (!companies.length) return { skipped: 'no companies in config/companies.json' };
  const { cfg, keep, cardSkip } = searchHelpers();
  const { jobs, boards } = await atsBoards.fetchAll({ cfg, keep, cardSkip, companies, log });
  const queued = jobs.length ? feeder.enqueue(jobs) : 0;
  if (queued) updateKeepAwake();
  const entry = discoveryStatus.record('boards', { mode: 'ATS', trigger, found: jobs.length, queued, stats: { companies: companies.length, boards } });
  log(`ATS boards (${trigger}): ${companies.length} board(s) -> ${jobs.length} job(s), ${queued} new to the pipeline`);
  return entry;
}

// ---------- recovery (parked checkpoints) ----------
const ATTENDED_FILE = path.join(ROOT, 'setup', 'attended.json');
function markAttended() { try { fs.mkdirSync(path.dirname(ATTENDED_FILE), { recursive: true }); fs.writeFileSync(ATTENDED_FILE, JSON.stringify({ at: new Date().toISOString() })); } catch (_) {} }

// Resolve parked jobs while you're at the laptop: re-check each one (visible), which re-opens the page
// so you can solve the check, then resumes. One at a time.
let resolveRunning = false;
function parkedCheckpoints() { return recovery.loadCheckpoints().filter(c => c.job || c.kind === 'job_page' || c.kind === 'company_form'); }
async function resolveParked() {
  if (resolveRunning) return { error: 'Already resolving.' };
  markAttended();
  const cps = recovery.loadCheckpoints();
  const jobsToRetry = [];
  for (const cp of cps) {
    const url = cp.url || (cp.job && cp.job.job_url);
    const rec = url && appLog.findByUrl(url);
    if (rec && !appLog.FINAL.includes(rec.status)) jobsToRetry.push(rec);
  }
  if (!jobsToRetry.length && !cps.length) return { queued: 0 };
  resolveRunning = true;
  updateKeepAwake();
  (async () => {
    for (const rec of jobsToRetry) {
      markAttended(); // keep the "you're here" signal fresh during the batch
      await retryApplication(appLog.find(rec.id) || rec).catch(e => log(`resolve ${rec.company}: ${e.message}`));
    }
  })().finally(() => { resolveRunning = false; updateKeepAwake(); });
  return { queued: jobsToRetry.length };
}

// ---------- visible search + schedule ----------

async function runVisibleSearch(platform, { trigger = 'button' } = {}) {
  if (!VISIBLE_SEARCH.includes(platform)) return { error: `No visible search for ${platform}` };
  if (batchBusy(platform)) return { error: `The previous ${platform} batch is still being processed.`, code: 409 };
  const r = await scrapeQueue(() => keeper.use(platform, () => runScript(SCRAPERS[platform], ['--visible'], 45 * 60 * 1000)));
  const jobs = r.jobs || [];
  const queued = jobs.length ? feeder.enqueue(jobs) : 0;
  if (queued) {
    inflight[platform] = { urls: new Set(jobs.map(j => j.job_url)), at: Date.now() };
    saveInflight();
    updateKeepAwake();
  }
  const entry = discoveryStatus.record(platform, { mode: 'VISIBLE', trigger, found: jobs.length, queued, searches: r.searches, blocked: r.blocked || null, stats: r.stats || null, note: r.note || r.error || '' });
  log(`visible search ${platform} (${trigger}): ${jobs.length} found, ${queued} sent to the pipeline${r.blocked ? `; BLOCKED (${r.blocked.kind})` : ''}`);
  return entry;
}

// Automatic visible searches at config/search.json schedule.visibleSearch (local time), one site
// after another. A slot missed while the laptop was off runs once when the helper next sees it
// (same day only). The last slot run is kept in setup/schedule_state.json.
const SCHEDULE_STATE = path.join(ROOT, 'setup', 'schedule_state.json');
let scheduleRunning = false;
function scheduleConfig() {
  const s = searchConfig().schedule || {};
  return { times: Array.isArray(s.visibleSearch) ? s.visibleSearch : [], platforms: (s.platforms || []).filter(p => VISIBLE_SEARCH.includes(p)) };
}
function readScheduleState() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_STATE, 'utf8')); } catch (_) { return {}; }
}
async function scheduleTick() {
  if (scheduleRunning) return;
  const { times, platforms } = scheduleConfig();
  if (!times.length || !platforms.length) return;
  const state = readScheduleState();
  if (!fs.existsSync(SCHEDULE_STATE)) {
    // First start with a schedule: begin from the NEXT slot, don't fire one immediately.
    fs.writeFileSync(SCHEDULE_STATE, JSON.stringify({ lastSlot: discovery.dueSlot(new Date(), times, null) || '' }));
    return;
  }
  const slot = discovery.dueSlot(new Date(), times, state.lastSlot || null);
  if (!slot) return;
  scheduleRunning = true;
  fs.writeFileSync(SCHEDULE_STATE, JSON.stringify({ ...state, lastSlot: slot, startedAt: new Date().toISOString() }));
  updateKeepAwake();
  log(`scheduled discovery (${slot}): email -> boards -> visible search ${platforms.join(' / ')}`);
  const results = {};
  try {
    // Check-free sources first; visible search only for sites that email produced nothing new for.
    results.email = await runEmailIntake({ trigger: `schedule ${slot.slice(11)}` }).catch(e => ({ error: e.message }));
    results.boards = await runAtsBoards({ trigger: `schedule ${slot.slice(11)}` }).catch(e => ({ error: e.message }));
    const fromEmail = new Set(Object.entries(results.email?.stats?.perSite || {}).filter(([, n]) => n > 0).map(([p]) => p));
    for (const p of platforms.filter(p => !fromEmail.has(p))) {
      const r = await runVisibleSearch(p, { trigger: `schedule ${slot.slice(11)}` }).catch(e => ({ error: e.message }));
      results[p] = r.error ? { error: r.error } : { found: r.found, queued: r.queued, blocked: r.blocked ? r.blocked.kind : null };
    }
  } finally {
    fs.writeFileSync(SCHEDULE_STATE, JSON.stringify({ lastSlot: slot, startedAt: readScheduleState().startedAt, finishedAt: new Date().toISOString(), results }));
    scheduleRunning = false;
    updateKeepAwake();
  }
  // Then confirm which "click Apply" jobs you have applied to since (read-only; the site's Applied state).
  const r = startRecheck('applied');
  if (r.queued) log(`after the scheduled search: checking ${r.queued} job(s) for the site's Applied state`);
}
function nextScheduled() {
  const { times, platforms } = scheduleConfig();
  return { next: discovery.nextSlot(new Date(), times), platforms, last: readScheduleState(), running: scheduleRunning };
}

// ---------- http ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

function send(res, status, payload, origin) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.end(JSON.stringify(payload));
}

const routes = {
  'GET /health': async () => ({ status: 'ok', service: 'job-agent-helper', port: PORT, threshold: settings().threshold, sheets: sheets.status(), llm: llm.status() }),
  'GET /applications': async () => appLog.load(),
  'GET /pending': async () => ({ pending: appLog.load().applications.filter(a => ['NEEDS_REVIEW', 'SECURITY_CHALLENGE'].includes(a.status)) }),
  // Re-check in the visible browser: { which: 'applied' | 'all' } (read-only; never clicks Apply).
  'POST /recheck': async b => startRecheck(b.which === 'all' ? 'all' : 'applied'),
  'GET /recheck/status': async () => ({ running: recheckRunning, last: lastRecheck, targets: { applied: recheckTargets('applied').length, all: recheckTargets('all').length } }),

  'POST /prompt': async b => buildPrompt(b.kind, b.job || {}),
  'POST /parse-score': async b => {
    const r = parseScore(b.job || {}, b.content, !!b.final);
    // Passed -> SCORED now; a rejection is logged by the pipeline itself (REJECTED via /log).
    if (r.ok && r.passed) recordStage(r.job, 'SCORED', { next_action: `Nothing yet: scored ${r.job.score}, tailoring your CV` });
    return r;
  },

  'POST /save-cv': async b => {
    const { pdf } = await saveDocument(b.job || {}, b.content, 'cv');
    recordStage({ ...b.job, cv_pdf: pdf }, 'CV_READY');
    return { job: { ...b.job, cv_pdf: pdf } };
  },
  'POST /save-cover-letter': async b => {
    const { pdf } = await saveDocument(b.job || {}, b.content, 'cover letter');
    return { job: { ...b.job, cover_letter_path: pdf } };
  },

  'POST /apply': async b => ({ job: await applyQueue(() => prepareApplication(b.job || {})) }),

  'POST /log': async b => {
    const rec = toRecord(b.record || b);
    if (!rec.job_url) throw new Error('job_url is required');
    if (!rec.status) throw new Error('status is required');
    const stored = appLog.upsert(rec);
    for (const b of Object.values(inflight)) b.urls.delete(rec.job_url);
    saveInflight();
    sheets.enqueue(stored); // background; never delays the pipeline
    return { record: stored, sheets_enabled: false, sheets_sync: 'background' };
  },

  'POST /discover/manual': async b => manualIntake(b || {}),
  'GET /discovery/status': async () => ({
    platforms: discoveryStatus.all(), feeder: { pending: feeder.pending(), ...feeder.stats }, visible: VISIBLE_SEARCH,
    schedule: nextScheduled(), waiting_for_you: waitingStatus(), auto_apply: autoApplySummary(),
    recheck: { running: recheckRunning, last: lastRecheck }, browsers: keeper.status(),
    intake_status: { email_connected: mailIntake.configured(), boards: atsBoards.loadCompanies().length }
  }),
  'POST /auto-apply/pending': async () => autoApplyPending(),
  'GET /browsers': async () => keeper.status(),
  'POST /intake/email': async () => runEmailIntake({ trigger: 'button' }),
  'POST /intake/boards': async () => runAtsBoards({ trigger: 'button' }),
  'GET /intake/status': async () => ({ email: { configured: mailIntake.configured() }, boards: { companies: atsBoards.loadCompanies().length } }),
  'POST /heartbeat': async () => { markAttended(); return { at: new Date().toISOString() }; },
  'POST /recovery/resolve': async () => resolveParked(),
  'GET /recovery/status': async () => ({ attended: recovery.attended(), resolving: resolveRunning, parked: parkedCheckpoints().map(c => ({ kind: c.kind, site: c.site, company: c.job && c.job.company, url: c.url, challenge: c.challenge, since: c.created })) }),

  // Queue every local record for the Sheet; rows are upserted by Job URL, so this is safe to repeat.
  'POST /sheets/backfill': async () => {
    const apps = appLog.load().applications;
    for (const r of apps) sheets.enqueue(r);
    sheets.flush();
    return { queued: apps.length, sheets: sheets.status() };
  }
};

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);

  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    const key = `${req.method} ${pathname}`;
    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await routes[key](body), origin);
    }

    // Ollama-compatible LLM proxy (n8n scorer/CV builder and the form filler). Not for browsers.
    if (req.method === 'POST' && pathname === '/llm/api/chat') {
      if (origin) return send(res, 403, { error: 'Not available from the browser' });
      const body = await readBody(req);
      try {
        return send(res, 200, await llm.chat({ ...body, stream: false }));
      } catch (e) {
        log(`LLM ${e.backend || ''} failed: ${e.kind || 'error'} ${e.message}`);
        return send(res, 502, { error: e.toJSON ? e.toJSON() : { kind: 'error', message: e.message } });
      }
    }

    let m = pathname.match(/^\/scrape\/([a-z0-9]+)$/);
    if (req.method === 'POST' && m) {
      const script = SCRAPERS[m[1]];
      if (!script) return send(res, 404, { error: `Unknown scraper ${m[1]}` }, origin);
      if (batchBusy(m[1])) {
        log(`scrape ${m[1]}: skipped, ${inflight[m[1]].urls.size} jobs from the previous batch still processing`);
        return send(res, 200, { jobs: [], count: 0, error: null, note: 'previous batch still processing' }, origin);
      }
      const r = await scrapeQueue(() => runScript(script, [], 30 * 60 * 1000));
      const jobs = r.jobs || [];
      inflight[m[1]] = { urls: new Set(jobs.map(j => j.job_url)), at: Date.now() };
      saveInflight();
      updateKeepAwake();
      log(`scrape ${m[1]}: ${jobs.length} new jobs${r.error ? ` (error: ${r.error})` : ''}${r.note ? ` (${r.note})` : ''}`);
      discoveryStatus.record(m[1], { mode: r.mode || 'NORMAL', found: jobs.length, queued: jobs.length, searches: r.searches, blocked: r.blocked || null, stats: r.stats || null, note: r.note || r.error || '' });
      return send(res, 200, { jobs, count: jobs.length, error: r.error || null }, origin);
    }

    // Visible search (dashboard button): headed browser with the saved session, slow; a block stops it.
    m = pathname.match(/^\/discover\/visible\/([a-z0-9]+)$/);
    if (req.method === 'POST' && m) {
      const r = await runVisibleSearch(m[1]);
      if (r.error) return send(res, r.code || 400, { error: r.error }, origin);
      return send(res, 200, r, origin);
    }

    m = pathname.match(/^\/retry\/([a-f0-9]{12})$/);
    if (req.method === 'POST' && m) {
      const rec = appLog.find(m[1]);
      if (!rec) return send(res, 404, { error: 'Application not found' }, origin);
      const r = await retryApplication(rec);
      log(`retry ${rec.company} - ${rec.job_title}: ${r.error || (r.queued ? 'CV rebuild queued' : r.record.status)}`);
      return send(res, r.error ? 400 : 200, r, origin);
    }

    m = pathname.match(/^\/review\/([a-f0-9]{12})$/);
    if (req.method === 'POST' && m) {
      const rec = appLog.find(m[1]);
      if (!rec) return send(res, 404, { error: 'Application not found' }, origin);
      const script = applyScriptFor(rec.platform);
      if (!script) return send(res, 400, { error: `No apply script for ${rec.platform}` }, origin);
      const proc = spawn(process.execPath, [path.join(PW, script), ...applyArgs(rec, 'review')], {
        cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: false
      });
      proc.unref();
      log(`review opened: ${rec.company} - ${rec.job_title}`);
      return send(res, 200, { success: true, message: 'Browser opening with the form filled. Submit it yourself, then click Mark submitted.' }, origin);
    }

    m = pathname.match(/^\/mark\/([a-f0-9]{12})$/);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      if (!['APPLIED', 'REJECTED'].includes(body.status)) return send(res, 400, { error: 'status must be APPLIED or REJECTED' }, origin);
      const rec = appLog.find(m[1]);
      if (!rec) return send(res, 404, { error: 'Application not found' }, origin);
      const notes = body.notes || (body.status === 'APPLIED' ? 'Submitted manually after review' : 'Skipped by user after review');
      const next_action = body.status === 'APPLIED' ? 'Nothing: you confirmed you submitted it' : 'Nothing: you skipped it';
      const updated = appLog.upsert({ job_url: rec.job_url, status: body.status, notes, next_action });
      sheets.enqueue(updated);
      return send(res, 200, { record: updated }, origin);
    }

    return send(res, 404, { error: 'Not found', path: pathname }, origin);
  } catch (e) {
    log(`ERROR ${req.method} ${pathname}: ${e.message}`);
    return send(res, 500, { error: e.message }, origin);
  }
}

const server = http.createServer(handle);
server.requestTimeout = 0; // scrapes can take many minutes
server.headersTimeout = 60000;
server.on('error', e => { log(`Server error: ${e.message}`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  log(`Helper service listening on http://127.0.0.1:${PORT}`);
  // One-time move to the pipeline statuses (old names -> DISCOVERED..FAILED + next action), synced to the Sheet.
  const migrated = appLog.migrate();
  if (migrated.length) { for (const r of migrated) sheets.enqueue(r); log(`status migration: ${migrated.length} record(s) moved to the pipeline statuses`); }
  keeper.cleanupStale().catch(() => {});
  // Jobs that were DISCOVERED but not yet scored when the helper stopped go back into the queue
  // (only under autopilot — otherwise nothing processes on its own).
  if (searchConfig().autopilot !== false) {
    const orphans = appLog.load().applications.filter(a => a.status === 'DISCOVERED' && a.description).map(recordToJob);
    if (orphans.length) log(`re-queued ${feeder.enqueue(orphans)} discovered job(s) that were waiting when the helper stopped`);
  }
  sheets.start();
  updateKeepAwake();
  setInterval(updateKeepAwake, 30 * 1000).unref();
  // Autopilot: when false (config/search.json), NOTHING runs on its own — no scheduled searches, no
  // email/board timers. The dashboard, Sheet and manual buttons still work.
  const autopilot = (() => { try { return searchConfig().autopilot !== false; } catch (_) { return true; } })();
  if (!autopilot) {
    log('autopilot OFF (manual only): no scheduled searches, no email/board timers. Use the dashboard buttons.');
  } else {
    setInterval(() => scheduleTick().catch(e => log(`schedule error: ${e.message}`)), 60 * 1000).unref();
    const s = nextScheduled();
    if (s.next) log(`automatic discovery scheduled: next ${s.next} (email -> boards -> visible ${s.platforms.join(' / ')})`);
    // Seed company boards from ATS links already in your log, then poll email (30 min) and boards (6 h).
    try { const added = atsBoards.seedCompanies(appLog.load().applications); if (added.length) log(`seeded ${added.length} company board(s) from your log into config/companies.json`); } catch (_) {}
    if (mailIntake.configured()) {
      log('email intake on (job-alert emails, every 30 min)');
      setInterval(() => runEmailIntake().catch(e => log(`email intake error: ${e.message}`)), 30 * 60 * 1000).unref();
      setTimeout(() => runEmailIntake().catch(() => {}), 10 * 1000).unref();
    } else {
      log('email intake off (connect Gmail: node setup/gmail_auth.js)');
    }
    if (atsBoards.loadCompanies().length) setInterval(() => runAtsBoards().catch(e => log(`ats boards error: ${e.message}`)), 6 * 60 * 60 * 1000).unref();
  }
});
process.on('uncaughtException', err => log(`UNCAUGHT: ${err.stack || err.message}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { keeper.closeAll().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
