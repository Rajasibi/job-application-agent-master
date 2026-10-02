// One-time login saver. Opens a visible browser, you log in, press Enter here,
// and the session is saved to playwright/<platform>_auth.json for the apply scripts.
//
// Usage: node playwright/save_auth.js naukri|indeed|foundit   (also: linkedin|wttj)
// You type your password into the site itself; this script never sees or stores it,
// only the resulting session cookies.

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const LOGIN_URLS = {
  naukri: 'https://www.naukri.com/nlogin/login',
  indeed: 'https://secure.indeed.com/auth',
  foundit: 'https://www.foundit.in/rio/login',
  linkedin: 'https://www.linkedin.com/login',
  wttj: 'https://www.welcometothejungle.com/en/signin'
};

// --auto login detection, run inside the site's own page (a fetch, not a navigation,
// so it never interrupts the user while they type).
const AUTO_CHECKS = {
  foundit: page => page.evaluate(async () => {
    const r = await fetch('/middleware/profile/validateUserProfile', { headers: { Accept: 'application/json' } });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    // Logged out it returns {error, message}; logged in, a profile object.
    return !!j && typeof j === 'object' && !j.error && Object.keys(j).some(k => k !== 'message');
  })
};

(async () => {
  const platform = String(process.argv[2] || '').toLowerCase();
  if (!LOGIN_URLS[platform]) {
    console.error(`Usage: node save_auth.js ${Object.keys(LOGIN_URLS).join('|')}`);
    process.exit(1);
  }
  const authPath = path.join(__dirname, `${platform}_auth.json`);

  console.log(`\n=== ${platform.toUpperCase()} login ===`);
  console.log('1. Log in inside the browser window that opens');
  if (platform === 'foundit') {
    console.log('   Use "Email ID / Phone Number" with OTP or password.');
    console.log('   Do NOT use the Google button; Google blocks sign-in in automated browser windows.');
  }
  console.log('2. Wait until the site shows you logged in (your name or profile icon at the top)');
  console.log('3. Only then come back here and press Enter. Keep the browser open until this window says "Saved".');
  console.log('   (Type "skip" instead to skip this site.)\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(LOGIN_URLS[platform]).catch(() => {});

  if (process.argv.includes('--auto')) {
    // No Enter needed: poll the site's own login check and save as soon as it succeeds.
    const loggedIn = AUTO_CHECKS[platform];
    if (!loggedIn) { console.error(`--auto is not supported for ${platform}`); await browser.close(); process.exit(1); }
    const deadline = Date.now() + 10 * 60 * 1000;
    console.log('Waiting for you to log in (auto-saves when done; 10 min limit)...');
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      if (!browser.isConnected()) { console.log('Browser was closed before login. Nothing saved.'); process.exit(1); }
      const pages = context.pages().filter(p => /foundit\.in/.test(p.url()));
      if (pages.length && await loggedIn(pages[pages.length - 1]).catch(() => false)) {
        await new Promise(r => setTimeout(r, 3000)); // let the site finish setting its cookies
        await context.storageState({ path: authPath });
        console.log(`Saved: ${authPath}`);
        await browser.close();
        return;
      }
    }
    console.log('Login not detected within 10 minutes. Nothing saved; run this again.');
    await browser.close();
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('Press Enter when logged in... ', a => { rl.close(); resolve(a); }));

  if (/^skip$/i.test(answer.trim())) {
    console.log(`Skipped ${platform}.`);
  } else {
    await context.storageState({ path: authPath });
    console.log(`Saved: ${authPath}  (re-run if the site logs you out)`);
  }
  await browser.close();
})();
