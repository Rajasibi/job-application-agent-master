// LinkedIn Easy Apply — review mode. Walks the Easy Apply steps filling known answers
// and stops at the final "Submit application" step. It never clicks Submit.
const path = require('path');
const { runApply, fillForm, clickFirst } = require('./common');

const SUBMIT = /submit/i;

runApply('linkedin', async ({ page, profile, cvPath, args, screenshot }) => {
  if (await page.locator('text=/Join now|Sign in to/i').first().isVisible({ timeout: 2000 }).catch(() => false)) {
    return { ready: false, error: 'LinkedIn session expired. Run setup\\LOGIN_ONCE.bat' };
  }
  if (await page.locator('text=/No longer accepting applications/i').first().isVisible({ timeout: 1500 }).catch(() => false)) {
    return { ready: false, error: 'Job is no longer accepting applications' };
  }

  const opened = await clickFirst(page, ['button.jobs-apply-button:has-text("Easy Apply")', 'button:has-text("Easy Apply")'], 6000);
  if (!opened) {
    const external = await page.locator('button:has-text("Apply"), a:has-text("Apply")').first().isVisible({ timeout: 2000 }).catch(() => false);
    return external
      ? { ready: true, note: 'External application on company site — open Review to apply there.' }
      : { ready: false, error: 'No apply button found (already applied or closed?)' };
  }
  await screenshot('modal');

  const modal = page.locator('div[role="dialog"]').first();
  const filled = new Set();
  let unanswered = [];

  for (let step = 1; step <= 8; step++) {
    const r = await fillForm(modal, profile, { cvPath, coverLetterPath: args.coverLetter });
    r.filled.forEach(f => filled.add(f));
    unanswered = r.unanswered;

    if (await modal.locator('button:has-text("Submit application")').isVisible({ timeout: 1500 }).catch(() => false)) {
      return { ready: true, filled: [...filled], unanswered, note: 'Reached final step. Submit is left for you.' };
    }

    const next = modal.locator('button:has-text("Review"), button:has-text("Next"), button[aria-label*="Continue to next"]').last();
    const label = await next.innerText({ timeout: 1500 }).catch(() => '');
    if (!label || SUBMIT.test(label)) break;
    await next.click().catch(() => {});
    await page.waitForTimeout(2000);

    // Validation errors mean a required question we can't answer; stop here for the human.
    if (await modal.locator('.artdeco-inline-feedback--error').first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return { ready: true, filled: [...filled], unanswered, note: `Stopped at step ${step}: required questions need your answer.` };
    }
  }
  return { ready: true, filled: [...filled], unanswered, note: 'Partially filled; finish the remaining steps in Review.' };
}, { storageState: path.join(__dirname, 'linkedin_auth.json') });
