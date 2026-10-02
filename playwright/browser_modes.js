// Condition-based browser modes for scrapers and the application engine.
//
//   NORMAL          standard Playwright Chromium, headless, no stealth or fingerprint changes
//   VISIBLE_REVIEW  the same browser, visible, for human login / verification / final review
//   BLOCKED         the site showed a bot check or access denial: stop and report, never evade
//   EXTERNAL_ATS    employer/ATS forms, filled by the local agentic form-filler (headless)
//
// Deliberately absent: stealth plugins, fingerprint/UA spoofing, proxy rotation, CAPTCHA solving.
// New compliant modes can be added here later.
//
// VISIBLE windows use a persistent per-site browser profile (setup/profiles/<site>): the whole
// profile (cookies, localStorage, IndexedDB) survives between runs, like a normal browser you keep
// logged in. When a check a person can solve appears there (CAPTCHA, Cloudflare, OTP, login),
// waitForHuman() pauses and lets YOU solve it in the window, then the run continues. The code never
// interacts with the check itself.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 1. ADDED: Playwright Extra and Stealth Plugins
const { chromium } = require('playwright');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromiumExtra.use(StealthPlugin());

const ROOT = path.join(__dirname, '..');

// 2. ADDED: STEALTH to modes
const MODES = Object.freeze({
  NORMAL: 'NORMAL',
  VISIBLE_REVIEW: 'VISIBLE_REVIEW',
  BLOCKED: 'BLOCKED',
  EXTERNAL_ATS: 'EXTERNAL_ATS',
  STEALTH: 'STEALTH'
});

// Env overrides are for automated tests only.
const profileRoot = () => process.env.JOB_AGENT_PROFILE_DIR || path.join(ROOT, 'setup', 'profiles');
const hitlFile = () => process.env.JOB_AGENT_HITL_FILE || path.join(ROOT, 'setup', 'hitl_status.json');
const VIEWPORT = { width: 1366, height: 900 };

function browserlessConnectionUrl() {
  if (String(process.env.BROWSERLESS_ENABLED || '').trim().toLowerCase() !== 'true') return null;
  const bypass = String(process.env.BROWSERLESS_BYPASS || 'false').trim().toLowerCase();
  if (bypass !== 'false') throw new Error('BROWSERLESS_BYPASS must remain false');

  const endpoint = String(process.env.BROWSERLESS_ENDPOINT || '').trim();
  const token = String(process.env.BROWSERLESS_TOKEN || '').trim();
  if (!endpoint || !token) throw new Error('BROWSERLESS_ENABLED requires BROWSERLESS_ENDPOINT and BROWSERLESS_TOKEN');

  const url = new URL(endpoint);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('BROWSERLESS_ENDPOINT must be an http(s) or ws(s) URL without embedded credentials');
  }
  if (url.pathname !== '/' && url.pathname.replace(/\/$/, '') !== '/chromium') {
    throw new Error('BROWSERLESS_ENDPOINT must use the standard /chromium endpoint');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = '/chromium';
  url.search = '';
  url.searchParams.set('token', token);
  url.hash = '';
  return url.toString();
}

// profile: site name (naukri | foundit | indeed) -> persistent profile in VISIBLE mode.
async function launch(mode, { storageState, locale = 'en-IN', profile } = {}) {
  // 3. ADDED: Force STEALTH mode so you don't have to change other files
  mode = MODES.STEALTH; 

  if (mode === MODES.BLOCKED) throw new Error('BLOCKED mode never opens a browser');
  const hasLocalStorageState = storageState && fs.existsSync(storageState);
  if (mode === MODES.NORMAL && !hasLocalStorageState) {
    const endpoint = browserlessConnectionUrl();
    if (endpoint) {
      let browser;
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
        const context = await browser.newContext({ viewport: VIEWPORT, locale });
        return { browser, context, remote: true };
      } catch (_) {
        if (browser) await browser.close().catch(() => {});
        throw new Error('Browserless connection or session setup failed; verify its endpoint, token, and availability');
      }
    }
  }
  // JOB_AGENT_HEADLESS=1 is for automated tests only (runs the visible code path without a window).
  const headless = mode !== MODES.VISIBLE_REVIEW || process.env.JOB_AGENT_HEADLESS === '1';
  // Tests that inject a fixture session never touch real profiles unless they set a profile dir.
  const persistent = profile && mode === MODES.VISIBLE_REVIEW && (!process.env.JOB_AGENT_STORAGE_STATE || process.env.JOB_AGENT_PROFILE_DIR);
  if (persistent) {
    // The helper keeps one live browser per site: open a tab in it instead of a new browser.
    const attached = await attachToKeeper(chromium, profile, { storageState }).catch(() => null);
    if (attached) return attached;
    try {
      return await launchProfile(chromium, profile, { headless, locale, storageState });
    } catch (e) {
      // e.g. the profile is already open in another run: fall back to a one-off window.
      process.stderr.write(`profile ${profile} unavailable (${e.message.split('\n')[0]}); using a one-off browser\n`);
    }
  }

  // 4. ADDED: Stealth launch logic
  const browserEngine = chromiumExtra;

  const launchArgs = [
    // Always use authenticated proxies, preferably residential/mobile
    "--proxy-server=http://username:password@proxy-ip:port",
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process'
  ];

  const browser = await browserEngine.launch({
    headless: false, // Stealth heavily relies on being visible to pass advanced Canvas/WebGL checks
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation'] // Hides "Chrome is being controlled" banner
  });
  
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale,
    ...(storageState && fs.existsSync(storageState) ? { storageState } : {})
  });
  return { browser, context };
}

