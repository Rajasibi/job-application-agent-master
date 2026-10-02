// Trusted-answer mapping: profile answers, skills table, and "never guess" behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrusted, classify, matchOption, answerFor } = require('../answer_resolver');
const { acceptMapping } = require('../agentic_form_filler');
const { testProfile } = require('./helpers');

const trusted = buildTrusted({ profile: testProfile });
const field = (label, extra = {}) => ({ ref: 'f1', kind: 'text', label, required: true, options: [], value: '', ...extra });
const opts = (...texts) => texts.map(t => ({ value: t, text: t }));

test('profile answers: CTC, expected CTC, lakhs, notice, relocation, sponsorship, location', () => {
  assert.equal(classify(field('Current CTC'), trusted).value, '420000');
  assert.equal(classify(field('Expected CTC'), trusted).value, '1100000');
  assert.equal(classify(field('Current CTC (in Lakhs)'), trusted).value, '4.2');
  assert.equal(classify(field('Expected CTC (in Lakhs)'), trusted).value, '11');
  assert.equal(classify(field('Notice period (days)'), trusted).value, '0');
  assert.equal(classify(field('What is your notice period?'), trusted).value, 'Immediate');
  assert.equal(classify(field('Are you willing to relocate?', { kind: 'radio', options: opts('Yes', 'No') }), trusted).value, 'No');
  assert.equal(classify(field('Do you require visa sponsorship?', { kind: 'radio', options: opts('Yes', 'No') }), trusted).value, 'No');
  assert.equal(classify(field('Preferred location'), trusted).value, 'Chennai / Tamil Nadu / Remote');
  assert.equal(classify(field('Can you join immediately?'), trusted).value, 'Yes');
});

test('notice-period dropdown picks "Immediate" for 0 days', () => {
  const o = matchOption(opts('Select', 'Immediate', '15 Days', '30 Days'), '0', 'Notice period');
  assert.equal(o.text, 'Immediate');
});

test('numeric ranges: 3 years -> "2-4 years", 11 LPA -> "10 - 12 LPA"', () => {
  assert.equal(matchOption(opts('0-1 years', '2-4 years', '5+ years'), '3', 'Experience').text, '2-4 years');
  assert.equal(matchOption(opts('8 - 10 LPA', '10 - 12 LPA', '12+ LPA'), '11', 'Expected CTC').text, '10 - 12 LPA');
  assert.equal(matchOption(opts('Red', 'Blue'), '3', 'x'), null, 'no match must return null, never a guess');
});

test('skills table: every skill 3 years; ratings 9 core / 8 others', () => {
  assert.equal(classify(field('Years of experience in Python', { kind: 'number' }), trusted).value, '3');
  assert.equal(classify(field('How many years of experience do you have with LangChain?'), trusted).value, '3');
  assert.equal(classify(field('Rate your Python skill out of 10'), trusted).value, '9');
  assert.equal(classify(field('Rate your Docker proficiency (1-10)'), trusted).value, '8');
  assert.equal(classify(field('Rate your RAG skill (1-5)'), trusted).value, '5', '9/10 on a 5-point scale');
  assert.equal(classify(field('Do you have experience with FastAPI?', { kind: 'radio', options: opts('Yes', 'No') }), trusted).value, 'Yes');
});

test('unknown questions -> NEEDS_HUMAN_INPUT (required) or SKIP (optional); never invented', () => {
  assert.equal(classify(field('Years of experience in Kubernetes'), trusted).category, 'NEEDS_HUMAN_INPUT');
  assert.equal(classify(field('Do you have experience with Rust?', { kind: 'radio', options: opts('Yes', 'No') }), trusted).category, 'NEEDS_HUMAN_INPUT', 'skill not in the table: never answered, not even by the LLM');
  assert.equal(classify(field('Total years of experience'), trusted).value, '3', 'total experience still comes from the profile');
  assert.equal(classify(field('Middle name', { required: false }), trusted).category, 'UNKNOWN');
});

test('high-risk and security questions always stop', () => {
  assert.equal(classify(field('Have you ever been convicted of a criminal offence?'), trusted).category, 'HIGH_RISK_OR_AMBIGUOUS');
  assert.equal(classify(field('I certify that the information provided is true', { kind: 'checkbox' }), trusted).category, 'HIGH_RISK_OR_AMBIGUOUS');
  assert.equal(classify(field('Gender', { required: false }), trusted).category, 'SKIP');
  assert.equal(classify(field('Enter OTP'), trusted).category, 'SECURITY_CHALLENGE');
  assert.equal(classify(field('Are you open to Pan India locations?', { required: false }), trusted).category !== 'HIGH_RISK_OR_AMBIGUOUS', true);
});

test('custom required widget -> UNSUPPORTED_WIDGET', () => {
  assert.equal(classify(field('Select your primary skill', { kind: 'combobox' }), trusted).category, 'UNSUPPORTED_WIDGET');
});

test('Qwen guard: a hallucinated or semantically unrelated mapping is rejected', () => {
  assert.equal(acceptMapping(field('Anticipated compensation (LPA)'), 'expectedSalaryLakhs', trusted).value, '11');
  assert.equal(acceptMapping(field('Why do you want to work here?'), 'fullName', trusted), null, 'no shared keyword');
  assert.equal(acceptMapping(field('Anything'), 'madeUpKey', trusted), null, 'key must exist');
  assert.equal(acceptMapping(field('Preferred shift', { kind: 'select', options: opts('Day', 'Night') }), 'preferredLocation', trusted), null, 'option must match');
});

test('answerFor stays compatible (re-exported from common.js)', () => {
  const common = require('../common');
  assert.equal(common.answerFor('Expected CTC (in Lakhs)', testProfile), answerFor('Expected CTC (in Lakhs)', testProfile));
});
