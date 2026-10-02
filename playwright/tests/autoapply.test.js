// Auto-apply (policy auto + score >= autoMinScore): exactly one verified click in the visible window,
// never on Indeed or company-site forms, never guessed answers; human-in-the-loop pause/resume;
// persistent browser profiles. Local fixtures only. Every Apply click is counted via /__submitted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoapply-test-'));
process.env.JOB_AGENT_HEADLESS = '1';                                  // the visible code path, no window
process.env.JOB_AGENT_PROFILE_DIR = path.join(tmp, 'profiles');         // never the real profiles
process.env.JOB_AGENT_HITL_FILE = path.join(tmp, 'hitl.json');
process.env.JOB_AGENT_HUMAN_WAIT_MS = '400';

const { run, autoApplyAllowed, submissionDecision } = require('../application_engine');
const { launch, MODES, waitingStatus } = require('../browser_modes');
const naukri = require('../naukri_apply').handler;
const indeed = require('../indeed_apply').handler;
const { startServer, testProfile, tempFiles } = require('./helpers');

let srv; let files;
test.before(async () => { srv = await startServer(); files = tempFiles(); });
test.after(async () => { await srv.close(); files.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

const AUTO = { default: 'manual', autoMinScore: 80, platforms: { naukri: 'auto', foundit: 'auto', indeed: 'auto' }, domains: {} };
const noCookies = h => ({ ...h, storageState: undefined });
const auto = extra => ({
  mode: 'auto', platform: 'naukri', company: 'Acme', title: 'AI Engineer', profile: testProfile, score: 85, policy: AUTO,
  cv: files.cv, coverLetter: files.coverLetter, outputDir: files.outputDir, llm: null, handler: noCookies(naukri), ...extra
});
const clicks = async fn => { const before = srv.hits.submitted; const r = await fn(); return { r, n: srv.hits.submitted - before }; };

test('policy: auto needs allowlist + verified handler + score >= autoMinScore; Indeed never', () => {
  assert.equal(autoApplyAllowed(AUTO, { platform: 'naukri', handler: naukri, score: 85 }), true);
  assert.equal(autoApplyAllowed(AUTO, { platform: 'naukri', handler: naukri, score: 79 }), false, 'below 80 waits for review');
  assert.equal(autoApplyAllowed(AUTO, { platform: 'naukri', handler: { ...naukri, finalSubmitVerified: false }, score: 95 }), false, 'unverified handler');
  assert.equal(autoApplyAllowed({ ...AUTO, platforms: { naukri: 'manual' } }, { platform: 'naukri', handler: naukri, score: 95 }), false, 'policy manual');
  assert.equal(autoApplyAllowed(AUTO, { platform: 'indeed', handler: { finalSubmit: async () => {}, finalSubmitVerified: true }, score: 99 }), false, 'Indeed never');
  assert.equal(submissionDecision(AUTO, { platform: 'indeed', domain: 'in.indeed.com', handler: indeed }), 'manual');
});

test('score 85, one-click Apply confirms -> APPLIED with exactly one click', async () => {
  const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/naukri_auto.html` })));
  assert.equal(r.status, 'APPLIED', JSON.stringify(r));
  assert.equal(r.submission, 'auto');
  assert.equal(n, 1, 'Apply clicked exactly once');
  assert.match(r.note, /Applied automatically/);
});

test('score 75 -> not clicked, waits for review', async () => {
  const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/naukri_auto.html`, score: 75 })));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT');
  assert.equal(n, 0);
});

test('prefill mode never clicks, even with an auto policy and a high score', async () => {
  const { r, n } = await clicks(() => run(auto({ mode: 'prefill', url: `${srv.base}/naukri_auto.html`, score: 99 })));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT');
  assert.equal(n, 0);
});

test('no confirmation -> NEEDS_HUMAN_INPUT, never a second click', async () => {
  const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/naukri_noconfirm.html` })));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT');
  assert.match(r.note, /no confirmation/);
  assert.equal(n, 1, 'clicked once, not retried');
});

test('recruiter questions with trusted answers (notice, Python years, relocation) are answered -> APPLIED', async () => {
  const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/naukri_questions.html` })));
  assert.equal(r.status, 'APPLIED', JSON.stringify(r));
  assert.match(r.note, /Answered 3 recruiter question/);
  assert.equal(n, 1);
});

test('a recruiter question without a trusted answer stops -> NEEDS_HUMAN_INPUT, nothing guessed', async () => {
  const { r } = await clicks(() => run(auto({ url: `${srv.base}/naukri_questions.html?unknown=1` })));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT');
  assert.ok(r.needs_input.some(q => /why do you want to join/i.test(q)), JSON.stringify(r.needs_input));
});

test('"Apply on company site" in auto mode -> company form filled, its Submit never clicked', async () => {
  const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/naukri_external.html` })));
  assert.notEqual(r.status, 'APPLIED');
  assert.equal(n, 0);
});

test('Indeed with policy "auto" -> Indeed Apply never clicked', async () => {
  const { r, n } = await clicks(() => run(auto({ platform: 'indeed', url: `${srv.base}/indeed_like.html`, handler: noCookies(indeed), score: 99 })));
  assert.notEqual(r.status, 'APPLIED');
  assert.equal(n, 0);
});

test('CAPTCHA / Access Denied in auto mode -> SECURITY_CHALLENGE (after the short human wait), no click', async () => {
  for (const page of ['captcha.html', 'access_denied.html']) {
    const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/${page}` })));
    assert.equal(r.status, 'SECURITY_CHALLENGE', page);
    assert.equal(n, 0, page);
  }
  assert.equal(waitingStatus(), null, 'the "waiting for you" signal is cleared afterwards');
});

test('human-in-the-loop: a check that YOU clear in the window -> the run resumes and applies', async () => {
  process.env.JOB_AGENT_HUMAN_WAIT_MS = '10000';
  process.env.JOB_AGENT_FORCE_ATTENDED = '1'; // simulate you at the laptop
  try {
    const { r, n } = await clicks(() => run(auto({ url: `${srv.base}/challenge_clears.html` })));
    assert.equal(r.status, 'APPLIED', JSON.stringify(r));
    assert.equal(n, 1);
  } finally { process.env.JOB_AGENT_HUMAN_WAIT_MS = '400'; delete process.env.JOB_AGENT_FORCE_ATTENDED; }
});

test('persistent profile: storage survives a relaunch; the saved login is imported once', async () => {
  const state = path.join(tmp, 'site_auth.json');
  fs.writeFileSync(state, JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
  let { browser, context } = await launch(MODES.VISIBLE_REVIEW, { profile: 'testsite', storageState: state });
  assert.equal(browser.persistent, true);
  let page = await context.newPage();
  await page.goto(`${srv.base}/naukri_auto.html`);
  await page.evaluate(() => localStorage.setItem('kept', 'yes'));
  assert.ok((await context.cookies()).some(c => c.name === 'session'), 'saved login imported');
  await browser.close();
  ({ browser, context } = await launch(MODES.VISIBLE_REVIEW, { profile: 'testsite', storageState: state }));
  page = await context.newPage();
  await page.goto(`${srv.base}/naukri_auto.html`);
  assert.equal(await page.evaluate(() => localStorage.getItem('kept')), 'yes', 'profile storage persisted');
  await browser.close();
});
