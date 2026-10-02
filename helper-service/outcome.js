// Maps an application-engine result to the stored pipeline status + an exact "next action" for you.
// APPLIED is only ever produced from a site-confirmed state (the engine's APPLIED after it saw the
// site's confirmation, or ALREADY_APPLIED = the job page shows Applied). A click alone never counts.

const SITE = { naukri: 'Naukri', foundit: 'foundit', indeed: 'Indeed', external: 'the company site' };
const CHALLENGE = { cloudflare: 'Cloudflare "verify you are human" check', captcha: 'CAPTCHA', otp: 'one-time code (OTP)', login: 'login', access_denied: '"Access Denied" block' };

function challengeKind(r) {
  if (r.challenge) return r.challenge;
  const m = String(r.detail || '').match(/CHALLENGE_([A-Z_]+)/);
  if (m) return m[1].toLowerCase();
  const n = String(r.note || '');
  return /cloudflare/i.test(n) ? 'cloudflare' : /access denied/i.test(n) ? 'access_denied' : /captcha/i.test(n) ? 'captcha' : /otp|one-time/i.test(n) ? 'otp' : 'unknown';
}

function listMissing(r) {
  const rep = r.report || {};
  const items = [
    ...(Array.isArray(r.needs_input) ? r.needs_input : String(r.needs_input || '').split(' | ')),
    ...(rep.unsupported || []), ...(rep.verifyFailed || []), ...(rep.validationErrors || [])
  ].map(s => String(s).replace(/\s*\*\s*$/, '').trim()).filter(Boolean);
  return [...new Set(items)].slice(0, 6);
}

// r: engine result ({ status, detail, note, error, needs_input, report, external_apply_url, challenge })
// job: the pipeline job ({ source_platform, job_url, ... })
function outcomeFor(r, job) {
  const platform = job.source_platform || job.platform || 'external';
  const site = SITE[platform] || platform;
  const company = /COMPANY/.test(r.detail || '') || /company site/i.test(r.note || '') || !!r.external_apply_url;
  const where = company ? 'the company site' : site;
  const missing = listMissing(r);
  const note = [r.note, r.error].filter(Boolean).join(' — ');
  const out = (status, next_action) => ({ status, next_action, detail: r.detail || '', notes: note });

  switch (r.status) {
    case 'APPLIED':
      return out('APPLIED', `Nothing: applied (confirmed by ${site})`);
    case 'ALREADY_APPLIED':
      return out('APPLIED', `Nothing: ${site} shows you already applied`);
    case 'AWAITING_MANUAL_SUBMIT':
      if (r.detail === 'READY_ONE_CLICK' && platform === 'indeed') return out('NEEDS_REVIEW', 'Open the job link and apply on Indeed yourself (Indeed Apply is never automated)');
      if (r.detail === 'READY_ONE_CLICK') return out('NEEDS_REVIEW', `Open the job link and click Apply on ${site} (one click; your profile is ready)`);
      if (company) return out('NEEDS_REVIEW', 'Company form filled: open Review & submit, check it, then click Submit on the company site');
      return out('NEEDS_REVIEW', `Open the job link and apply on ${site}`);
    case 'NEEDS_HUMAN_INPUT':
      if (r.detail === 'CLICKED_UNCONFIRMED') return out('NEEDS_REVIEW', `Apply was clicked but ${site} showed no confirmation: open the job and check whether it says Applied`);
      return out('NEEDS_REVIEW', missing.length
        ? `${company ? 'Company form filled; still needed' : `Answer on ${site}`}: ${missing.join('; ')}. Open Review & submit`
        : `Open Review & submit and finish the application on ${where}`);
    case 'UNSUPPORTED_FORM':
      return out('NEEDS_REVIEW', `Apply on ${where} yourself: ${r.detail === 'COMPANY_FORM_UNSUPPORTED' || /no application form/i.test(note) ? 'the agent found no form it can fill' : 'the form uses controls the agent can\'t operate'}`);
    case 'LOGIN_REQUIRED':
      return out('SECURITY_CHALLENGE', `Log in again: run setup\\LOGIN_ONCE.bat for ${site}, then Re-check`);
    case 'SECURITY_CHALLENGE': {
      const kind = challengeKind(r);
      if (kind === 'access_denied') return out('SECURITY_CHALLENGE', `${company ? 'The company site' : site} blocked automated access: open the job in your own browser and apply there`);
      return out('SECURITY_CHALLENGE', `${company ? 'The company site' : site} showed a ${CHALLENGE[kind] || 'security check'}: open the job in your own browser and apply (or Re-check while at the laptop to solve it in the agent's window)`);
    }
    case 'FAILED':
      if (r.detail === 'CLOSED' || /closed|expired|no longer/i.test(note)) return out('FAILED', 'Nothing: the job is closed');
      return out('FAILED', `Retry, or open the job yourself (${String(note || 'unexpected error').slice(0, 100)})`);
    default:
      return out('FAILED', `Retry, or open the job yourself (unexpected result: ${r.status || 'none'})`);
  }
}

module.exports = { outcomeFor };
