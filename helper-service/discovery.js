// Job discovery helpers: user-pasted jobs, visible-search results, and a feeder that sends
// discovered jobs into the EXISTING pipeline (n8n /webhook/score-job -> threshold 70 -> CV ->
// cover letter -> application engine -> log -> Sheets), one job at a time.
//
// Dedupe: a job whose URL is already in setup/applied_jobs.json is never sent again.
// Filters: the same config/search.json title/company exclusions the scrapers use.
// Indeed: pages are never fetched automatically; a pasted Indeed job needs a pasted description.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_DESCRIPTION = 80;

function detectPlatform(rawUrl) {
  const u = new URL(rawUrl);
  const h = u.hostname.toLowerCase();
  if (/(^|\.)naukri\.com$/.test(h)) return 'naukri';
  if (/(^|\.)foundit\.in$/.test(h)) return 'foundit';
  if (/(^|\.)indeed\.[a-z.]+$/.test(h)) return 'indeed';
  return 'external';
}

// Same job ids the scrapers use, so the seen caches line up.
function jobIdFor(platform, url) {
  const u = new URL(url);
  if (platform === 'naukri') { const m = url.match(/-(\d{6,})/); if (m) return `naukri_${m[1]}`; }
  if (platform === 'foundit') { const m = u.pathname.match(/-(\d{5,})\/?$/); if (m) return `foundit_${m[1]}`; }
  if (platform === 'indeed') { const jk = u.searchParams.get('jk') || u.searchParams.get('vjk'); if (jk) return `indeed_${jk}`; }
  return `${platform}_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

// Validates a pasted job and returns { job } or { error }. `fetched` = what fetch_job.js read (optional).
function buildManualJob(input, { fetched = null, keep = () => true } = {}) {
  let url;
  try {
    url = new URL(String(input.url || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch (_) {
    return { error: 'Paste a full job link starting with https://' };
  }
  const platform = detectPlatform(url.toString());
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const description = clean(input.description) || clean(fetched && fetched.description);

  if (platform === 'indeed' && !clean(input.description)) {
    return { error: 'Indeed pages are not read automatically. Open the job in your browser, copy its description, and paste it here with the link.' };
  }
  if (!description || description.length < MIN_DESCRIPTION) {
    if (fetched && fetched.blocked) {
      return { error: `${platform === 'external' ? 'The site' : platform} blocked automatic reading (${fetched.blocked.kind}). Paste the job description too and try again.` };
    }
    return { error: 'Could not read enough of the job description. Paste the description (at least a few lines) and try again.' };
  }
  const job = {
    job_id: jobIdFor(platform, url.toString()),
    job_url: url.toString(),
    job_title: clean(input.title) || clean(fetched && fetched.title) || 'Untitled role',
    company: clean(input.company) || clean(fetched && fetched.company) || 'Unknown company',
    location: clean(input.location) || clean(fetched && fetched.location) || '',
    description: description.slice(0, 4000),
    source_platform: platform,
    region: 'india',
    search_term: 'manual paste',
    discovered_via: 'manual'
  };
  if (!keep(job)) return { error: 'This job title matches your exclusion filters in config/search.json (exclude.titlePatterns).' };
  return { job };
}

// Discovery status per platform (last run), persisted so the dashboard survives restarts.
function statusStore(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  return {
    all: load,
    record(platform, entry) {
      const s = load();
      s[platform] = { at: new Date().toISOString(), ...entry };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(s, null, 2));
      return s[platform];
    }
  };
}

// Feeder into the existing pipeline (one job at a time unless `concurrency` > 1). postScoreJob(job)
// must resolve when n8n's score-job webhook returns (the whole chain for that job). Errors never
// stop the queue.
// "n8n not ready" errors mean the job never started (e.g. n8n's database briefly timed out), so it
// is safe to send it again after a pause. Other errors (HTTP 500) may come from a half-run chain
// and are not retried.
const TRANSIENT = /HTTP 503|ECONNREFUSED|ECONNRESET|socket hang up/;
const RETRY_DELAYS_MS = [60000, 120000, 240000];

// concurrency: how many jobs are in the pipeline at once (1 for local Qwen; the benchmarked safe
// value for a cloud backend). Can be a function so the setting is read when a worker starts.
// onQueued(job): called once per newly queued job (the helper logs it as DISCOVERED).
function createFeeder({ postScoreJob, isLogged, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), retryDelays = RETRY_DELAYS_MS, concurrency = 1, onQueued = () => {} }) {
  const queue = [];
  const active = new Set(); // job_urls currently in the pipeline
  let workers = 0;
  const stats = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  const limit = () => Math.max(1, Math.min(8, Number(typeof concurrency === 'function' ? concurrency() : concurrency) || 1));
  function drain() {
    while (workers < limit() && queue.length) worker();
  }
  async function worker() {
    workers++;
    while (queue.length) {
      const job = queue.shift();
      active.add(job.job_url);
      await sendOne(job);
      active.delete(job.job_url);
    }
    workers--;
  }
  async function sendOne(job) {
    for (let attempt = 0; ; attempt++) {
      if (isLogged(job.job_url)) { stats.skipped++; return; } // existing job_url dedupe
      try {
        await postScoreJob(job);
        stats.sent++;
        log(`discovery: sent to pipeline: ${job.company} - ${job.job_title} (${job.source_platform})`);
        return;
      } catch (e) {
        if (TRANSIENT.test(e.message) && attempt < retryDelays.length) {
          stats.retried++;
          log(`discovery: n8n not ready (${e.message}); retrying ${job.job_url} in ${Math.round(retryDelays[attempt] / 1000)} s`);
          await sleep(retryDelays[attempt]);
          continue;
        }
        stats.failed++;
        log(`discovery: pipeline call failed for ${job.job_url}: ${e.message}`);
        return;
      }
    }
  }
  return {
    enqueue(jobs) {
      const seen = new Set([...queue.map(q => q.job_url), ...active]);
      const fresh = [];
      for (const j of jobs) {
        if (!j || !j.job_url || seen.has(j.job_url) || isLogged(j.job_url)) continue; // dedupe: batch, queue, log
        seen.add(j.job_url);
        fresh.push(j);
      }
      queue.push(...fresh);
      for (const j of fresh) { try { onQueued(j); } catch (_) {} }
      drain();
      return fresh.length;
    },
    pending: () => queue.length + active.size,
    stats,
    idle: () => new Promise(r => { const t = setInterval(() => { if (!workers && !queue.length) { clearInterval(t); r(); } }, 50); })
  };
}

// ---------- schedule (pure, local time) ----------
// Slot ids look like "2026-09-29T09:30" (local). times: ["09:30", "18:30"].
const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const validTimes = times => (times || []).filter(t => /^\d{1,2}:\d{2}$/.test(String(t))).map(t => { const [h, m] = String(t).split(':'); return `${pad(h)}:${m}`; }).sort();

// The slot that should run now: the latest of TODAY's slots that has started and is newer than
// lastSlot. Missed slots from earlier days are never run; several missed today run only once.
function dueSlot(now, times, lastSlot) {
  const today = localDay(now);
  const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const started = validTimes(times).filter(t => t <= nowHm);
  if (!started.length) return null;
  const slot = `${today}T${started[started.length - 1]}`;
  return !lastSlot || slot > lastSlot ? slot : null;
}

function nextSlot(now, times) {
  const list = validTimes(times);
  if (!list.length) return null;
  const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const later = list.find(t => t > nowHm);
  if (later) return `${localDay(now)}T${later}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${localDay(tomorrow)}T${list[0]}`;
}

module.exports = { detectPlatform, jobIdFor, buildManualJob, statusStore, createFeeder, dueSlot, nextSlot, MIN_DESCRIPTION };
