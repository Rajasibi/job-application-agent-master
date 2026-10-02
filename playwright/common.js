// Shared helpers for scrapers and apply scripts.
// Everything path-related is resolved from the project root, never from cwd.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
// Env overrides exist for automated tests only (so they never touch the real cache/config).
const CACHE_DIR = process.env.JOB_AGENT_CACHE_DIR || path.join(ROOT, 'setup', 'cache');
const SEARCH_CONFIG_PATH = process.env.JOB_AGENT_SEARCH_CONFIG || path.join(ROOT, 'config', 'search.json');
const RESUME_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf']);

require('dotenv').config({ path: path.join(ROOT, '.env') });
const { loadUserProfile } = require('./user_profile');
const { MODES, launch, detectChallenge } = require('./browser_modes');
const { recover } = require('./recovery');
const { answerFor, optionSynonyms } = require('./answer_resolver');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function slug(value, max = 40) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, max) || 'unknown';
}

// Every script prints exactly one JSON line on stdout; the helper parses the last line.
function out(obj) {
  console.log(JSON.stringify(obj));
}

function loadSearchConfig() {
  const cfg = JSON.parse(fs.readFileSync(SEARCH_CONFIG_PATH, 'utf-8'));
  if (!cfg._configured) {
    throw new Error('config/search.json is not configured yet (set roles/locations, then "_configured": true)');
  }
  return cfg;
}

// ---------- Job filtering / dedupe ----------

function makeJobFilter(cfg) {
  const titleRes = (cfg.exclude?.titlePatterns || []).map(p => new RegExp(p, 'i'));
  const companyRes = (cfg.exclude?.companyPatterns || []).map(p => new RegExp(p, 'i'));
  return job => {
    const title = String(job.job_title || '');
    if (title.length < 4) return false;
    if (titleRes.some(r => r.test(title))) return false;
    if (companyRes.some(r => r.test(String(job.company || '')))) return false;
    return true;
  };
}

// Search-card pre-filter, applied before a job page is opened or the job is scored.
// Returns null (keep) or the reason it was skipped: 'location' | 'experience'.
//   location:   must mention one of discovery.allowedLocations (multi-city cards count if any
//               listed city is allowed); an empty location or plain "India" is kept for the scorer
//   experience: skipped when the card's minimum years is above discovery.maxMinExperience
function makeCardFilter(cfg) {
  const d = cfg.discovery || {};
  const allowed = (d.allowedLocations || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const maxExp = typeof d.maxMinExperience === 'number' ? d.maxMinExperience : null;
  return job => {
    const loc = String(job.location || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (allowed.length && loc && loc !== 'india' && !job.remote_only && !allowed.some(a => loc.includes(a))) return 'location';
    const m = String(job.experience || '').match(/(\d+)\s*(?:-|–|to)\s*\d+|(\d+)\s*\+?\s*(?:yrs?|years?)/i);
    const min = m ? Number(m[1] ?? m[2]) : null;
    if (maxExp !== null && min !== null && min > maxExp) return 'experience';
    return null;
  };
}

// Per-platform "already seen" cache so each job is scored only once.
function seenCache(platform) {
  ensureDir(CACHE_DIR);
  const file = path.join(CACHE_DIR, `seen_${slug(platform)}.json`);
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
  const set = new Set(seen);
  return {
    has: id => set.has(id),
    add: id => { if (!set.has(id)) { set.add(id); seen.push(id); } },
    save: () => fs.writeFileSync(file, JSON.stringify(seen.slice(-5000)))
  };
}

// ---------- Browser ----------
// Discovery modes (no stealth anywhere):
//   NORMAL  - standard headless browser (scheduled runs)
//   VISIBLE - headed browser with the user's saved session, slow and observable (dashboard button)
// The first bot check / access denial stops the run (BLOCKED) — never retried or evaded.

async function newScrapeContext(opts = {}) {
  const mode = opts.visible ? MODES.VISIBLE_REVIEW : MODES.NORMAL;
  return launch(mode, { storageState: opts.storageState, locale: opts.locale || 'en-IN', profile: opts.profile });
}

// Opens a job page and returns the main visible text (trimmed), used as the JD for scoring.
async function fetchDescription(context, url, selectors = [], checkBlocked = null) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    if (checkBlocked && await checkBlocked(page)) return '';
    for (const sel of selectors) {
      const text = await page.locator(sel).first().innerText({ timeout: 2000 }).catch(() => '');
      if (text && text.trim().length > 200) return clip(text);
    }
    return clip(await page.locator('main').first().innerText({ timeout: 2000 }).catch(() => '')
      || await page.locator('body').innerText().catch(() => ''));
  } catch (_) {
    return '';
  } finally {
    await page.close().catch(() => {});
  }
}

