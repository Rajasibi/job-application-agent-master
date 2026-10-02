// Recruiter questions shown after a one-click Apply (Naukri's chat-style drawer).
//
// Each question is answered ONLY when answer_resolver.classify() gives a trusted answer from your
// profile / skills table (notice period, CTC, expected CTC, years of experience in a listed skill,
// location, relocation, ...). The first question without one stops the run and is reported: nothing
// is guessed, and no free-text, opinion, legal or demographic question is ever answered.

const { classify, matchOption } = require('./answer_resolver');

const SAFE = new Set(['SAFE_PROFILE_ANSWER', 'SAFE_CV_FACT', 'YES_NO_PROFILE_ANSWER']);
const DRAWER = '[class*="chatbot_Drawer"], [class*="chatbot_DrawerContentWrapper"], [class*="chatbot_MessageContainer"], [data-agent-questions]';
const BOT_MSG = '[class*="botItem"] [class*="botMsg"], [class*="botMsg"], [data-agent-question]';
const TEXT_INPUT = '[contenteditable="true"], textarea, input[type="text"], input[type="number"]';
const SEND = '[class*="sendMsg"], [class*="send-btn"], button:has-text("Save"), button:has-text("Send"), [data-agent-send]';
const RADIO = 'input[type="radio"]';

async function lastQuestion(drawer) {
  const msgs = drawer.locator(BOT_MSG);
  const n = await msgs.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const t = (await msgs.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

async function radioOptions(drawer) {
  return drawer.locator(RADIO).evaluateAll(els => els.filter(e => e.offsetParent !== null || e.closest('label')).map(e => {
    const lab = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
    return { id: e.id || '', value: e.value || '', text: ((lab || e.closest('label') || e.parentElement)?.innerText || e.value || '').trim() };
  })).catch(() => []);
}

// Returns { stopped, answered: [question], unanswered: [question] }.
async function answerRecruiterQuestions(page, trusted, { timeoutMs = 8000, maxQuestions = 15 } = {}) {
  const drawer = page.locator(DRAWER).first();
  const appeared = await drawer.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false);
  const answered = [];
  if (!appeared) return { stopped: false, answered, unanswered: [] };

  let previous = '';
  for (let i = 0; i < maxQuestions; i++) {
    await page.waitForTimeout(1500);
    if (!(await drawer.isVisible().catch(() => false))) break; // drawer closed: all questions done
    const question = await lastQuestion(drawer);
    if (!question) break;
    if (question === previous) {
      // The same question is still showing after an answer: the site didn't accept it.
      return { stopped: true, answered, unanswered: [question] };
    }
    const options = await radioOptions(drawer);
    const field = { label: question, kind: options.length ? 'radio' : 'text', required: true, options: options.map(o => ({ text: o.text, value: o.value })) };
    const c = classify(field, trusted);
    if (!SAFE.has(c.category) || String(c.value).trim() === '') return { stopped: true, answered, unanswered: [question] };

    if (options.length) {
      const opt = matchOption(field.options, c.value, question);
      if (!opt) return { stopped: true, answered, unanswered: [question] };
      const o = options.find(x => x.text === opt.text && x.value === opt.value);
      const radio = o && o.id
        ? drawer.locator(`[id="${o.id.replace(/"/g, '')}"]`)
        : drawer.locator(`input[type="radio"][value="${String(opt.value).replace(/"/g, '')}"]`);
      await radio.first().check({ force: true }).catch(() => {});
    } else {
      const input = drawer.locator(TEXT_INPUT).last();
      if (!(await input.isVisible().catch(() => false))) return { stopped: true, answered, unanswered: [question] };
      await input.click().catch(() => {});
      const editable = await input.evaluate(e => e.isContentEditable).catch(() => false);
      if (editable) await page.keyboard.type(String(c.value)); else await input.fill(String(c.value));
    }
    const send = drawer.locator(SEND).last();
    if (!(await send.isVisible().catch(() => false))) return { stopped: true, answered, unanswered: [question] };
    await send.click().catch(() => {});
    answered.push(question);
    previous = question;
  }
  return { stopped: false, answered, unanswered: [] };
}

module.exports = { answerRecruiterQuestions };
