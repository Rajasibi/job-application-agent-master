// Condition-based browser modes for scrapers and the application engine.
// ZERO-COST STEALTH EDITION: Bypasses DataDome/Cloudflare using real Chrome and randomized fingerprints.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 1. Playwright Extra and Stealth Plugins
const { chromium } = require('playwright');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromiumExtra.use(StealthPlugin());

const ROOT = path.join(__dirname, '..');
const MODES = Object.freeze({
  NORMAL: 'NORMAL',
  VISIBLE_REVIEW: 'VISIBLE_REVIEW',
  BLOCKED: 'BLOCKED',
  EXTERNAL_ATS: 'EXTERNAL_ATS',
  STEALTH: 'STEALTH'
});

// Env overrides
const profileRoot = () => process.env.JOB_AGENT_PROFILE_DIR || path.join(ROOT, 'setup', 'profiles');
const hitlFile = () => process.env.JOB_AGENT_HITL_FILE || path.join(ROOT, 'setup', 'hitl_status.json');

// ZERO-COST BYPASS: Randomize viewport slightly so every session looks unique, as Cloudflare flags perfectly consistent window sizes
const getRandomViewport = () => ({
  width: 1280 + Math.floor(Math.random() * 100),
  height: 720 + Math.floor(Math.random() * 100)
});

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
  // Force stealth mode globally
  mode = MODES.STEALTH; 

  if (mode === MODES.BLOCKED) throw new Error('BLOCKED mode never opens a browser');
  
  const persistent = profile && (!process.env.JOB_AGENT_STORAGE_STATE || process.env.JOB_AGENT_PROFILE_DIR);
  
  if (persistent) {
    // Pass chromiumExtra instead of standard chromium to ensure stealth applies to persistent profiles
    const attached = await attachToKeeper(chromiumExtra, profile, { storageState }).catch(() => null);
    if (attached) return attached;
    try {
      return await launchProfile(chromiumExtra, profile, { locale, storageState });
    } catch (e) {
      process.stderr.write(`profile ${profile} unavailable (${e.message.split('\n')[0]}); using a one-off browser\n`);
    }
  }

  // ZERO-COST BYPASS: Launch with the 'chrome' channel to use your real PC's browser (fixes DataDome TLS blocks)
  const browser = await chromiumExtra.launch({
    headless: false, // Must be false for stealth to work properly
    channel: 'chrome', 
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });
  
  const context = await browser.newContext({
    viewport: getRandomViewport(),
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", 
    locale: locale,
    timezoneId: 'Asia/Calcutta', // Hardcoded to your local timezone to avoid IP/Time mismatches
    ...(storageState && fs.existsSync(storageState) ? { storageState } : {})
  });
  return { browser, context };
}

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

async function launchProfile(chromiumInstance, name, { locale, storageState }) {
  const dir = profileDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  
  // ZERO-COST BYPASS: Ensure persistent profiles (like Indeed login) also use real Chrome and randomized fingerprints
  const context = await chromiumInstance.launchPersistentContext(dir, { 
    headless: false, 
    viewport: getRandomViewport(), 
    locale, 
    channel: 'chrome',
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    timezoneId: 'Asia/Calcutta',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  await importLoginIfNewer(context, dir, storageState);
  const browser = { persistent: true, profileDir: dir, close: () => context.close().catch(() => {}) };
  return { browser, context };
}

async function attachToKeeper(chromiumInstance, name, { storageState }) {
  const file = path.join(profileRoot(), `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.cdp.json`);
  if (!fs.existsSync(file)) return null;
  const { port } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cdp = await chromiumInstance.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
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
async function detectChallenge(page) {
  try {
    const title = await page.title().catch(() => '');
    const text = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 2000);
    const head = `${title}\n${text}`;

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
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800'], { windowsHide: true, stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function clearWaiting() {
  try { fs.unlinkSync(hitlFile()); } catch (_) {}
}

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

function waitingStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(hitlFile(), 'utf8'));
    if (Date.parse(s.until) + 30000 < Date.now()) return null; // stale (process ended)
    return s;
  } catch (_) { return null; }
}

module.exports = { MODES, launch, detectChallenge, statusForChallenge, challengeNote, waitForHuman, waitingStatus, HUMAN_SOLVABLE };