// Application engine: one entry point for every "prepare an application" run.
//
//   prefill (headless, called by the helper's /apply):
//     native page (NORMAL mode) -> bot check? -> BLOCKED: SECURITY_CHALLENGE / LOGIN_REQUIRED
//                               -> platform's deterministic handler (kept from the old scripts)
//                               -> external apply link?  -> EXTERNAL_ATS mode + agentic form-filler
//                               -> unfamiliar form?      -> agentic form-filler fallback
//     external ATS URL known up front (e.g. foundit applyUrl) -> EXTERNAL_ATS mode directly
//   review (the dashboard's "Review & submit"):
//     native jobs  -> open in the user's normal browser (their own session; bot checks pass there)
//     external ATS -> VISIBLE_REVIEW: visible browser, form re-filled, left open for the user
//
//   auto (helper, score >= policy.autoMinScore on an allowlisted platform):
//     VISIBLE window with the site's persistent profile -> a check you can solve waits for you ->
//     handler.inspect -> one-click Apply -> handler.finalSubmit clicks it ONCE and verifies the
//     site's confirmation. Anything unexpected stops and is left for you (never guessed, never re-clicked).
//
// Final submission: config/submission_policy.json (default manual). 'auto' needs an allowlist entry,
// a verified finalSubmit handler, AND the auto mode + minimum score. Indeed is always manual.
// External company-site (ATS) forms are filled but their Submit is never clicked.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MODES, launch, detectChallenge, statusForChallenge, challengeNote } = require('./browser_modes');
const { recover } = require('./recovery');
const { fillForm, statusFromReport, qwenMapper } = require('./agentic_form_filler');
const { extractFields } = require('./form_schema');
const { buildTrusted } = require('./answer_resolver');
const { ROOT, OUTPUT_DIR, ensureDir, slug, ts, out, resolveResume, loadUserProfile } = require('./common');

const NATIVE = ['naukri', 'indeed', 'foundit'];
const POLICY_PATH = path.join(ROOT, 'config', 'submission_policy.json');

// ---------- submission policy ----------

function loadPolicy(file = POLICY_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { default: 'manual', platforms: {}, domains: {} }; }
}

// 'auto' only when explicitly allowlisted AND a verified finalSubmit handler exists. Indeed never.
function submissionDecision(policy, { platform, domain, handler }) {
  if (platform === 'indeed' || /(^|\.)indeed\./i.test(domain || '')) return 'manual';
  const byDomain = domain && policy.domains ? policy.domains[domain] : undefined;
  const setting = byDomain || (policy.platforms || {})[platform] || policy.default || 'manual';
  if (setting !== 'auto') return 'manual';
  return handler && typeof handler.finalSubmit === 'function' && handler.finalSubmitVerified === true ? 'auto' : 'manual';
}

// Auto-apply for this job right now: policy says auto (with a verified handler) AND the fit score
// is at least policy.autoMinScore (default 80). Anything below waits for your review.
function autoApplyAllowed(policy, { platform, domain, handler, score }) {
  if (submissionDecision(policy, { platform, domain, handler }) !== 'auto') return false;
  const min = typeof policy.autoMinScore === 'number' ? policy.autoMinScore : 80;
  return Number.isFinite(Number(score)) && Number(score) >= min;
}

// ---------- helpers ----------

function openInDefaultBrowser(url) {
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
}

function httpUrl(u) {
  try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x : null; } catch (_) { return null; }
}

function coverLetterTextFor(coverLetterPath) {
  if (!coverLetterPath) return '';
  const md = coverLetterPath.replace(/\.pdf$/i, '.md');
  try { return fs.readFileSync(md, 'utf8').trim().slice(0, 4000); } catch (_) { return ''; }
}