function clip(text, max = 4000) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A scraper must finish well inside the helper's kill timeout (30 min scheduled, 45 min visible),
// or everything it collected is lost.
const SCRAPE_BUDGET_MS = 20 * 60 * 1000;
const VISIBLE_BUDGET_MS = 40 * 60 * 1000;

const VISIBLE_PAUSE_MS = 5000;
const visiblePause = () => new Promise(r => setTimeout(r, Number(process.env.JOB_AGENT_VISIBLE_PAUSE_MS ?? VISIBLE_PAUSE_MS)));

// Runs a scraper body with shared dedupe, filtering, JD fetching and JSON output.
// collect(ctx) must return raw jobs: {job_title, company, location, job_url, job_id?, description?, region}.
// Before each search it calls `if (!(await ctx.nextSearch())) break/return` — that enforces the
// time budget, the visible-mode search limit + pacing, and stops everything after a block.
async function runScraper(platform, collect, { descriptionSelectors = [], storageState, locale, describe, visible } = {}) {
  let browser;
  const isVisible = visible ?? process.argv.includes('--visible');
  const started = Date.now();
  const budget = isVisible ? VISIBLE_BUDGET_MS : SCRAPE_BUDGET_MS;
  let blocked = null; // { kind, detail, url } of the first challenge; ends the run
  let parked = null;  // a saved recovery checkpoint, if the block was parked for you
  let searches = 0;
  let humanSolved = 0;
  const shouldStop = () => !!blocked || Date.now() - started > budget;

  // Scrapers call this after each navigation; true = stop (bot check / access denied / login wall).
  // In NORMAL mode a login form on a public search page isn't a block. In VISIBLE mode a check you
  // can solve (CAPTCHA, Cloudflare, OTP, login) waits for you in the window; once it's gone the
  // same page is loaded again once and the run continues. Access Denied, an unsolved check, or the
  // same check coming straight back stops the whole run.
  const checkBlocked = async page => {
    if (blocked) return true;
    let ch = await detectChallenge(page);
    if (!ch.kind || (ch.kind === 'login' && !isVisible)) return false;
    if (isVisible) {
      // Conditional recovery: if you're at the laptop, solve it and continue the search from here;
      // if not, park a checkpoint and stop (no 5-min block for nobody).
      const r = await recover(page, ch, { id: `search_${platform}_${searches}`, kind: 'search', site: platform, url: page.url(), cursor: { searches } });
      if (r.resumed) { humanSolved++; ch = await detectChallenge(page); if (!ch.kind) return false; }
      if (r.parked) parked = r.checkpoint;
    }
    blocked = { kind: ch.kind, detail: ch.detail, url: page.url() };
    return true;
  };

  try {
    const cfg = loadSearchConfig();
    const maxSearches = isVisible ? (cfg.discovery?.visibleMaxSearches ?? 6) : Infinity;
    const nextSearch = async () => {
      if (shouldStop() || searches >= maxSearches) return false;
      if (isVisible && searches > 0) await visiblePause();
      searches++;
      return true;
    };
    const keep = makeJobFilter(cfg);
    const cardSkip = makeCardFilter(cfg);
    const cache = seenCache(platform);
    // JOB_AGENT_STORAGE_STATE: tests only (a fixture session instead of your real saved login).
    const opened = await newScrapeContext({ storageState: process.env.JOB_AGENT_STORAGE_STATE || storageState, locale, visible: isVisible, profile: platform });
    browser = opened.browser;
    const raw = await collect({ cfg, context: opened.context, shouldStop, checkBlocked, nextSearch, visible: isVisible });

    const jobs = [];
    const batchSeen = new Set();
    // Counts every stage so "0 new jobs" can't be mistaken for "nothing could be read".
    const stats = { extracted: raw.length, duplicateInRun: 0, alreadySeen: 0, filteredOut: 0, filteredLocation: 0, filteredExperience: 0, rejectedAfterDetails: 0, notSentOverLimit: 0 };
    if (raw.preFiltered) stats.sitePreFiltered = raw.preFiltered; // e.g. foundit reposts / experience
    const maxJobs = cfg.maxJobsPerRun || 15;
    for (const j of raw) {
      const id = j.job_id || j.job_url;
      if (!id) continue;
      if (batchSeen.has(id)) { stats.duplicateInRun++; continue; }
      batchSeen.add(id);
      if (cache.has(id)) { stats.alreadySeen++; continue; }
      if (!keep(j)) { stats.filteredOut++; continue; }
      const skip = cardSkip(j);
      if (skip) { stats.filteredOut++; stats[skip === 'location' ? 'filteredLocation' : 'filteredExperience']++; cache.add(id); continue; }
      // Over the per-run limit (or out of time): left unseen, so the next search picks them up.
      if (jobs.length >= maxJobs || Date.now() - started > budget) { stats.notSentOverLimit++; continue; }
      if (!blocked && (!j.description || j.description.length < 200)) {
        if (isVisible && !describe) await visiblePause(); // job-detail pages are paced like searches
        const jd = describe
          ? await describe(j).catch(() => '')
          : await fetchDescription(opened.context, j.job_url, descriptionSelectors, checkBlocked);
        // describe() returns null to reject a job once its description is known (e.g. not really remote).
        if (jd === null) { cache.add(id); stats.rejectedAfterDetails++; continue; }
        if (jd) j.description = jd;
      }
      j.description = j.description || `${j.job_title} at ${j.company}. See ${j.job_url}`;
      jobs.push({ ...j, source_platform: j.source_platform || platform });
      cache.add(id);
    }
    cache.save();
    if (humanSolved) stats.checksSolvedByYou = humanSolved;
    const notes = [];
    if (blocked) notes.push(`BLOCKED: ${platform} showed ${blocked.kind} (${String(blocked.detail).slice(0, 60)}) at ${blocked.url}; stopped, not retried or bypassed`);
    if (Date.now() - started > budget) notes.push(`stopped early at the ${Math.round(budget / 60000)}-min time budget`);
    out({ jobs, count: jobs.length, mode: isVisible ? 'VISIBLE' : 'NORMAL', searches, blocked, parked, stats, note: notes.join('; ') || undefined });
  } catch (e) {
    out({ error: e.message, jobs: [], mode: isVisible ? 'VISIBLE' : 'NORMAL', searches, blocked, parked });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------- Applying (review mode) ----------

function resolveResume(profile, override) {
  const p = String(override || profile.resumePath || '').trim();
  if (!p) throw new Error('No CV file: set resumePath in profile.json');
  const resolved = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  if (!RESUME_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error(`CV must be PDF/DOC/DOCX/RTF: ${resolved}`);
  if (!fs.existsSync(resolved)) throw new Error(`CV file not found: ${resolved}`);
  return resolved;
}

// answerFor / optionSynonyms live in answer_resolver.js (single copy); re-exported below.

async function fieldLabel(control) {
  return control.evaluate(el => {
    const parts = el.labels ? Array.from(el.labels).map(l => l.innerText) : [];
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      parts.push(document.getElementById(id)?.innerText || '');
    }
    const fieldset = el.closest('fieldset');
    if (fieldset) parts.push(fieldset.querySelector('legend')?.innerText || '');
    parts.push(el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id);
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

// Fills every visible input/select/textarea (and yes/no radio groups) we have an answer for.
// Never clicks buttons. Returns what was filled and which questions still need a human.
async function fillForm(scope, profile, { cvPath, coverLetterPath } = {}) {
  const filled = [];
  const unanswered = [];
  const controls = scope.locator('input, textarea, select');
  const count = await controls.count();

  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const type = String(await control.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'password', 'checkbox'].includes(type)) continue;

    if (type === 'file') {
      const label = (await fieldLabel(control)).toLowerCase();
      const file = /cover/.test(label) ? coverLetterPath : cvPath;
      if (file && fs.existsSync(file)) {
        await control.setInputFiles(file).then(() => filled.push(`file:${path.basename(file)}`)).catch(() => {});
      }
      continue;
    }

    const label = await fieldLabel(control);
    const answer = answerFor(label, profile);

    if (type === 'radio') {
      if (!answer) continue;
      const optionText = await control.evaluate(el => (el.labels?.[0]?.innerText || el.value || '')).catch(() => '');
      if (optionText.trim().toLowerCase() === answer.toLowerCase()) {
        await control.check({ force: true }).then(() => filled.push(label)).catch(() => {});
      }
      continue;
    }

    const current = await control.inputValue().catch(() => '');
    if (current) continue;
    if (!answer) {
      if (label) unanswered.push(label.slice(0, 120));
      continue;
    }
    const isSelect = await control.evaluate(el => el.tagName === 'SELECT').catch(() => false);
    if (isSelect) {
      const value = await control.locator('option').evaluateAll((opts, wants) => {
        const text = o => o.textContent.trim().toLowerCase();
        for (const want of wants) {
          const hit = opts.find(o => text(o) === want) || opts.find(o => text(o).startsWith(want));
          if (hit) return hit.value;
        }
        return null;
      }, [answer.toLowerCase(), ...optionSynonyms(label, answer)]).catch(() => null);
      if (value != null) await control.selectOption(value).then(() => filled.push(label)).catch(() => {});
      else unanswered.push(label.slice(0, 120));
    } else {
      await control.fill(answer).then(() => filled.push(label)).catch(() => {});
    }
  }
  return { filled: [...new Set(filled)], unanswered: [...new Set(unanswered)] };
}

// Standard CLI for apply scripts: --url --cv --coverletter --company --title --mode prefill|review
function parseApplyArgs() {
  const args = require('minimist')(process.argv.slice(2));
  const clean = s => (s == null ? '' : String(s)).replace(/^["']+|["']+$/g, '').trim();
  const mode = clean(args.mode) || 'prefill';
  if (!['prefill', 'review'].includes(mode)) throw new Error(`--mode must be prefill or review, got ${mode}`);
  return {
    url: clean(args.url),
    cv: clean(args.cv),
    coverLetter: clean(args.coverletter),
    company: clean(args.company) || 'unknown',
    title: clean(args.title) || 'unknown',
    mode
  };
}

// Wraps an apply script: launches the browser (headless for prefill, visible for review),
// provides screenshot(), prints one JSON result, and in review mode waits for the user to close the window.
// SAFETY: apply scripts must never click a final submit button. The user submits in review mode.
async function runApply(platform, body, { storageState, userDataDir } = {}) {
  let args;
  try { args = parseApplyArgs(); } catch (e) { return out({ success: false, error: e.message }); }
  if (!args.url) return out({ success: false, error: 'No --url provided' });

  const { chromium } = require('playwright');
  const headless = args.mode === 'prefill';
  const screenshots = [];
  let browser, context;

  try {
    const profile = loadUserProfile();
    const missing = ['fullName', 'email', 'phone'].filter(k => !String(profile[k] || '').trim());
    if (missing.length) throw new Error(`profile.json is missing: ${missing.join(', ')}`);
    const cvPath = resolveResume(profile, args.cv);

    if (storageState && !fs.existsSync(storageState)) {
      return out({ success: false, error: `No saved ${platform} login. Run setup\\LOGIN_ONCE.bat`, action_required: 'one_time_login' });
    }

    if (userDataDir) {
      context = await chromium.launchPersistentContext(userDataDir, { headless, viewport: { width: 1366, height: 900 }, channel: 'chrome' });
    } else {
      browser = await chromium.launch({ headless, channel: 'chrome' });
      context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        ...(storageState ? { storageState } : {})
      });
    }
    const page = context.pages()[0] || await context.newPage();

    ensureDir(OUTPUT_DIR);
    const screenshot = async label => {
      const fp = path.join(OUTPUT_DIR, `${slug(platform)}_${slug(args.company)}_${label}_${ts()}.png`);
      await page.screenshot({ path: fp, fullPage: true }).then(() => screenshots.push(fp)).catch(() => {});
      return fp;
    };

    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const result = await body({ page, context, profile, args, cvPath, screenshot });
    await screenshot('final');

    const payload = {
      success: !!result.ready,
      status: result.ready ? 'AWAITING_MANUAL_SUBMIT' : 'FAILED',
      mode: args.mode,
      screenshot: screenshots[screenshots.length - 1] || null,
      screenshots,
      form_url: page.url(),
      filled: result.filled || [],
      unanswered: result.unanswered || [],
      error: result.ready ? null : (result.error || 'Form could not be prepared'),
      note: result.note || null
    };
    out(payload);

    if (args.mode === 'review') {
      // Leave the filled form open. The user reviews it, clicks Submit, and closes the window.
      await new Promise(resolve => {
        context.on('close', resolve);
        if (browser) browser.on('disconnected', resolve);
        page.on('close', () => { if (context.pages().length === 0) resolve(); });
      });
    }
  } catch (e) {
    out({ success: false, status: 'FAILED', mode: args.mode, error: e.message, screenshot: screenshots[screenshots.length - 1] || null, screenshots });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// Clicks the first visible element matching any selector. Used only for "open the form" buttons.
async function clickFirst(page, selectors, timeout = 2500) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(2500);
      return sel;
    }
  }
  return null;
}

module.exports = {
  ROOT, OUTPUT_DIR,
  ensureDir, ts, slug, out, clip,
  loadSearchConfig, loadUserProfile, makeJobFilter, makeCardFilter, seenCache,
  runScraper, fetchDescription,
  resolveResume, answerFor, fillForm, runApply, clickFirst
};
