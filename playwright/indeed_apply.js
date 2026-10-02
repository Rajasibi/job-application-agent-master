// Indeed — deterministic handler for the application engine. Compliant by design:
//   * Indeed's own "Apply now" (Indeed Apply) flow is NOT automated at all: the job is marked for
//     review and you complete it yourself in your normal browser.
//   * "Apply on company site" jobs open the employer's ATS, which the engine fills (never submits).
//   * A Cloudflare check stops the run as SECURITY_CHALLENGE (detected by the engine).
//   * Indeed can never be auto-submitted (hard-coded in application_engine.submissionDecision).
const path = require('path');
const { cli, captureExternalUrl } = require('./application_engine');

const handler = {
  platform: 'indeed',
  storageState: path.join(__dirname, 'indeed_auth.json'),
  async inspect({ page, context }) {
    const seen = sel => page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (await seen('text=/This job has expired|no longer available/i')) return { state: 'CLOSED', note: 'Job expired on Indeed.' };
    if (await seen('text=/You applied|Applied on/i')) return { state: 'ALREADY_APPLIED', note: 'Already applied on Indeed.' };
    const companySite = page.locator('button:has-text("Apply on company site"), a:has-text("Apply on company site")').first();
    if (await companySite.isVisible({ timeout: 1500 }).catch(() => false)) {
      return { state: 'EXTERNAL', externalUrl: await captureExternalUrl(page, context, companySite) };
    }
    if (await seen('#indeedApplyButton, button:has-text("Apply now"), button:has-text("Easily apply")')) {
      return { state: 'READY_ONE_CLICK', note: 'Indeed Apply job: open Review & submit and complete Indeed\'s form yourself (not automated).' };
    }
    return { state: 'NOT_FOUND' };
  }
};

if (require.main === module) cli('indeed', handler);
module.exports = { handler };
