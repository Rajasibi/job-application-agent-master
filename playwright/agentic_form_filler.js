// Local agentic form-filler (Playwright + local Qwen via Ollama).
//
//   1. extractFields  -> compact field list (form_schema.js)
//   2. classify       -> deterministic trusted answers (answer_resolver.js)
//   3. llmMapper      -> ONE small batched Qwen call for still-unknown fields. Qwen may only pick a
//                        fact KEY from the trusted list (or "none"); the code re-validates the pick.
//                        It never writes free-text answers.
//   4. fill + verify  -> set values, read them back, check uploads
//   5. validate       -> required-empty / aria-invalid / error text; screenshot
//
// It never clicks buttons (no Next, Continue, Apply or Submit). Opening a form from a job page is
// the engine's job, not the filler's.

const { extractFields, validationErrors } = require('./form_schema');
const { classify, finalizeUnknown, matchOption } = require('./answer_resolver');

const { createLlm } = require('../helper-service/llm_backend');

// LLM requests go through the helper's /llm/api/chat (configured backend: local or cloud). When the
// helper isn't running (standalone runs, tests) the same backend module is used in-process.
const HELPER_LLM_URL = () => `${(process.env.HELPER_URL || 'http://127.0.0.1:9999').replace(/\/$/, '')}/llm/api/chat`;
const MAX_LLM_FIELDS = 8;
let inProcessLlm = null;

// Keeps the prompt small (CPU prompt processing is the slow part): all profile facts, but skill
// facts only for skills actually named in the questions.
function relevantFacts(fields, facts) {
  const text = fields.map(f => f.label).join(' ').toLowerCase();
  return Object.fromEntries(Object.entries(facts).filter(([k]) => {
    if (!k.startsWith('skill:')) return true;
    const name = k.split(':')[1].toLowerCase();
    return text.includes(name);
  }));
}

// The mapping request: fact KEYS and labels plus the questions; no fact values are sent.
function buildMapperRequest(fields, allFacts) {
  const facts = relevantFacts(fields, allFacts);
  const factList = Object.entries(facts).map(([k, f]) => `${k}: ${f.label}`).join('\n');
  const fieldList = fields.map(f => ({ ref: f.ref, question: f.label.slice(0, 160), type: f.kind, options: (f.options || []).slice(0, 12).map(o => o.text) }));
  return {
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
    stream: false,
    format: 'json',
    keep_alive: '2h',
    options: { temperature: 0, num_predict: 250, num_ctx: 6144 }, // same num_ctx as the helper: no model reloads
    messages: [
      {
        role: 'system',
        content: 'You map job-application form questions to known facts about the candidate. For each question, pick the ONE fact key whose meaning clearly answers it, or "none" if no fact clearly answers it. Never invent facts. Never answer questions about opinions, motivation, legal status, demographics or consent: use "none". Reply only with JSON: {"mappings":[{"ref":"...","fact_key":"..."}]}'
      },
      { role: 'user', content: `FACT KEYS:\n${factList}\n\nQUESTIONS:\n${JSON.stringify(fieldList)}` }
    ]
  };
}

async function chatViaBackend(body) {
  let res;
  try {
    res = await fetch(HELPER_LLM_URL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25 * 60 * 1000) });
  } catch (e) {
    if (e.cause?.code !== 'ECONNREFUSED') throw e;
    inProcessLlm = inProcessLlm || createLlm();
    return inProcessLlm.chat(body);
  }
  if (res.status === 404) { // an older helper without the proxy
    inProcessLlm = inProcessLlm || createLlm();
    return inProcessLlm.chat(body);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM ${j.error?.kind || `HTTP ${res.status}`}: ${j.error?.message || ''}`.trim());
  return j;
}

// Default mapper. Returns [{ ref, fact_key }] — only keys, never values.
async function qwenMapper(fields, allFacts) {
  const j = await chatViaBackend(buildMapperRequest(fields, allFacts));
  const parsed = JSON.parse(String(j.message?.content || '{}').replace(/```(?:json)?/g, ''));
  return Array.isArray(parsed.mappings) ? parsed.mappings : [];
}