// A persistent Chromium profile per site. The saved login (<site>_auth.json from LOGIN_ONCE) is
// imported into it the first time, and again whenever that file is newer (you logged in again).
const profileDirFor = name => path.join(profileRoot(), String(name).replace(/[^a-z0-9_-]/gi, '_'));

async function importLoginIfNewer(context, dir, storageState) {
  const marker = path.join(dir, '.imported_login');
  try {
    if (storageState && fs.existsSync(storageState)) {
      const newer = !fs.existsSync(marker) || fs.statSync(storageState).mtimeMs > fs.statSync(marker).mtimeMs;
      if (newer) {
        const state = JSON.parse(fs.readFileSync(storageState, 'utf8'));
        if (state.cookies?.length) await context.addCookies(state.cookies);
        fs.writeFileSync(marker, new Date().toISOString());
      }
    }
  } catch (_) {}
}

async function launchProfile(chromium, name, { headless, locale, storageState }) {
  const dir = profileDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, { headless, viewport: VIEWPORT, locale, channel: 'chrome' });
  await importLoginIfNewer(context, dir, storageState);
  // Same shape as a normal launch: callers only ever call browser.close().
  const browser = { persistent: true, profileDir: dir, close: () => context.close().catch(() => {}) };
  return { browser, context };
}

// Attach to the site's live browser (helper-service/browser_keeper.js), if one is running. Only the
// tabs this run opens are closed at the end; the browser stays up for the next task.
async function attachToKeeper(chromium, name, { storageState }) {
  const file = path.join(profileRoot(), `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.cdp.json`);
  if (!fs.existsSync(file)) return null;
  const { port } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
  const context = cdp.contexts()[0];
  if (!context) { await cdp.close().catch(() => {}); return null; }
  await importLoginIfNewer(context, profileDirFor(name), storageState);
  const mine = new Set();
  context.on('page', p => mine.add(p));
  const browser = {
    persistent: true, attached: true, profileDir: profileDirFor(name),
    close: async () => {
      for (const p of mine) await p.close().catch(() => {});
      await cdp.close().catch(() => {}); // disconnects; the browser keeps running
    }
  };
  return { browser, context };
}

const CHALLENGE_TEXT = {
  cloudflare: /just a moment|additional verification required|verify you are human|attention required|checking your browser|performing security verification/i,
  access_denied: /access denied|you don't have permission to access|request blocked|errors\.edgesuite\.net/i,
  captcha: /\bcaptcha\b|i'?m not a robot|select all images/i,
  otp: /\b(otp|one[- ]time (password|code|pin))\b|verification code (sent|has been sent)|enter the code (we|sent)/i
};
const CHALLENGE_FRAMES = /challenges\.cloudflare\.com|recaptcha|hcaptcha\.com|turnstile|arkoselabs|funcaptcha|geo\.captcha-delivery/i;

