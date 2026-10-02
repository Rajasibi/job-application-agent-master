// Local application log (setup/applied_jobs.json) — one record per job URL, updated in place.
// This file is the single source of truth for application statuses (dashboard + Sheets use them).
// Used by the helper service (logging, review queue, daily cap) and the local dashboard.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_PATH = process.env.JOB_AGENT_LOG_PATH || path.join(__dirname, '..', 'setup', 'applied_jobs.json'); // override: tests only
const SEARCH_CONFIG = process.env.JOB_AGENT_SEARCH_CONFIG || path.join(__dirname, '..', 'config', 'search.json');
// Max prepared applications per platform per day: config/search.json "dailyLimitPerSite"
// (null = no limit). Read on every check, so editing the config takes effect immediately.
function dailyLimit() {
  try {
    const v = JSON.parse(fs.readFileSync(SEARCH_CONFIG, 'utf-8')).dailyLimitPerSite;
    if (v === null) return null;
    return typeof v === 'number' && v > 0 ? v : 10;
  } catch (_) { return 10; }
}
const DAILY_LIMIT = dailyLimit(); // value at load time (kept for compatibility)

// Pipeline statuses, in stage order. Each record also has `next_action`: exactly what (if anything)
// you need to do. The same values go to the Google Sheet (Status + Next action columns).
const STATUSES = [
  'DISCOVERED',          // found by a search / pasted, waiting to be scored
  'SCORED',              // scored at or above the threshold
  'REJECTED',            // scored below the threshold, or skipped by you
  'CV_READY',            // tailored CV (and cover letter) generated
  'APPLICATION_STARTED', // the agent is checking / preparing the application now
  'APPLIED',             // CONFIRMED: the site shows Applied / "successfully applied", or you marked it submitted
  'NEEDS_REVIEW',        // prepared; your action is in next_action (click Apply, answer a question, finish a form)
  'SECURITY_CHALLENGE',  // CAPTCHA / Cloudflare / Access Denied / OTP / login stopped the agent
  'FAILED'               // error, or the job is closed
];
// Engine result names (and older stored names) map onto the pipeline statuses: one status system.
const ALIASES = {
  AWAITING_MANUAL_SUBMIT: 'NEEDS_REVIEW', NEEDS_HUMAN_INPUT: 'NEEDS_REVIEW', UNSUPPORTED_FORM: 'NEEDS_REVIEW', READY_FOR_REVIEW: 'NEEDS_REVIEW',
  LOGIN_REQUIRED: 'SECURITY_CHALLENGE', BLOCKED: 'SECURITY_CHALLENGE',
  ALREADY_APPLIED: 'APPLIED', SUBMITTED: 'APPLIED'
};
// "The agent already did its part": not re-prepared automatically (Retry / Re-check can).
const PREPARED = ['APPLIED', 'NEEDS_REVIEW', 'SECURITY_CHALLENGE'];
const FINAL = ['APPLIED', 'REJECTED'];
const IN_PROGRESS = ['DISCOVERED', 'SCORED', 'CV_READY', 'APPLICATION_STARTED'];
// Stage order for the forward-only guard: outcomes (4) and APPLIED (5) are never overwritten by an
// earlier stage.
const RANK = { DISCOVERED: 0, SCORED: 1, CV_READY: 2, APPLICATION_STARTED: 3, NEEDS_REVIEW: 4, SECURITY_CHALLENGE: 4, FAILED: 4, REJECTED: 4, APPLIED: 5 };

function normalizeStatus(s) {
  const up = String(s || '').trim().toUpperCase();
  return ALIASES[up] || (STATUSES.includes(up) ? up : '');
}