// Words that must appear in a question before the LLM may map it to a fact. A pick that shares
// no strong keyword with the fact is rejected (guards against the model "helpfully" guessing).
const FACT_WORDS = {
  firstName: ['first', 'given', 'forename'], lastName: ['last', 'surname', 'family'], fullName: ['name', 'full'],
  email: ['email', 'mail'], phone: ['phone', 'mobile', 'contact', 'cell', 'telephone', 'whatsapp'],
  city: ['city', 'town'], country: ['country', 'nationality'], location: ['location', 'based', 'reside', 'residence', 'address'],
  preferredLocation: ['preferred', 'preference', 'location'], currentCompany: ['company', 'employer', 'organization', 'organisation', 'firm'],
  currentTitle: ['title', 'designation', 'role', 'position'], yearsExperience: ['experience', 'exp'],
  education: ['education', 'degree', 'qualification'], university: ['university', 'college', 'institute', 'institution', 'school'],
  graduationYear: ['graduation', 'graduated', 'passing', 'passout', 'pass'],
  currentSalary: ['current', 'present', 'salary', 'ctc', 'compensation', 'package', 'drawn', 'pay'],
  currentSalaryLakhs: ['current', 'present', 'salary', 'ctc', 'compensation', 'package', 'drawn', 'lpa', 'lakh', 'lakhs'],
  expectedSalary: ['expected', 'expectation', 'desired', 'anticipated', 'salary', 'ctc', 'compensation', 'package', 'pay'],
  expectedSalaryLakhs: ['expected', 'expectation', 'desired', 'anticipated', 'salary', 'ctc', 'compensation', 'package', 'lpa', 'lakh', 'lakhs'],
  noticePeriodDays: ['notice', 'joining', 'join', 'availability', 'available', 'soon', 'start', 'onboard', 'board'],
  noticePeriodText: ['notice', 'joining', 'join', 'availability', 'available', 'soon', 'start', 'onboard', 'board'],
  immediateJoiner: ['immediate', 'immediately', 'join', 'joining'], willingToRelocate: ['relocate', 'relocation', 'relocating', 'move', 'shift'],
  requiresSponsorship: ['sponsor', 'sponsorship', 'visa'], authorizedToWork: ['authorized', 'authorised', 'eligible', 'permit', 'legally', 'authorization'],
  linkedin: ['linkedin'], portfolio: ['portfolio', 'website', 'github', 'url']
};
const WEAK = new Set(['current', 'years', 'year', 'number', 'total', 'your', 'the']);
const words = s => new Set(String(s || '').toLowerCase().match(/[a-z]{2,}/g) || []);

function keywordsFor(factKey, fact) {
  if (factKey.startsWith('skill:')) {
    const name = factKey.split(':')[1];
    return new Set([...words(name), ...words(fact.label)].filter(w => !WEAK.has(w) && !['experience', 'with', 'for', 'self', 'rating', 'out'].includes(w)));
  }
  return new Set((FACT_WORDS[factKey] || [...words(fact.label)]).filter(w => !WEAK.has(w)));
}

// Validates an LLM pick: the key must exist, the question must share a strong keyword with the
// fact, and for choice fields the fact must match one of the options.
function acceptMapping(field, factKey, trusted) {
  const fact = trusted.facts[factKey];
  if (!factKey || factKey === 'none' || !fact) return null;
  const q = words(field.label);
  if (![...keywordsFor(factKey, fact)].some(w => q.has(w))) return null;
  if (['select', 'radio'].includes(field.kind) && !matchOption(field.options, fact.value, field.label)) return null;
  if (field.kind === 'number' && !Number.isFinite(Number(fact.value))) return null;
  return { category: 'SAFE_PROFILE_ANSWER', value: fact.value, source: `qwen-mapped:${factKey}` };
}

async function fillOne(page, field, value) {
  const loc = page.locator(`[data-agent-ref="${field.ref}"]`);
  switch (field.kind) {
    case 'file':
      await loc.setInputFiles(value);
      return (await loc.evaluate(el => el.files.length)) > 0;
    case 'select': {
      const opt = matchOption(field.options, value, field.label);
      if (!opt) return false;
      await loc.selectOption(opt.value);
      return (await loc.inputValue()) === opt.value;
    }
    case 'radio': {
      const opt = matchOption(field.options, value, field.label);
      if (!opt || !opt.ref) return false;
      const r = page.locator(`[data-agent-ref="${opt.ref}"]`);
      await r.check({ force: true });
      return r.isChecked();
    }
    case 'checkbox': {
      if (!/^(yes|true|checked)$/i.test(String(value))) return true; // only ever tick on an explicit trusted "yes"
      await loc.check({ force: true });
      return loc.isChecked();
    }
    default:
      await loc.fill(String(value));
      return (await loc.inputValue()) === String(value);
  }
}

