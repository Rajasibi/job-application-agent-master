// foundit.in — deterministic handler for the application engine.
// foundit's Apply can submit instantly with your saved profile, so it is NEVER clicked.
// Job pages block automated browsers, so the handler doesn't open them: it loads a search page
// (plain browser, no stealth) and asks foundit's own job-detail API whether the job is open,
// already applied, or applies on an external site (which the engine then fills as an ATS).
// If foundit blocks even that, the run stops as SECURITY_CHALLENGE.
//
// Auto mode (policy auto + score >= autoMinScore): finalSubmit opens the job page in the visible
// window, clicks foundit's Apply ONCE and verifies foundit's confirmation. Recruiter questions are
// answered only from trusted data; anything else stops for you.
const path = require('path');
const { cli } = require('./application_engine');
const { detectChallenge, statusForChallenge, challengeNote } = require('./browser_modes');
const { recover } = require('./recovery');
const { answerRecruiterQuestions } = require('./recruiter_questions');

const APPLIED_TEXT = /successfully applied|application (has been )?(sent|submitted)|you have applied|applied successfully/i;

function jobId(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' || !/(^|\.)foundit\.in$/i.test(url.hostname)) return null;
    return url.pathname.match(/-(\d{5,})\/?$/)?.[1] || null;
  } catch (_) { return null; }
}

const handler = {
  platform: 'foundit',
  storageState: path.join(__dirname, 'foundit_auth.json'),
  navigate: false,
  async inspect({ page, url, visible }) {
    const id = jobId(url);
    if (!id) return { state: 'NOT_FOUND', note: `Not a foundit job URL: ${url}` };
    const srp = 'https://www.foundit.in/srp/results?query=engineer';
    await page.goto(srp, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    let ch = await detectChallenge(page);
    // Visible window: if you're at the laptop, solve it and resume; if away, park a checkpoint.
    if (visible && ch.kind) {
      const r = await recover(page, ch, { id: `foundit_${id}`, kind: 'job_page', site: 'foundit', url: srp });
      if (r.resumed) { await page.goto(srp, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2000); ch = await detectChallenge(page); }
    }
    if (ch.kind && ch.kind !== 'login') return { state: 'BLOCKED', kind: ch.kind };

    const d = await page.evaluate(async jid => {
      const r = await fetch(`/middleware/jobdetail/${jid}`, { headers: { Accept: 'application/json' } });
      return r.ok ? (await r.json()).jobDetailResponse : { httpError: r.status };
    }, id).catch(e => ({ httpError: e.message }));

    if (!d || d.httpError) {
      return /40[13]/.test(String(d && d.httpError))
        ? { state: 'BLOCKED', kind: 'access_denied', note: `foundit refused the job lookup (HTTP ${d.httpError}). Manual browser interaction is required.` }
        : { state: 'NOT_FOUND', note: `foundit job lookup failed (${d ? d.httpError : 'no data'})` };
    }
    const expired = typeof d.closedAt === 'number' && d.closedAt < Date.now(); // closedAt is an expiry date
    if (d.isJobActive === false || d.activeJob === false || expired) return { state: 'CLOSED', note: 'Job is closed on foundit.' };
    if (d.isApplied) return { state: 'ALREADY_APPLIED', note: 'Already applied on foundit.' };
    const external = d.applyUrl || d.redirectUrl;
    if (external) return { state: 'EXTERNAL', externalUrl: external };
    return { state: 'READY_ONE_CLICK', note: 'foundit applies in one click with your profile. Open Review & submit and click Apply yourself.' };
  },

  finalSubmitVerified: true,
  async finalSubmit({ page, trusted, url }) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    let ch = await detectChallenge(page);
    if (ch.kind) {
      const r = await recover(page, ch, { id: `foundit_apply_${jobId(url)}`, kind: 'job_page', site: 'foundit', url });
      if (r.resumed) { await page.waitForTimeout(1500); ch = await detectChallenge(page); }
    }
    if (ch.kind) return { state: statusForChallenge(ch.kind), note: challengeNote(ch.kind, ch.detail) };

    const applied = page.locator('button:has-text("Applied"), [class*="applied"]:has-text("Applied")').first();
    if (await applied.isVisible({ timeout: 1500 }).catch(() => false)) return { state: 'ALREADY_APPLIED', note: 'Already applied on foundit.' };
    const button = page.locator('button, a').filter({ hasText: /^\s*(apply|apply now|quick apply)\s*$/i }).first();
    if (!(await button.isVisible({ timeout: 3000 }).catch(() => false))) {
      return { state: 'NEEDS_HUMAN_INPUT', note: 'foundit Apply button not found on the job page. Open the job and apply yourself.' };
    }
    await button.click();
    const questions = await answerRecruiterQuestions(page, trusted, { timeoutMs: 6000 });
    if (questions.stopped) {
      return { state: 'NEEDS_HUMAN_INPUT', clicked: true, needs_input: questions.unanswered, note: `foundit asked questions without a trusted answer: ${questions.unanswered.join(' | ').slice(0, 200)}. Open the job on foundit and finish applying.` };
    }
    const ok = await Promise.race([
      page.locator(`text=${APPLIED_TEXT}`).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true),
      applied.waitFor({ state: 'visible', timeout: 20000 }).then(() => true)
    ]).catch(() => false);
    if (ok) return { state: 'APPLIED', clicked: true, note: 'Applied automatically on foundit.' };
    return { state: 'NEEDS_HUMAN_INPUT', clicked: true, note: 'Apply was clicked but foundit showed no confirmation. Check the job on foundit before applying again.' };
  }
};

if (require.main === module) cli('foundit', handler);
module.exports = { handler, jobId, APPLIED_TEXT };
