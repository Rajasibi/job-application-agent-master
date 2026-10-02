// Trusted-answer resolver: maps a form field to an answer ONLY from trusted sources
// (profile.json, config/skills.json, the tailored CV / cover letter). It never invents facts.
//
// classify(field, trusted) -> { category, value, source, reason }
//   SAFE_PROFILE_ANSWER    profile.json value (name, CTC, notice, relocation, ...)
//   SAFE_CV_FACT           skills table, tailored CV / cover letter files or text
//   YES_NO_PROFILE_ANSWER  yes/no derived from profile or skills table
//   NEEDS_HUMAN_INPUT      required, and no trusted answer exists
//   SECURITY_CHALLENGE     OTP / password / verification field
//   UNSUPPORTED_WIDGET     required custom control the agent can't operate
//   HIGH_RISK_OR_AMBIGUOUS legal attestations, criminal record, demographics, consent, ...
//   SKIP                   optional field with no trusted answer (left blank, noted)
//   UNKNOWN                not resolved deterministically (the LLM mapper may try next)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ---------- trusted facts ----------

function loadSkills(file = path.join(ROOT, 'config', 'skills.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { skills: [] }; }
}

function lakhs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 ? String(Number((n / 100000).toFixed(2))) : '';
}

// Flat list of facts the resolver and the LLM mapper may use. key -> { label, value }.
function buildTrusted({ profile = {}, skills = loadSkills(), cvPath = '', coverLetterPath = '', coverLetterText = '' } = {}) {
  const facts = {};
  const add = (key, label, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') facts[key] = { label, value: String(value) };
  };
  add('firstName', 'First name', profile.firstName);
  add('lastName', 'Last name', profile.lastName);
  add('fullName', 'Full name', profile.fullName);
  add('email', 'Email', profile.email);
  add('phone', 'Phone / mobile number', profile.phone);
  add('city', 'City', profile.city);
  add('country', 'Country', profile.country);
  add('location', 'Current location', profile.location);
  add('preferredLocation', 'Preferred job location', profile.preferredLocation);
  add('currentCompany', 'Current employer', profile.currentCompany);
  add('currentTitle', 'Current job title', profile.currentTitle);
  add('yearsExperience', 'Total years of experience', profile.yearsExperience);
  add('education', 'Highest education / degree', profile.education);
  add('university', 'University / college', profile.university);
  add('graduationYear', 'Graduation year', profile.graduationYear);
  add('currentSalary', 'Current CTC per year in INR', profile.currentSalary);
  add('currentSalaryLakhs', 'Current CTC in lakhs (LPA)', lakhs(profile.currentSalary));
  add('expectedSalary', 'Expected CTC per year in INR', profile.expectedSalary);
  add('expectedSalaryLakhs', 'Expected CTC in lakhs (LPA)', lakhs(profile.expectedSalary));
  add('noticePeriodDays', 'Notice period in days', profile.noticePeriod);
  if (String(profile.noticePeriod) === '0') {
    add('noticePeriodText', 'Notice period', 'Immediate');
    add('immediateJoiner', 'Can join immediately', 'Yes');
  }
  add('willingToRelocate', 'Willing to relocate', profile.willingToRelocate);
  add('requiresSponsorship', 'Requires visa sponsorship', profile.requiresSponsorship);
  add('authorizedToWork', 'Authorized to work in India', profile.authorizedToWork);
  add('linkedin', 'LinkedIn profile URL', profile.linkedin);
  add('portfolio', 'Portfolio / website / GitHub URL', profile.portfolio);
  for (const s of skills.skills || []) {
    add(`skill:${s.name}:years`, `Years of experience with ${s.name}`, s.years);
    add(`skill:${s.name}:rating`, `Self-rating for ${s.name} (out of ${skills.ratingScale || 10})`, s.rating ?? skills.defaultRating);
  }
  return {
    profile, skills, facts, cvPath, coverLetterPath, coverLetterText,
    // Exact question text -> answer, from profile.json "answers".
    exact: Object.fromEntries(Object.entries(profile.answers || {}).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null).map(([k, v]) => [norm(k), String(v)]))
  };
}

// ---------- profile mapping (was answerFor in common.js) ----------

