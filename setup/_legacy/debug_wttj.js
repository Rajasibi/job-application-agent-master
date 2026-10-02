const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto('https://www.welcometothejungle.com/en/jobs?query=AI+Operations&aroundQuery=Paris', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  const title = await page.title();
  const url = page.url();
  const ssPath = path.join(__dirname, '..', 'output', 'debug_wttj.png');
  await page.screenshot({ path: ssPath });

  const counts = await page.evaluate(() => ({
    'a[href*="/jobs/"]': document.querySelectorAll('a[href*="/jobs/"]').length,
    'all-articles': document.querySelectorAll('article').length,
    'all-links': document.querySelectorAll('a').length,
    'div-list': document.querySelectorAll('[role="list"] li').length,
    'job-cards': document.querySelectorAll('[data-testid*="job-card"]').length,
    'has-cookie-banner': !!document.querySelector('[class*="cookie"], [class*="consent"]'),
    'page-text-snippet': document.body.innerText.substring(0, 500)
  }));

  console.log(JSON.stringify({ title, url, counts, screenshot: ssPath }, null, 2));
  await browser.close();
})();