// ctx: { trusted, screenshotPath? }  opts: { llm: mapper | null }
async function fillForm(page, scope, ctx, { llm = qwenMapper } = {}) {
  const fields = await extractFields(scope);
  const report = {
    fieldsFound: fields.length,
    fieldsFilled: 0,
    filled: [],
    values: {},   // label -> value that was filled (file uploads: file name only)
    sources: {},  // label -> where the answer came from (profile.json, skills.json, qwen-mapped:<key>)
    needsHumanInput: [],
    highRisk: [],
    unsupported: [],
    securityFields: [],
    skippedOptional: [],
    prefilled: [],
    verifyFailed: [],
    validationErrors: [],
    resumeUploaded: false,
    coverLetterUploaded: false,
    llmUsed: false,
    llmError: null
  };

  const decisions = [];
  const unknown = [];
  for (const f of fields) {
    if (f.kind !== 'file' && f.kind !== 'checkbox' && f.value && !['combobox', 'contenteditable', 'slider'].includes(f.kind)) {
      report.prefilled.push(f.label); // the site already filled it (e.g. from your account)
      continue;
    }
    const c = classify(f, ctx.trusted);
    if (c.category === 'UNKNOWN') unknown.push(f); else decisions.push({ f, c });
  }

  if (unknown.length && llm) {
    // Free-text boxes (motivation, "tell us about yourself") are never sent to the model.
    const batch = unknown.filter(f => f.kind !== 'textarea').slice(0, MAX_LLM_FIELDS);
    report.llmUsed = batch.length > 0;
    let mappings = [];
    if (batch.length) {
      try { mappings = await llm(batch, ctx.trusted.facts); } catch (e) { report.llmError = e.message; }
    }
    for (const f of unknown) {
      const m = batch.includes(f) ? mappings.find(x => x && x.ref === f.ref) : null;
      decisions.push({ f, c: (m && acceptMapping(f, m.fact_key, ctx.trusted)) || finalizeUnknown(f) });
    }
  } else {
    for (const f of unknown) decisions.push({ f, c: finalizeUnknown(f) });
  }

  for (const { f, c } of decisions) {
    const label = f.label || f.ref;
    switch (c.category) {
      case 'NEEDS_HUMAN_INPUT': report.needsHumanInput.push(label); break;
      case 'HIGH_RISK_OR_AMBIGUOUS': report.highRisk.push(label); break;
      case 'UNSUPPORTED_WIDGET': report.unsupported.push(label); break;
      case 'SECURITY_CHALLENGE': report.securityFields.push(label); break;
      case 'SKIP': report.skippedOptional.push(label); break;
      default: {
        let ok = false;
        try { ok = await fillOne(page, f, c.value); } catch (_) { ok = false; }
        if (ok) {
          report.fieldsFilled++;
          report.filled.push(label);
          report.values[label] = f.kind === 'file' ? require('path').basename(c.value) : String(c.value).slice(0, 80);
          report.sources[label] = c.source;
          if (f.kind === 'file') {
            if (/cover/i.test(c.source)) report.coverLetterUploaded = true; else report.resumeUploaded = true;
          }
        } else if (f.required) {
          report.needsHumanInput.push(label);
          report.verifyFailed.push(label);
        } else {
          report.skippedOptional.push(label);
        }
      }
    }
  }

  report.validationErrors = await validationErrors(scope).catch(() => []);
  if (ctx.screenshotPath) await page.screenshot({ path: ctx.screenshotPath, fullPage: true }).catch(() => {});
  return report;
}

// Report -> stored status + a human-readable note.
function statusFromReport(r) {
  if (r.securityFields.length) return { status: 'SECURITY_CHALLENGE', note: `Stopped: the form asks for ${r.securityFields.slice(0, 2).join(', ')}. Manual browser interaction is required.` };
  if (r.fieldsFound === 0) return { status: 'UNSUPPORTED_FORM', note: 'No application form found on the page.' };
  if (r.unsupported.length) return { status: 'UNSUPPORTED_FORM', note: `Agent filled ${r.fieldsFilled} fields; unsupported required control(s): ${r.unsupported.slice(0, 3).join(' | ')}.` };
  const needs = [...r.highRisk, ...r.needsHumanInput];
  if (needs.length) {
    return { status: 'NEEDS_HUMAN_INPUT', note: `Agent filled ${r.fieldsFilled} fields; ${needs.length} question(s) require your answer: ${needs.slice(0, 4).join(' | ')}.` };
  }
  const realErrors = r.validationErrors.filter(e => !r.skippedOptional.includes(e));
  if (realErrors.length) return { status: 'NEEDS_HUMAN_INPUT', note: `Agent filled ${r.fieldsFilled} fields but the form shows ${realErrors.length} validation issue(s): ${realErrors.slice(0, 3).join(' | ')}.` };
  const extras = [r.resumeUploaded && 'CV uploaded', r.coverLetterUploaded && 'cover letter uploaded'].filter(Boolean).join(', ');
  return { status: 'AWAITING_MANUAL_SUBMIT', note: `Agent filled ${r.fieldsFilled} fields${extras ? ` (${extras})` : ''}; final submission requires your approval.` };
}

module.exports = { fillForm, statusFromReport, qwenMapper, acceptMapping, buildMapperRequest };