function answerFor(label, profile) {
  const text = norm(label);
  if (!text) return '';
  for (const [q, a] of Object.entries(profile.answers || {})) {
    if (norm(q) === text && a !== '' && a != null) return String(a);
  }
  const map = [
    [/first\s*name|given\s*name/, profile.firstName],
    [/last\s*name|surname|family\s*name/, profile.lastName],
    [/full\s*name|legal\s*name|^name$|your name/, profile.fullName],
    [/e-?mail/, profile.email],
    [/phone|mobile|telephone|contact number/, profile.phone],
    [/linkedin/, profile.linkedin],
    [/portfolio|website|github/, profile.portfolio],
    [/preferred\s*(job\s*)?location|location\s*preference/, profile.preferredLocation || profile.location],
    [/\bcity\b/, profile.city],
    [/country/, profile.country],
    [/location|address/, profile.location],
    [/current\s*(company|employer|organi[sz]ation)/, profile.currentCompany],
    [/current\s*(job\s*)?title|designation|current role/, profile.currentTitle],
    [/years?\s*(of)?\s*(total\s*)?(work\s*)?experience|total experience/, profile.yearsExperience],
    [/notice\s*period/, profile.noticePeriod],
    [/current\s*(salary|ctc|compensation|package)/, profile.currentSalary],
    [/expected\s*(salary|ctc|compensation|package)/, profile.expectedSalary],
    [/authori[sz]ed\s*to\s*work|right\s*to\s*work|work\s*permit/, profile.authorizedToWork],
    [/sponsorship|visa/, profile.requiresSponsorship],
    [/relocat/, profile.willingToRelocate]
  ];
  for (const [re, value] of map) {
    if (re.test(text) && value !== '' && value != null) {
      // Salary fields asking in lakhs/LPA get 4.2 instead of 420000.
      if (/salary|ctc|compensation|package/.test(text) && /lakh|lac\b|lpa/.test(text) && Number(value) >= 1000) {
        return lakhs(value);
      }
      return String(value);
    }
  }
  return '';
}

// Alternative option texts to try in dropdowns / radios when the plain answer isn't listed.
function optionSynonyms(label, answer) {
  const a = norm(answer);
  if (/notice/.test(norm(label)) && /^(0|immediate(ly)?)$/.test(a)) {
    return ['immediate', 'immediately', 'immediate joiner', '0 days', '0 day', '15 days or less', 'less than 15 days', 'serving notice / immediate', '0'];
  }
  if (a === 'yes') return ['yes', 'y', 'true'];
  if (a === 'no') return ['no', 'n', 'false'];
  return [a];
}

// Picks the option matching a trusted value: exact text, synonyms, then numeric ranges
// ("2-4 years", "10 - 12 LPA", "3+ years"). Returns null if nothing matches — never a guess.
function matchOption(options, value, label = '') {
  const opts = (options || []).filter(o => o && norm(o.text) && !/^(select|choose|--|please select)/.test(norm(o.text)));
  const wants = [norm(value), ...optionSynonyms(label, value)];
  for (const w of wants) {
    const hit = opts.find(o => norm(o.text) === w) || opts.find(o => norm(o.value) === w);
    if (hit) return hit;
  }
  for (const w of wants) {
    const hit = opts.find(o => norm(o.text).startsWith(w) && w.length >= 2);
    if (hit) return hit;
  }
  const num = Number(String(value).replace(/[^0-9.]/g, ''));
  if (String(value).trim() !== '' && Number.isFinite(num)) {
    for (const o of opts) {
      const t = norm(o.text);
      let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/);
      if (m && num >= Number(m[1]) && num <= Number(m[2])) return o;
      m = t.match(/(\d+(?:\.\d+)?)\s*\+/);
      if (m && num >= Number(m[1]) && !opts.some(x => x !== o && /(\d+)\s*(?:-|to|–)\s*(\d+)/.test(norm(x.text)) && inRange(norm(x.text), num))) return o;
      m = t.match(/^(\d+(?:\.\d+)?)\b/);
      if (m && Number(m[1]) === num && !/(-|to|–|\+)/.test(t)) return o;
    }
  }
  return null;
}
function inRange(t, num) {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/);
  return !!m && num >= Number(m[1]) && num <= Number(m[2]);
}

// ---------- classification ----------

const HIGH_RISK = /convict|criminal|felony|arrest|offen[cs]e|disabilit|handicap|gender|sex\b|ethnic|race\b|religio|caste|veteran|marital|pregnan|date of birth|\bdob\b|\bage\b|aadhaar|aadhar|\bpan\s*(card|number|no\b)|passport number|social security|\bssn\b|signature|sign here|i certify|i declare|i confirm that|i hereby|i agree|terms and conditions|privacy policy|consent|background (check|verification)|drug test|bank account|salary slip|payslip/i;
const SECURITY = /\botp\b|one[- ]time|verification code|captcha|password|security question|pin code sent/i;

