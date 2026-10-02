// Submission policy, status system, and the no-stealth rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { submissionDecision, loadPolicy } = require('../application_engine');
const appLog = require('../application_log');

const verified = { finalSubmit: async () => {}, finalSubmitVerified: true };

test('default policy file is manual everywhere', () => {
  const p = loadPolicy();
  assert.equal(p.default, 'manual');
  for (const k of ['naukri', 'indeed', 'foundit']) assert.equal(p.platforms[k], 'manual');
  assert.deepEqual(p.domains, {});
});

test('manual unless allowlisted AND a verified handler exists', () => {
  const auto = { default: 'manual', platforms: { naukri: 'auto' }, domains: {} };
  assert.equal(submissionDecision(auto, { platform: 'naukri', handler: null }), 'manual', 'no handler');
  assert.equal(submissionDecision(auto, { platform: 'naukri', handler: { finalSubmit: async () => {} } }), 'manual', 'handler not verified');
  assert.equal(submissionDecision(auto, { platform: 'naukri', handler: verified }), 'auto');
  assert.equal(submissionDecision({ default: 'manual', platforms: {}, domains: {} }, { platform: 'foundit', handler: verified }), 'manual');
});

test('Indeed is never auto, even if configured', () => {
  const p = { default: 'auto', platforms: { indeed: 'auto' }, domains: { 'in.indeed.com': 'auto' } };
  assert.equal(submissionDecision(p, { platform: 'indeed', domain: 'in.indeed.com', handler: verified }), 'manual');
  assert.equal(submissionDecision(p, { platform: 'external', domain: 'smartapply.indeed.com', handler: verified }), 'manual');
});

test('one status system: pipeline statuses; engine / old names normalise; unknown rejected', () => {
  assert.deepEqual(appLog.STATUSES, ['DISCOVERED', 'SCORED', 'REJECTED', 'CV_READY', 'APPLICATION_STARTED', 'APPLIED', 'NEEDS_REVIEW', 'SECURITY_CHALLENGE', 'FAILED']);
  assert.equal(appLog.normalizeStatus('READY_FOR_REVIEW'), 'NEEDS_REVIEW');
  assert.equal(appLog.normalizeStatus('AWAITING_MANUAL_SUBMIT'), 'NEEDS_REVIEW');
  assert.equal(appLog.normalizeStatus('needs_human_input'), 'NEEDS_REVIEW');
  assert.equal(appLog.normalizeStatus('UNSUPPORTED_FORM'), 'NEEDS_REVIEW');
  assert.equal(appLog.normalizeStatus('LOGIN_REQUIRED'), 'SECURITY_CHALLENGE');
  assert.equal(appLog.normalizeStatus('BLOCKED'), 'SECURITY_CHALLENGE');
  assert.equal(appLog.normalizeStatus('ALREADY_APPLIED'), 'APPLIED', 'the site itself shows Applied');
  assert.equal(appLog.normalizeStatus('SUBMITTED'), 'APPLIED');
  assert.equal(appLog.normalizeStatus('READY_FOR_AUTO_SUBMIT'), '', 'engine-internal, never stored');
});

test('no stealth / fingerprint-spoofing code in the application engine or scrapers', () => {
  const dir = path.join(__dirname, '..');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /require\(['"](playwright-extra|puppeteer-extra[^'"]*|camoufox[^'"]*|patchright[^'"]*|humanization[^'"]*)['"]\)/, `${f} loads a stealth / anti-detect plugin`);
    assert.doesNotMatch(src, /AutomationControlled/, `${f} hides automation flags`);
    assert.doesNotMatch(src, /userAgent\s*:/, `${f} spoofs the user agent`);
    assert.doesNotMatch(src, /--proxy-server|2captcha|capmonster|solveRecaptchas|mouse_drift|humanize_(click|type)/i, `${f} uses proxy rotation, CAPTCHA solving, or humanization`);
  }
  require('../application_engine'); require('../naukri_apply'); require('../indeed_apply'); require('../foundit_apply'); require('../common'); require('../browser_modes');
  assert.equal(Object.keys(require.cache).filter(k => /puppeteer-extra|playwright-extra/.test(k)).length, 0);
});

test('agentic filler never clicks buttons (static check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agentic_form_filler.js'), 'utf8');
  assert.doesNotMatch(src, /\.click\(/, 'the form-filler must not click anything');
  assert.doesNotMatch(src, /\.submit\(|requestSubmit/, 'the form-filler must not submit forms');
});