// Whether `next` may replace `current`. Stage progress only moves forward; APPLIED and REJECTED are
// final; an outcome may replace another outcome (a re-check); { restart: true } (Retry / Re-check)
// may move an outcome back to APPLICATION_STARTED.
function canMove(current, next, { restart = false } = {}) {
  if (!current) return true;
  if (current === next) return true;
  if (FINAL.includes(current)) return false;
  if (restart && next === 'APPLICATION_STARTED') return true;
  return RANK[next] >= RANK[current] && !(RANK[current] === 4 && RANK[next] < 4);
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
    return Array.isArray(data.applications) ? data : { applications: [] };
  } catch (_) {
    return { applications: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const tmp = `${LOG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, LOG_PATH);
}

function idFor(jobUrl) {
  return crypto.createHash('sha1').update(String(jobUrl || '')).digest('hex').slice(0, 12);
}

function find(id) {
  return load().applications.find(a => a.id === id) || null;
}

function findByUrl(jobUrl) {
  return find(idFor(jobUrl));
}

// Default "what you need to do" for statuses that don't need a specific one.
const DEFAULT_ACTION = {
  DISCOVERED: 'Nothing yet: waiting to be scored',
  SCORED: 'Nothing yet: tailoring your CV',
  CV_READY: 'Nothing yet: checking the application',
  APPLICATION_STARTED: 'Nothing yet: the agent is checking the job page',
  REJECTED: 'Nothing: not a match (see Notes)',
  APPLIED: 'Nothing: applied',
  FAILED: 'Nothing (see Notes)'
};

// Insert or update by job URL. Empty values never overwrite existing ones. A status that would move
// the record backwards (see canMove) is ignored; the other fields are still merged.
// opts.restart: Retry / Re-check may move an outcome back to APPLICATION_STARTED.
function upsert(record, opts = {}) {
  if (!record.job_url) throw new Error('job_url is required');
  if (record.status) {
    const s = normalizeStatus(record.status);
    if (!s) throw new Error(`Invalid status: ${record.status}`);
    record = { ...record, status: s };
  }
  const data = load();
  const id = idFor(record.job_url);
  const now = new Date().toISOString();
  const i = data.applications.findIndex(a => a.id === id);
  const current = i >= 0 ? data.applications[i].status : '';
  if (record.status && !canMove(current, record.status, opts)) {
    const { status, next_action, ...rest } = record;
    record = rest;
  } else if (record.status && record.status !== current && !record.next_action) {
    record = { ...record, next_action: DEFAULT_ACTION[record.status] || '' };
  }
  const clean = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const merged = i >= 0
    ? { ...data.applications[i], ...clean, id, updated_at: now }
    : { id, timestamp: now, updated_at: now, ...clean };
  if (i >= 0) data.applications[i] = merged; else data.applications.push(merged);
  if (data.applications.length > 5000) data.applications = data.applications.slice(-5000);
  save(data);
  return merged;
}

function preparedTodayCount(platform) {
  const today = new Date().toISOString().slice(0, 10);
  return load().applications.filter(a =>
    a.platform === platform && String(a.timestamp).startsWith(today) && PREPARED.includes(a.status)
  ).length;
}

// Whether the agent should prepare this job now. force (the Retry button) re-runs jobs the
// agent already handled, but never FINAL ones, and still respects the daily cap.
function canPrepare(jobUrl, platform, { force = false } = {}) {
  const existing = findByUrl(jobUrl);
  if (existing && FINAL.includes(existing.status)) return { ok: false, reason: `Already ${existing.status}` };
  if (existing && !force && PREPARED.includes(existing.status)) return { ok: false, reason: `Already ${existing.status}` };
  const limit = dailyLimit();
  if (limit !== null && preparedTodayCount(platform) >= limit) {
    return { ok: false, reason: `Daily limit of ${limit} reached for ${platform}` };
  }
  return { ok: true };
}

// One-time move of records stored under the old status names to the pipeline statuses, with a
// next_action derived from what was known. Returns the migrated records (for the Sheet).
const MIGRATED_ACTION = {
  AWAITING_MANUAL_SUBMIT: 'Open the job and apply (prepared earlier; a re-check will give the exact step)',
  NEEDS_HUMAN_INPUT: 'Answer the listed question(s) and apply',
  UNSUPPORTED_FORM: 'Apply on the site yourself (form the agent can\'t fill)',
  SECURITY_CHALLENGE: 'Re-check pending: the earlier headless check was blocked by the site',
  LOGIN_REQUIRED: 'Log in again: run setup\\LOGIN_ONCE.bat, then Re-check',
  ALREADY_APPLIED: 'Nothing: the site shows you already applied'
};
function migrate() {
  const data = load();
  const changed = [];
  for (const a of data.applications) {
    const old = a.status;
    const s = normalizeStatus(old);
    if (!s || (s === old && a.next_action)) continue;
    a.status = s;
    if (!a.next_action) a.next_action = MIGRATED_ACTION[old] || DEFAULT_ACTION[s] || '';
    if (s !== old) a.previous_status = old;
    changed.push(a);
  }
  if (changed.length) save(data);
  return changed;
}

module.exports = {
  LOG_PATH, STATUSES, ALIASES, PREPARED, FINAL, IN_PROGRESS, RANK, DAILY_LIMIT, dailyLimit,
  normalizeStatus, canMove, load, save, idFor, find, findByUrl, upsert, canPrepare, migrate
};

// CLI: node application_log.js [stats|list|clear]
if (require.main === module) {
  const cmd = process.argv[2] || 'stats';
  const apps = load().applications;
  const count = key => apps.reduce((m, a) => ({ ...m, [a[key]]: (m[a[key]] || 0) + 1 }), {});
  if (cmd === 'stats') {
    console.log(`Total logged: ${apps.length}`);
    console.log('By status:', count('status'));
    console.log('By platform:', count('platform'));
  } else if (cmd === 'list') {
    for (const a of apps.slice(-20)) console.log(`[${a.updated_at}] ${a.status} ${a.platform} | ${a.company} - ${a.job_title} (${a.fit_score ?? '-'})`);
  } else if (cmd === 'clear') {
    save({ applications: [] });
    console.log('Cleared.');
  }
}
