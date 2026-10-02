// Tier 1 career sites (Workday, SuccessFactors, Taleo, iCIMS...) — review mode.
// Opens the application form, fills known fields, uploads the CV, and NEVER submits.
const { runApply, fillForm, clickFirst } = require('./common');

runApply('tier1', async ({ page, context, profile, cvPath, args, screenshot }) => {
  const popup = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  const opened = await clickFirst(page, [
    '[data-automation-id="adventureButton"]',
    'a:has-text("Apply now")', 'button:has-text("Apply now")',
    'a:has-text("Apply for this job")', 'button:has-text("Start application")',
    'a.apply-btn', '[data-testid="apply-button"]'
  ], 3000);

  const formPage = (await popup) || page;
  await formPage.waitForLoadState('domcontentloaded').catch(() => {});
  await formPage.waitForTimeout(3000);
  await screenshot('form_opened');

  // Most ATS portals require an account first; the user handles that in Review.
  if (await formPage.locator('text=/create account|sign in|log in/i').first().isVisible({ timeout: 1500 }).catch(() => false)
    && !(await formPage.locator('input[type="file"]').count())) {
    return { ready: true, note: `${args.company} portal requires sign-in; complete it in Review.` };
  }

  const r = await fillForm(formPage.locator('body'), profile, { cvPath, coverLetterPath: args.coverLetter });
  return {
    ready: true,
    ...r,
    note: opened ? 'Form filled. Review and submit yourself.' : 'No apply button detected; the job page is ready for Review.'
  };
});
