// Reads a form into a compact, LLM-friendly field list — never the whole page.
// Each field gets a data-agent-ref attribute so it can be located again for filling.
//
// Field: { ref, kind, label, required, options: [{ value, text, ref? }], value, hasFile }
// kinds: text, email, tel, number, textarea, select, radio, checkbox, file, date,
//        combobox, contenteditable, slider (the last three are custom widgets)

async function extractFields(scope) {
  return scope.evaluate(root => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const visible = el => {
      if (el.type === 'file') return true; // file inputs are often visually hidden behind a button
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    let n = root.querySelectorAll('[data-agent-ref]').length;
    const ref = el => {
      if (!el.dataset.agentRef) el.dataset.agentRef = `f${++n}`;
      return el.dataset.agentRef;
    };
    const labelOf = el => {
      const parts = [];
      if (el.labels) for (const l of el.labels) parts.push(l.innerText);
      for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        parts.push(document.getElementById(id)?.innerText || '');
      }
      parts.push(el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'));
      const fs = el.closest('fieldset');
      if (fs) parts.push(fs.querySelector('legend')?.innerText);
      let label = clean(parts.filter(Boolean).join(' '));
      if (!label) {
        // Nearby text: the closest container's own text, without the control's options.
        const box = el.closest('label, .form-group, .field, .question, li, div');
        if (box) {
          const copy = box.cloneNode(true);
          copy.querySelectorAll('select, option, input, textarea, button, script, style').forEach(x => x.remove());
          label = clean(copy.innerText).slice(0, 160);
        }
      }
      return label || clean(el.getAttribute('name') || el.id);
    };
    const isRequired = (el, label) =>
      !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)|\*\s/.test(label));

    const fields = [];
    const radioGroups = new Map();

    for (const el of root.querySelectorAll('input, textarea, select')) {
      const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
      if (el.disabled || el.readOnly || !visible(el)) continue;

      if (type === 'radio') {
        const key = el.name || ref(el);
        if (!radioGroups.has(key)) {
          const group = el.closest('fieldset, [role="radiogroup"], .form-group, .question, div');
          const legend = group ? clean((group.querySelector('legend, .label, label:not(:has(input))') || {}).innerText || '') : '';
          const field = { ref: ref(el), kind: 'radio', label: legend, required: false, options: [], value: '' };
          radioGroups.set(key, field);
          fields.push(field);
        }
        const g = radioGroups.get(key);
        const optText = clean((el.labels && el.labels[0] && el.labels[0].innerText) || el.value);
        g.options.push({ value: el.value, text: optText, ref: ref(el) });
        if (el.required) g.required = true;
        if (el.checked) g.value = optText;
        if (!g.label) g.label = labelOf(el).replace(optText, '').trim();
        continue;
      }

      const label = labelOf(el);
      const field = {
        ref: ref(el),
        kind: type === 'range' ? 'slider' : ['email', 'tel', 'number', 'date', 'textarea', 'select', 'checkbox', 'file'].includes(type) ? type : 'text',
        label,
        required: isRequired(el, label),
        options: [],
        value: type === 'checkbox' ? (el.checked ? 'checked' : '') : type === 'file' ? '' : (el.value || '')
      };
      if (field.kind === 'select') {
        field.options = [...el.options].map(o => ({ value: o.value, text: clean(o.textContent) })).filter(o => o.text);
        const sel = el.options[el.selectedIndex];
        field.value = sel && sel.value ? clean(sel.textContent) : '';
      }
      if (field.kind === 'file') field.hasFile = el.files && el.files.length > 0;
      fields.push(field);
    }

    // Custom widgets the agent does not operate (reported as unsupported if required).
    for (const el of root.querySelectorAll('[role="combobox"]:not(input):not(select), [contenteditable="true"], [role="slider"]:not(input)')) {
      if (!visible(el)) continue;
      const label = labelOf(el);
      const kind = el.getAttribute('role') === 'slider' ? 'slider' : el.getAttribute('contenteditable') === 'true' ? 'contenteditable' : 'combobox';
      fields.push({ ref: ref(el), kind, label, required: isRequired(el, label), options: [], value: clean(el.innerText).slice(0, 80) });
    }
    return fields;
  });
}

// Validation scan after filling: required-but-empty, aria-invalid, :invalid, visible error text.
async function validationErrors(scope) {
  return scope.evaluate(root => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const errs = [];
    for (const el of root.querySelectorAll('[aria-invalid="true"], input:invalid, textarea:invalid, select:invalid')) {
      if (el.type === 'hidden' || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (el.type !== 'file' && (r.width === 0 || r.height === 0)) continue;
      errs.push(clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.name || el.id).slice(0, 100));
    }
    for (const el of root.querySelectorAll('.error, .error-message, .invalid-feedback, [role="alert"], [class*="error-text"]')) {
      const t = clean(el.innerText);
      const r = el.getBoundingClientRect();
      if (t && r.width > 0 && r.height > 0) errs.push(t.slice(0, 100));
    }
    return [...new Set(errs)];
  });
}

module.exports = { extractFields, validationErrors };
