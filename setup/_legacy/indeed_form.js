const fs = require('fs');
const path = require('path');

const PROFILE_FIELDS = [
  [/first name|given name/, 'firstName'],
  [/last name|surname|family name/, 'lastName'],
  [/full name|legal name/, 'fullName'],
  [/e-?mail/, 'email'],
  [/phone|mobile|telephone/, 'phone'],
  [/city|location|address/, 'location']
];
const ALLOWED_RESUME_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf']);

function normalizeLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function getExplicitValue(label, profile) {
  const normalized = normalizeLabel(label);
  for (const [pattern, key] of PROFILE_FIELDS) {
    if (pattern.test(normalized) && profile[key]) return String(profile[key]);
  }
  for (const [question, answer] of Object.entries(profile.answers || {})) {
    if (normalizeLabel(question) === normalized && answer !== '' && answer != null) {
      return String(answer);
    }
  }
  return '';
}

async function getFieldLabel(field) {
  return field.evaluate(element => {
    const labels = element.labels ? Array.from(element.labels).map(label => label.innerText) : [];
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.innerText || '');
    return [
      ...labels,
      ...labelledBy,
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.id
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  });
}

async function fillIndeedForm(page, profile, projectRoot) {
  const fields = [];
  const unanswered = [];
  const controls = page.locator('input, textarea, select');

  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;

    const type = await control.getAttribute('type') || 'text';
    if (['hidden', 'submit', 'button', 'file', 'radio', 'checkbox', 'password'].includes(type.toLowerCase())) continue;

    const label = await getFieldLabel(control);
    const value = getExplicitValue(label, profile);
    if (!value) {
      if (/experience|authorization|sponsor|salary|relocat|availability|notice period/i.test(label)) {
        unanswered.push(label);
      }
      continue;
    }

    if (await control.evaluate(element => element.tagName === 'SELECT')) {
      const matchedOption = await control.locator('option').evaluateAll((options, expected) => {
        const match = options.find(option => option.textContent.trim().toLocaleLowerCase() === expected.toLocaleLowerCase());
        return match ? match.value : null;
      }, value);
      if (matchedOption == null) continue;
      await control.selectOption(matchedOption);
    } else {
      await control.fill(value);
    }
    fields.push(label);
  }

  let resumeUploaded = false;
  const resumePath = String(profile.resumePath || '').trim();
  if (resumePath) {
    const resolvedResumePath = path.isAbsolute(resumePath)
      ? resumePath
      : path.resolve(projectRoot, resumePath);
    const extension = path.extname(resolvedResumePath).toLowerCase();
    if (!ALLOWED_RESUME_EXTENSIONS.has(extension)) {
      throw new Error('Resume must be PDF, DOC, DOCX, or RTF.');
    }
    if (!fs.existsSync(resolvedResumePath)) {
      throw new Error(`Configured resume file does not exist: ${resolvedResumePath}`);
    }
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(resolvedResumePath);
      resumeUploaded = true;
    }
  }

  return { fields, unanswered, resumeUploaded };
}

module.exports = { fillIndeedForm, getExplicitValue, normalizeLabel };