// Clicks a button/link that opens an external application in a new tab or the same tab,
// and returns the resulting URL. Used for "Apply on company site" (opens a page, submits nothing).
async function captureExternalUrl(page, context, locator) {
  const href = await locator.getAttribute('href').catch(() => null);
  if (href && httpUrl(new URL(href, page.url()).toString())) return new URL(href, page.url()).toString();
  const popup = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const before = page.url();
  await locator.click().catch(() => {});
  const p = await popup;
  if (p) {
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    const u = p.url();
    await p.close().catch(() => {});
    return httpUrl(u) ? u : null;
  }
  await page.waitForTimeout(2500);
  return page.url() !== before && httpUrl(page.url()) ? page.url() : null;
}

// On an ATS job page with no form yet, one "Apply" link/button (not a form submit) opens the form.
async function openAtsForm(page) {
  const candidates = page.locator('a, button').filter({ hasText: /^\s*(apply|apply now|apply for this job|start application|i'?m interested)\s*$/i });
  const n = await candidates.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const isSubmit = await el.evaluate(e => e.type === 'submit' && !!e.form).catch(() => true);
    if (isSubmit) continue; // never a form submit
    await el.click().catch(() => {});
    await page.waitForTimeout(3000);
    return true;
  }
  return false;
}

// ---------- run ----------

// opts: { platform, url, externalUrl, company, title, cv, coverLetter, mode, handler, llm, outputDir, profile }
async function run(opts) {
  // check: like auto (visible window, your profile, pauses for checks you can solve) but read-only:
  // it finds out exactly what the job needs and never clicks the site's Apply.
  const mode = ['review', 'auto', 'check'].includes(opts.mode) ? opts.mode : 'prefill';
  const platform = String(opts.platform || 'external').toLowerCase();
  const handler = opts.handler || null;
  const outDir = ensureDir(opts.outputDir || OUTPUT_DIR);
  const screenshots = [];
  const policy = opts.policy || loadPolicy();
  const llm = opts.llm === undefined ? qwenMapper : opts.llm;
  const base = { mode, platform, submission: 'manual', screenshots };
  const browsers = [];
  const shot = async (page, label) => {
    const fp = path.join(outDir, `${slug(platform)}_${slug(opts.company)}_${label}_${ts()}.png`);
    await page.screenshot({ path: fp, fullPage: true }).then(() => screenshots.push(fp)).catch(() => {});
    return fp;
  };
  const result = (status, extra = {}) => ({
    ...base,
    success: status !== 'FAILED',
    status,
    screenshot: screenshots[screenshots.length - 1] || null,
    ...extra
  });

  try {
    const jobUrl = httpUrl(opts.url);
    const extUrl = opts.externalUrl ? httpUrl(opts.externalUrl) : null;
    if (!jobUrl && !extUrl) return result('FAILED', { error: `Invalid job URL: ${opts.url}` });

    // ----- review -----
    if (mode === 'review') {
      if (!extUrl && NATIVE.includes(platform)) {
        openInDefaultBrowser(jobUrl.toString());
        return result('AWAITING_MANUAL_SUBMIT', { browserMode: MODES.VISIBLE_REVIEW, form_url: jobUrl.toString(), note: 'Opened in your browser. Review and click Apply yourself.' });
      }
      return await reviewAts(extUrl || jobUrl, opts, llm, browsers, result);
    }

    // ----- prefill -----
    const profile = opts.profile || loadUserProfile();
    const missing = ['fullName', 'email', 'phone'].filter(k => !String(profile[k] || '').trim());
    if (missing.length) return result('FAILED', { error: `profile.json is missing: ${missing.join(', ')}` });
    const cvPath = resolveResume(profile, opts.cv);
    const trusted = buildTrusted({ profile, cvPath, coverLetterPath: opts.coverLetter || '', coverLetterText: coverLetterTextFor(opts.coverLetter) });

    let atsUrl = extUrl;
    let nativeNote = '';
    let visibleContext = null; // check/auto: company-site forms open in the same visible browser

    if (!atsUrl) {
      if (handler && handler.storageState && !fs.existsSync(handler.storageState)) {
        return result('LOGIN_REQUIRED', { detail: 'LOGIN', error: `No saved ${platform} login. Run setup\\LOGIN_ONCE.bat` });
      }
      // auto: a visible window with the site's persistent profile (the headless check is blocked by
      // these sites); prefill: headless as before.
      const visible = mode === 'auto' || mode === 'check';
      const { browser, context } = await launch(visible ? MODES.VISIBLE_REVIEW : MODES.NORMAL, { storageState: handler && handler.storageState, profile: visible ? platform : undefined });
      browsers.push(browser);
      visibleContext = visible ? context : null;
      const page = await context.newPage();

      let verdict;
      if (handler && handler.navigate === false) {
        verdict = await handler.inspect({ page, context, url: jobUrl.toString(), opts, visible });
      } else {
        await page.goto(jobUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        let ch = await detectChallenge(page);
        // Visible check/auto: if you're at the laptop, solve it and resume; if away, park a checkpoint.
        if (ch.kind && visible) {
          const r = await recover(page, ch, { id: `job_${platform}_${slug(opts.company)}`, kind: 'job_page', site: platform, url: jobUrl.toString(), job: { platform, company: opts.company, title: opts.title } });
          if (r.resumed) { await page.waitForTimeout(1500); ch = await detectChallenge(page); }
        }
        if (ch.kind) {
          await shot(page, 'blocked');
          return result(statusForChallenge(ch.kind), { detail: `CHALLENGE_${String(ch.kind).toUpperCase()}`, challenge: ch.kind, browserMode: MODES.BLOCKED, form_url: page.url(), note: challengeNote(ch.kind, ch.detail) });
        }
        verdict = handler ? await handler.inspect({ page, context, url: jobUrl.toString(), opts, visible }) : { state: 'NOT_FOUND' };
      }
      verdict = verdict || { state: 'NOT_FOUND' };

      switch (verdict.state) {
        case 'BLOCKED':
          await shot(page, 'blocked');
          return result(statusForChallenge(verdict.kind), { detail: `CHALLENGE_${String(verdict.kind || 'unknown').toUpperCase()}`, challenge: verdict.kind, browserMode: MODES.BLOCKED, form_url: page.url(), note: verdict.note || challengeNote(verdict.kind, '') });
        case 'LOGIN_REQUIRED':
          await shot(page, 'login');
          return result('LOGIN_REQUIRED', { detail: 'LOGIN', error: verdict.note || `${platform} session expired. Run setup\\LOGIN_ONCE.bat` });
        case 'ALREADY_APPLIED':
          await shot(page, 'already_applied');
          return result('ALREADY_APPLIED', { detail: 'SITE_SHOWS_APPLIED', note: verdict.note || `Already applied on ${platform}.` });
        case 'CLOSED':
          await shot(page, 'closed');
          return result('FAILED', { detail: 'CLOSED', error: verdict.note || 'Job is closed or no longer accepting applications.' });
        case 'READY_ONE_CLICK': {
          // The site's own one-click Apply. Clicked only in auto mode, when policy + verified handler +
          // minimum score all allow it; the handler clicks once and verifies the confirmation.
          const decision = submissionDecision(policy, { platform, domain: jobUrl.hostname, handler });
          if (mode === 'auto' && autoApplyAllowed(policy, { platform, domain: jobUrl.hostname, handler, score: opts.score })) {
            await shot(page, 'before_apply');
            let r;
            try {
              r = await handler.finalSubmit({ page, context, trusted, opts, url: jobUrl.toString() });
            } catch (e) {
              r = { state: 'NEEDS_HUMAN_INPUT', note: `Auto-apply stopped (${String(e.message).slice(0, 120)}). Check the job on ${platform} before applying again.` };
            }
            await shot(r.page || page, r.state === 'APPLIED' ? 'applied' : 'after_apply');
            const status = ['APPLIED', 'ALREADY_APPLIED', 'NEEDS_HUMAN_INPUT', 'SECURITY_CHALLENGE', 'LOGIN_REQUIRED'].includes(r.state) ? r.state : 'NEEDS_HUMAN_INPUT';
            return result(status, {
              detail: status === 'APPLIED' ? 'SITE_CONFIRMED_APPLIED' : r.clicked ? 'CLICKED_UNCONFIRMED' : 'AUTO_STOPPED',
              browserMode: MODES.VISIBLE_REVIEW, form_url: page.url(), submission: 'auto', auto_clicked: !!r.clicked,
              note: r.note || '', needs_input: r.needs_input || []
            });
          }
          await shot(page, 'ready');
          return result('AWAITING_MANUAL_SUBMIT', {
            detail: 'READY_ONE_CLICK', browserMode: visible ? MODES.VISIBLE_REVIEW : MODES.NORMAL, form_url: page.url(), submission: decision,
            note: verdict.note || `${platform} applies in one click with your profile. Open Review & submit and click Apply yourself.`
          });
        }
        case 'EXTERNAL':
          if (!verdict.externalUrl) {
            await shot(page, 'external');
            return result('AWAITING_MANUAL_SUBMIT', { detail: 'COMPANY_SITE_NO_LINK', note: 'Applies on the company site, but its link could not be read. Open Review and follow the Apply link.' });
          }
          atsUrl = httpUrl(verdict.externalUrl);
          nativeNote = `${platform} sends you to the company site. `;
          break;
        case 'FORM': {
          // A native form the handler opened (e.g. an inline apply form): agentic filler, never submit.
          const formPage = verdict.page || page;
          const report = await fillForm(formPage, verdict.scope || formPage.locator('body'), { trusted }, { llm });
          await shot(formPage, 'form');
          const s = statusFromReport(report);
          return result(s.status, { browserMode: MODES.NORMAL, form_url: formPage.url(), note: s.note, report, needs_input: [...report.highRisk, ...report.needsHumanInput] });
        }
        default: {
          // Unfamiliar page: agentic fallback, only if there is actually a form.
          const fields = await extractFields(page.locator('body')).catch(() => []);
          if (fields.filter(f => f.kind !== 'file').length >= 2) {
            const report = await fillForm(page, page.locator('body'), { trusted }, { llm });
            await shot(page, 'form');
            const s = statusFromReport(report);
            return result(s.status, { browserMode: MODES.NORMAL, form_url: page.url(), note: s.note, report, needs_input: [...report.highRisk, ...report.needsHumanInput] });
          }
          await shot(page, 'not_found');
          return result('FAILED', { detail: 'APPLY_NOT_FOUND', error: verdict.note || 'Apply button not found (job closed?)' });
        }
      }
    }

    return await prefillAts(atsUrl, trusted, opts, llm, browsers, shot, result, nativeNote, { context: visibleContext, visible: mode === 'check' || mode === 'auto' });
  } catch (e) {
    return result('FAILED', { error: String(e && e.message || e).slice(0, 300) });
  } finally {
    if (mode !== 'review') for (const b of browsers) await b.close().catch(() => {});
  }
}

// Company-site (ATS) form: filled, never submitted. In check/auto mode it opens in the same visible
// browser as the job page (company sites often block headless browsers too), and a check you can
// solve waits for you.
async function prefillAts(atsUrl, trusted, opts, llm, browsers, shot, result, prefixNote = '', { context: shared = null, visible = false } = {}) {
  let context = shared;
  if (!context) {
    const opened = await launch(visible ? MODES.VISIBLE_REVIEW : MODES.EXTERNAL_ATS);
    browsers.push(opened.browser);
    context = opened.context;
  }
  const page = await context.newPage();
  await page.goto(atsUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  let ch = await detectChallenge(page);
  if (ch.kind && visible) {
    const r = await recover(page, ch, { id: `form_${slug(opts.company)}`, kind: 'company_form', site: atsUrl.hostname, url: atsUrl.toString(), job: { company: opts.company, title: opts.title } });
    if (r.resumed) { await page.waitForTimeout(1500); ch = await detectChallenge(page); }
  }
  if (!ch.kind) {
    const fields = await extractFields(page.locator('body')).catch(() => []);
    if (fields.filter(f => f.kind !== 'file').length < 2 && await openAtsForm(page)) ch = await detectChallenge(page);
  }
  if (ch.kind) {
    await shot(page, 'ats_blocked');
    return result(statusForChallenge(ch.kind), { detail: `COMPANY_SITE_CHALLENGE_${String(ch.kind).toUpperCase()}`, challenge: ch.kind, browserMode: MODES.BLOCKED, form_url: page.url(), external_apply_url: atsUrl.toString(), note: prefixNote + challengeNote(ch.kind, ch.detail) });
  }

  const report = await fillForm(page, page.locator('body'), { trusted }, { llm });
  await shot(page, 'ats_filled');
  const s = statusFromReport(report);
  return result(s.status, {
    detail: s.status === 'AWAITING_MANUAL_SUBMIT' ? 'COMPANY_FORM_READY' : s.status === 'UNSUPPORTED_FORM' ? 'COMPANY_FORM_UNSUPPORTED' : 'COMPANY_FORM_NEEDS_INPUT',
    browserMode: visible ? MODES.VISIBLE_REVIEW : MODES.EXTERNAL_ATS,
    form_url: page.url(),
    external_apply_url: atsUrl.toString(),
    note: prefixNote + (s.status === 'AWAITING_MANUAL_SUBMIT' ? `External ATS form prepared: ${s.note}` : s.note),
    report,
    needs_input: [...report.highRisk, ...report.needsHumanInput]
  });
}

// VISIBLE_REVIEW for external ATS: fill again in a visible window and leave it open for the user.
async function reviewAts(url, opts, llm, browsers, result) {
  const { browser, context } = await launch(MODES.VISIBLE_REVIEW);
  browsers.push(browser);
  const page = await context.newPage();
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  let note = 'Visible review: the form is filled; check it and submit yourself.';
  const ch = await detectChallenge(page);
  if (ch.kind) {
    note = `${challengeNote(ch.kind, ch.detail)} Complete it in this window, then apply yourself.`;
  } else {
    try {
      const profile = opts.profile || loadUserProfile();
      const trusted = buildTrusted({ profile, cvPath: resolveResume(profile, opts.cv), coverLetterPath: opts.coverLetter || '', coverLetterText: coverLetterTextFor(opts.coverLetter) });
      const fields = await extractFields(page.locator('body')).catch(() => []);
      if (fields.filter(f => f.kind !== 'file').length < 2) await openAtsForm(page);
      const report = await fillForm(page, page.locator('body'), { trusted }, { llm });
      note = statusFromReport(report).note;
    } catch (e) {
      note = `Opened for review (auto-fill skipped: ${e.message}).`;
    }
  }
  out(result('AWAITING_MANUAL_SUBMIT', { browserMode: MODES.VISIBLE_REVIEW, form_url: page.url(), note }));
  // Leave it open until the user closes the window. Never submits.
  await new Promise(resolve => { browser.on('disconnected', resolve); context.on('close', resolve); });
  return null;
}

// ---------- CLI used by naukri_apply.js / indeed_apply.js / foundit_apply.js ----------

function parseArgs(argv = process.argv.slice(2)) {
  const a = require('minimist')(argv);
  const clean = s => (s == null ? '' : String(s)).replace(/^["']+|["']+$/g, '').trim();
  return {
    url: clean(a.url), externalUrl: clean(a.external), cv: clean(a.cv), coverLetter: clean(a.coverletter),
    company: clean(a.company) || 'unknown', title: clean(a.title) || 'unknown', mode: clean(a.mode) || 'prefill',
    score: a.score === undefined ? null : Number(a.score)
  };
}

async function cli(platform, handler) {
  const args = parseArgs();
  const r = await run({ ...args, platform, handler });
  if (r) out(r); // review mode prints its own line and returns null
}

module.exports = { run, cli, parseArgs, loadPolicy, submissionDecision, autoApplyAllowed, captureExternalUrl, openAtsForm, NATIVE };