function findSkill(label, skills) {
  const text = ` ${norm(label).replace(/[^a-z0-9+#./ ]/g, ' ')} `;
  let best = null;
  for (const s of skills.skills || []) {
    for (const name of [s.name, ...(s.aliases || [])]) {
      const n = norm(name).replace(/[^a-z0-9+#./ ]/g, ' ').trim();
      if (!n) continue;
      if (text.includes(` ${n} `) && (!best || n.length > best.len)) best = { skill: s, len: n.length };
    }
  }
  return best ? best.skill : null;
}

const YES_NO = o => (o || []).length && (o || []).every(x => /^(yes|no|y|n|true|false)$/i.test(norm(x.text)));

function classify(field, trusted) {
  const label = norm(field.label);
  const { profile, skills } = trusted;
  const unknown = (reason) => ({ category: 'UNKNOWN', value: '', source: '', reason });
  const humanOrSkip = (reason) => field.required
    ? { category: 'NEEDS_HUMAN_INPUT', value: '', source: '', reason }
    : { category: 'SKIP', value: '', source: '', reason };

  if (['combobox', 'contenteditable', 'slider'].includes(field.kind)) {
    return field.required
      ? { category: 'UNSUPPORTED_WIDGET', value: '', source: '', reason: `custom ${field.kind} control` }
      : { category: 'SKIP', value: '', source: '', reason: `optional custom ${field.kind}` };
  }

  if (field.kind === 'file') {
    const isCover = /cover|motivation/.test(label);
    const file = isCover ? trusted.coverLetterPath : trusted.cvPath;
    if (file && fs.existsSync(file)) return { category: 'SAFE_CV_FACT', value: file, source: isCover ? 'tailored cover letter' : 'tailored CV' };
    return humanOrSkip(isCover ? 'no cover letter file for this job' : 'no CV file');
  }

  if (SECURITY.test(label)) return { category: 'SECURITY_CHALLENGE', value: '', source: '', reason: 'verification / password field' };
  if (HIGH_RISK.test(label)) {
    return field.required
      ? { category: 'HIGH_RISK_OR_AMBIGUOUS', value: '', source: '', reason: 'legal / personal / consent question' }
      : { category: 'SKIP', value: '', source: '', reason: 'optional sensitive question left blank' };
  }

  if (trusted.exact[label] !== undefined) return { category: 'SAFE_PROFILE_ANSWER', value: trusted.exact[label], source: 'profile.answers' };

  // Cover letter text box -> the tailored cover letter.
  if (/cover\s*letter/.test(label) && ['textarea', 'text'].includes(field.kind)) {
    if (trusted.coverLetterText) return { category: 'SAFE_CV_FACT', value: trusted.coverLetterText, source: 'tailored cover letter' };
    return humanOrSkip('no cover letter written for this job');
  }

  // Immediate joining.
  if (/join (immediately|immediate)|immediate joiner|start immediately|available to join immediately/.test(label)) {
    const f = trusted.facts.immediateJoiner;
    if (f) return { category: 'YES_NO_PROFILE_ANSWER', value: f.value, source: 'profile.noticePeriod = 0' };
  }

  // Skills: years / rating / yes-no experience.
  const skill = findSkill(label, skills);
  if (skill) {
    if (/rate|rating|proficien|scale|out of|level of expertise|how (good|strong)/.test(label)) {
      let r = skill.rating ?? skills.defaultRating;
      const nums = (field.options || []).map(o => Number(String(o.text).replace(/[^0-9.]/g, ''))).filter(x => Number.isFinite(x) && x > 0);
      const scale5 = /out of 5|1\s*(-|to)\s*5|scale of 5/.test(label) || (nums.length > 0 && Math.max(...nums) <= 5);
      if (scale5) r = Math.round(r / 2); // 9/10 -> 5/5 (rounded), 8/10 -> 4/5
      return { category: 'SAFE_CV_FACT', value: String(r), source: `skills.json ${skill.name} rating` };
    }
    if (/year|yrs|how long|experience/.test(label) && !YES_NO(field.options) && !/^(do|does|have|are|is|can)\b/.test(label)) {
      return { category: 'SAFE_CV_FACT', value: String(skill.years), source: `skills.json ${skill.name} years` };
    }
    if (/^(do|have|are|can|is)\b|experience (with|in)|worked (with|on)|knowledge of|familiar/.test(label)) {
      return { category: 'YES_NO_PROFILE_ANSWER', value: 'Yes', source: `skills.json lists ${skill.name}` };
    }
  }

  // A specific skill that isn't in the table -> never guess (and never substitute total experience).
  const skillSpecific = /(experience|exp)\s+(in|with|on|using|of working with)\s+\S|rate your|rating (for|of)|proficiency (in|with)/.test(label);
  if (!skill && skillSpecific && !/\b(total|overall)\b/.test(label)) {
    return humanOrSkip('skill not in skills.json');
  }

  const v = answerFor(field.label, profile);
  if (v) {
    const yesNo = /^(yes|no)$/i.test(v);
    return { category: yesNo ? 'YES_NO_PROFILE_ANSWER' : 'SAFE_PROFILE_ANSWER', value: v, source: 'profile.json' };
  }
  return unknown('no deterministic mapping');
}

// Final fallback after the LLM mapper: unresolved required fields need a human.
function finalizeUnknown(field) {
  return field.required
    ? { category: 'NEEDS_HUMAN_INPUT', value: '', source: '', reason: 'no trusted answer' }
    : { category: 'SKIP', value: '', source: '', reason: 'optional, no trusted answer' };
}

module.exports = { buildTrusted, loadSkills, answerFor, optionSynonyms, matchOption, classify, finalizeUnknown, findSkill, lakhs };
