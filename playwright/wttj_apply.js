// Welcome to the Jungle — review mode. Opens the apply form and fills known fields.
// It never clicks "Send application".
const path = require('path');
const { runApply, fillForm, clickFirst } = require('./common');

runApply('wttj', async ({ page, context, profile, cvPath, args }) => {
  const consent = page.locator('button:has-text("OK for me"), button:has-text("Accept")').first();
  if (await consent.isVisible({ timeout: 2500 }).catch(() => false)) await consent.click().catch(() => {});

  const popup = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  const opened = await clickFirst(page, ['[data-testid="job_header-button-apply"]', 'button:has-text("Apply")', 'a:has-text("Apply")'], 5000);
  if (!opened) return { ready: false, error: 'No Apply button found (job closed?)' };

  const newPage = await popup;
  if (newPage) return { ready: true, note: `Applies on the company site (${new URL(newPage.url()).hostname}). Open Review to apply there.` };

  if (await page.locator('text=/Log in|Sign in/i').first().isVisible({ timeout: 1500 }).catch(() => false)
    && !(await page.locator('form input[type="email"]').first().isVisible({ timeout: 1000 }).catch(() => false))) {
    return { ready: false, error: 'WTTJ login required. Run setup\\LOGIN_ONCE.bat' };
  }

  const form = page.locator('div[role="dialog"], form').first();
  const r = await fillForm(form, profile, { cvPath, coverLetterPath: args.coverLetter });
  return { ready: true, ...r, note: 'Form filled. Review and click Send yourself.' };
}, { storageState: path.join(__dirname, 'wttj_auth.json') });
