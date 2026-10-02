// Application engine on local fixture pages. Every fixture's Submit/Apply button reports to
// /__submitted; each test asserts nothing was ever submitted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { run } = require('../application_engine');
const naukri = require('../naukri_apply').handler;
const indeed = require('../indeed_apply').handler;
const { startServer, testProfile, tempFiles } = require('./helpers');

let srv; let files;
test.before(async () => { srv = await startServer(); files = tempFiles(); });
test.after(async () => { await srv.close(); files.cleanup(); });

const base = extra => ({
  mode: 'prefill', company: 'Acme', title: 'GenAI Engineer', profile: testProfile,
  cv: files.cv, coverLetter: files.coverLetter, outputDir: files.outputDir, llm: null, ...extra
});
const noCookies = h => ({ ...h, storageState: undefined });

test('external ATS form: filled, uploads done, validated, screenshot, NOT submitted', async () => {
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_like.html`, externalUrl: `${srv.base}/ats_basic.html`, handler: noCookies(naukri) }));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT', r.note);
  assert.equal(r.browserMode, 'EXTERNAL_ATS');
  assert.ok(r.report.fieldsFilled >= 12, `filled ${r.report.fieldsFilled}: ${r.report.filled.join(', ')}`);
  assert.equal(r.report.resumeUploaded, true);
  assert.equal(r.report.coverLetterUploaded, true);
  assert.deepEqual(r.report.needsHumanInput, []);
  assert.ok(r.report.skippedOptional.some(l => /middle name/i.test(l)), 'optional unknown field left blank');
  assert.ok(r.screenshot && fs.existsSync(r.screenshot), 'screenshot written');
  assert.equal(r.submission, 'manual');
  assert.equal(srv.hits.submitted, 0, 'nothing submitted');
});

test('unfamiliar page with a form: agentic fallback fills it (no handler)', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/ats_basic.html` }));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT', r.note);
  assert.equal(srv.hits.submitted, 0);
});

test('unknown required question -> NEEDS_HUMAN_INPUT with the question listed', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/ats_unknown.html` }));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT', r.note);
  assert.ok(r.needs_input.some(q => /why do you want/i.test(q)));
  assert.ok(r.needs_input.some(q => /referral code/i.test(q)));
  assert.equal(srv.hits.submitted, 0);
});

test('LLM stub hallucinating a mapping for a motivation question is ignored', async () => {
  const llm = async fields => fields.map(f => ({ ref: f.ref, fact_key: 'fullName' }));
  const r = await run(base({ platform: 'external', url: `${srv.base}/ats_unknown.html`, llm }));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT');
  assert.ok(r.needs_input.some(q => /referral code/i.test(q)), 'referral code not filled with a name');
  assert.equal(srv.hits.submitted, 0);
});

for (const [fixture, kind] of [['captcha.html', 'CAPTCHA'], ['cloudflare.html', 'Cloudflare'], ['access_denied.html', 'Access Denied'], ['otp.html', 'OTP']]) {
  test(`${kind} page -> SECURITY_CHALLENGE (stop, no bypass)`, async () => {
    const r = await run(base({ platform: 'external', url: `${srv.base}/${fixture}` }));
    assert.equal(r.status, 'SECURITY_CHALLENGE', r.note);
    assert.equal(r.browserMode, 'BLOCKED');
    assert.match(r.note, /Manual browser interaction is required/);
    assert.equal(srv.hits.submitted, 0);
  });
}

test('invisible reCAPTCHA helper frame is NOT a challenge; a visible Turnstile widget is', async () => {
  const a = await run(base({ platform: 'naukri', url: `${srv.base}/invisible_recaptcha.html`, handler: noCookies(naukri) }));
  assert.equal(a.status, 'AWAITING_MANUAL_SUBMIT', a.note);
  const b = await run(base({ platform: 'external', url: `${srv.base}/visible_turnstile.html` }));
  assert.equal(b.status, 'SECURITY_CHALLENGE', b.note);
  assert.equal(srv.hits.submitted, 0);
});

test('login wall -> LOGIN_REQUIRED', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/login.html` }));
  assert.equal(r.status, 'LOGIN_REQUIRED', r.note);
});

test('custom required widget -> UNSUPPORTED_FORM', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/unsupported.html` }));
  assert.equal(r.status, 'UNSUPPORTED_FORM', r.note);
  assert.equal(srv.hits.submitted, 0);
});

test('high-risk questions (criminal record, certification) -> NEEDS_HUMAN_INPUT, optional gender left blank', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/high_risk.html` }));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT', r.note);
  assert.ok(r.needs_input.some(q => /convicted/i.test(q)));
  assert.ok(r.needs_input.some(q => /certify/i.test(q)));
  assert.ok(r.report.skippedOptional.some(q => /gender/i.test(q)));
  assert.equal(srv.hits.submitted, 0);
});

test('site validation error after filling is reported, not ignored', async () => {
  const r = await run(base({ platform: 'external', url: `${srv.base}/validation.html` }));
  assert.equal(r.status, 'NEEDS_HUMAN_INPUT', r.note);
  assert.match(r.note, /validation issue/);
});

test('Naukri: one-click Apply visible -> AWAITING_MANUAL_SUBMIT, Apply never clicked', async () => {
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_like.html`, handler: noCookies(naukri) }));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT', r.note);
  assert.equal(r.submission, 'manual');
  assert.equal(srv.hits.submitted, 0);
});

test('Naukri: already applied -> ALREADY_APPLIED', async () => {
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_applied.html`, handler: noCookies(naukri) }));
  assert.equal(r.status, 'ALREADY_APPLIED');
});

test('Naukri: "Apply on company site" -> external ATS filled, not submitted', async () => {
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_external.html`, handler: noCookies(naukri) }));
  assert.equal(r.status, 'AWAITING_MANUAL_SUBMIT', r.note);
  assert.equal(r.browserMode, 'EXTERNAL_ATS');
  assert.match(r.external_apply_url, /ats_basic\.html$/);
  assert.equal(srv.hits.submitted, 0);
});

test('Indeed: Indeed Apply is not automated (no click), Cloudflare -> SECURITY_CHALLENGE', async () => {
  const a = await run(base({ platform: 'indeed', url: `${srv.base}/indeed_like.html`, handler: noCookies(indeed) }));
  assert.equal(a.status, 'AWAITING_MANUAL_SUBMIT', a.note);
  assert.match(a.note, /not automated/);
  const b = await run(base({ platform: 'indeed', url: `${srv.base}/cloudflare.html`, handler: noCookies(indeed) }));
  assert.equal(b.status, 'SECURITY_CHALLENGE');
  assert.equal(srv.hits.submitted, 0);
});

test('missing saved login -> LOGIN_REQUIRED before opening the site', async () => {
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_like.html`, handler: { ...naukri, storageState: 'C:/definitely/missing_auth.json' } }));
  assert.equal(r.status, 'LOGIN_REQUIRED');
});

test('a crashing handler returns FAILED instead of throwing (loop keeps going)', async () => {
  const handler = { platform: 'naukri', inspect: async () => { throw new Error('boom'); } };
  const r = await run(base({ platform: 'naukri', url: `${srv.base}/naukri_like.html`, handler }));
  assert.equal(r.status, 'FAILED');
  assert.match(r.error, /boom/);
});

test('invalid URL -> FAILED', async () => {
  const r = await run(base({ platform: 'external', url: 'javascript:alert(1)' }));
  assert.equal(r.status, 'FAILED');
});
