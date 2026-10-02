// One-time helper: saves Naukri.com auth state.
// Usage: node playwright/save_naukri_auth.js

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const AUTH_PATH = path.join(__dirname, 'naukri_auth.json');

(async () => {
  console.log('\n=========================================');
  console.log('  Naukri.com Auth Saver (one-time setup)');
  console.log('=========================================\n');
  console.log('A browser window will open. Please:');
  console.log('  1. Log in to Naukri.com');
  console.log('  2. Wait until you see your dashboard');
  console.log('  3. Come back here and press Enter\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  await page.goto('https://www.naukri.com/nlogin/login');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('\nPress Enter AFTER you have logged in... ', () => { rl.close(); resolve(); }));

  await context.storageState({ path: AUTH_PATH });
  console.log(`\n✓ Auth saved to: ${AUTH_PATH}`);
  console.log('  All future naukri_apply.js runs will use this session.\n');

  await browser.close();
})();
