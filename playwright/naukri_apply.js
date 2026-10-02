// Naukri — deterministic handler for the application engine.
// Naukri's "Apply" button submits instantly (one-click apply). It is clicked ONLY by finalSubmit, in
// the engine's auto mode (policy auto + score >= autoMinScore), exactly once, and the result is
// verified from Naukri's own confirmation. "Apply on company site" opens the employer's ATS, which
// the engine fills in EXTERNAL_ATS mode and never submits.
const path = require('path');
const { cli, captureExternalUrl } = require('./application_engine');
const { answerRecruiterQuestions } = require('./recruiter_questions');

const APPLIED_TEXT = /you have successfully applied|successfully applied|application (has been )?(sent|submitted) successfully/i;

const handler = {
  platform: 'naukri',
  storageState: path.join(__dirname, 'naukri_auth.json'),
  async inspect({ page, context }) {
    const seen = sel => page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (await seen('text=/Login to apply|Register to apply|Login to view/i')) return { state: 'LOGIN_REQUIRED', note: 'Naukri session expired. Run setup\\LOGIN_ONCE.bat' };
    if (await seen('button:has-text("Applied"), #already-applied')) return { state: 'ALREADY_APPLIED', note: 'Already applied on Naukri.' };
    if (await seen('text=/no longer (available|accepting)|job has expired|this job is closed/i')) return { state: 'CLOSED' };
    const companySite = page.locator('button:has-text("Apply on company site"), #company-site-button, a:has-text("Apply on company site")').first();
    if (await companySite.isVisible({ timeout: 1500 }).catch(() => false)) {
      return { state: 'EXTERNAL', externalUrl: await captureExternalUrl(page, context, companySite) };
    }
    if (await seen('button#apply-button, button:has-text("Apply")')) return { state: 'READY_ONE_CLICK' };
    return { state: 'NOT_FOUND' };
  },

  // Clicks Naukri's own Apply once, then waits for Naukri to confirm. If Naukri asks recruiter
  // questions, only questions with a trusted answer (profile / skills table) are answered; any
  // other question stops the run for you. Never clicks twice.
  finalSubmitVerified: true,
  async finalSubmit({ page, trusted }) {
    const button = page.locator('button#apply-button').first();
    const fallback = page.locator('button').filter({ hasText: /^\s*apply\s*$/i }).first();
    const target = (await button.isVisible({ timeout: 1500 }).catch(() => false)) ? button : fallback;
    if (!(await target.isVisible({ timeout: 1500 }).catch(() => false))) {
      return { state: 'NEEDS_HUMAN_INPUT', note: 'Naukri Apply button not found when applying. Open the job and apply yourself.' };
    }
    await target.click();
    const confirmed = () => Promise.race([
      page.locator(`text=${APPLIED_TEXT}`).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true),
      page.locator('button:has-text("Applied"), #already-applied').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true)
    ]).catch(() => false);

    // Recruiter questions (Naukri's chat drawer) may appear instead of the confirmation.
    const questions = await answerRecruiterQuestions(page, trusted, { timeoutMs: 8000 });
    if (questions.stopped) {
      return { state: 'NEEDS_HUMAN_INPUT', clicked: true, needs_input: questions.unanswered, note: `Naukri asked questions without a trusted answer: ${questions.unanswered.join(' | ').slice(0, 200)}. Open the job on Naukri, click Apply and answer them.` };
    }
    if (await confirmed()) {
      const extra = questions.answered.length ? ` Answered ${questions.answered.length} recruiter question(s) from your profile.` : '';
      return { state: 'APPLIED', clicked: true, note: `Applied automatically on Naukri.${extra}` };
    }
    return { state: 'NEEDS_HUMAN_INPUT', clicked: true, note: 'Apply was clicked but Naukri showed no confirmation. Check the job on Naukri before applying again.' };
  }
};

if (require.main === module) cli('naukri', handler);
module.exports = { handler, APPLIED_TEXT };