// Returns { kind, detail } where kind is cloudflare | access_denied | captcha | otp | login | null.
// Only looks at what's visible; it never interacts with the challenge.
async function detectChallenge(page) {
  try {
    const title = await page.title().catch(() => '');
    const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 2000);
    const head = `${title}\n${text}`;

    // Only VISIBLE challenge iframes count. Many sites load an invisible reCAPTCHA helper
    // (a 0x0 hidden frame) on every page; that is not a challenge to the user.
    const visibleChallengeFrames = await page.evaluate(src => {
      const re = new RegExp(src, 'i');
      return [...document.querySelectorAll('iframe')].filter(f => {
        const r = f.getBoundingClientRect();
        const st = getComputedStyle(f);
        return re.test(f.src || '') && r.width >= 30 && r.height >= 30 && st.visibility !== 'hidden' && st.display !== 'none' && !/size=invisible/.test(f.src || '');
      }).map(f => f.src);
    }, CHALLENGE_FRAMES.source).catch(() => []);
    if (visibleChallengeFrames.length) {
      return { kind: /cloudflare|turnstile/i.test(visibleChallengeFrames.join(' ')) ? 'cloudflare' : 'captcha', detail: 'visible challenge iframe on the page' };
    }
    if (CHALLENGE_TEXT.cloudflare.test(head)) return { kind: 'cloudflare', detail: title || 'Cloudflare verification page' };
    if (CHALLENGE_TEXT.access_denied.test(head) && text.length < 1500) return { kind: 'access_denied', detail: title || 'Access Denied' };
    if (await page.locator('.g-recaptcha, .h-captcha, [data-sitekey], #cf-chl-widget, [id^="cf-chl"]').count().catch(() => 0)) {
      return { kind: 'captcha', detail: 'CAPTCHA widget on the page' };
    }
    const otpInput = await page.locator('input[autocomplete="one-time-code"]:visible').count().catch(() => 0);
    if (otpInput || CHALLENGE_TEXT.otp.test(text)) return { kind: 'otp', detail: 'one-time code requested' };
    if (CHALLENGE_TEXT.captcha.test(text) && text.length < 1500) return { kind: 'captcha', detail: 'CAPTCHA text on the page' };
    if (await page.locator('input[type="password"]:visible').count().catch(() => 0)) {
      return { kind: 'login', detail: 'password field (login or account creation) on the page' };
    }
    return { kind: null, detail: '' };
  } catch (_) {
    return { kind: null, detail: '' };
  }
}

// Challenge kind -> stored application status.
function statusForChallenge(kind) {
  return kind === 'login' ? 'LOGIN_REQUIRED' : 'SECURITY_CHALLENGE';
}

function challengeNote(kind, detail) {
  const what = {
    cloudflare: 'Cloudflare verification',
    access_denied: 'an "Access Denied" bot block',
    captcha: 'a CAPTCHA',
    otp: 'a one-time code (OTP) request',
    login: 'a login / account page'
  }[kind] || 'a security check';
  return `Stopped because ${what} appeared${detail ? ` (${String(detail).slice(0, 80)})` : ''}. Manual browser interaction is required.`;
}

// ---------- human-in-the-loop ----------
// Checks a person can complete in the window. "access_denied" (a hard block) has nothing to solve.
const HUMAN_SOLVABLE = new Set(['cloudflare', 'captcha', 'otp', 'login']);

function humanWaitMs() {
  if (process.env.JOB_AGENT_HUMAN_WAIT_MS !== undefined) return Number(process.env.JOB_AGENT_HUMAN_WAIT_MS);
  try {
    const cfg = JSON.parse(fs.readFileSync(process.env.JOB_AGENT_SEARCH_CONFIG || path.join(ROOT, 'config', 'search.json'), 'utf8'));
    return Number(cfg.discovery?.humanWaitMinutes ?? 5) * 60 * 1000;
  } catch (_) { return 5 * 60 * 1000; }
}

function signalWaiting(info) {
  try { fs.writeFileSync(hitlFile(), JSON.stringify(info)); } catch (_) {}
  if (process.env.JOB_AGENT_HEADLESS === '1' || process.platform !== 'win32') return;
  // One Windows notification sound so you notice the window needs you.
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800'], { windowsHide: true, stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function clearWaiting() {
  try { fs.unlinkSync(hitlFile()); } catch (_) {}
}

// In a VISIBLE window only: when `challenge` is something you can solve, bring the window to the
// front, tell the dashboard, and poll (read-only) every 3 s until the check is gone or the wait
// times out. Returns true when the page is clear and the run may continue.
async function waitForHuman(page, challenge, { site = '', task = '', timeoutMs = humanWaitMs() } = {}) {
  if (!challenge || !HUMAN_SOLVABLE.has(challenge.kind) || !(timeoutMs > 0)) return false;
  const since = new Date().toISOString();
  signalWaiting({ site, task, kind: challenge.kind, detail: String(challenge.detail || '').slice(0, 120), url: page.url(), since, until: new Date(Date.now() + timeoutMs).toISOString(), pid: process.pid });
  await page.bringToFront().catch(() => {});
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, Math.min(3000, Math.max(50, timeoutMs / 4))));
      if (page.isClosed()) return false;
      const now = await detectChallenge(page);
      if (!now.kind) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        return true;
      }
    }
    return false;
  } finally {
    clearWaiting();
  }
}

// The dashboard banner reads this: which window is waiting for you, if any.
function waitingStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(hitlFile(), 'utf8'));
    if (Date.parse(s.until) + 30000 < Date.now()) return null; // stale (process ended)
    return s;
  } catch (_) { return null; }
}

module.exports = { MODES, launch, detectChallenge, statusForChallenge, challengeNote, waitForHuman, waitingStatus, HUMAN_SOLVABLE };