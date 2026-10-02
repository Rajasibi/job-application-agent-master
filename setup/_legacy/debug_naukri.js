// Debug what Naukri actually shows after auth state load
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.join(__dirname, 'naukri_auth.json');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  await page.goto('https://www.naukri.com/ai-operations-manager-jobs-in-delhi-ncr', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Grab page title + first few job-like elements
  const title = await page.title();
  const url = page.url();
  const html = await page.content();

  // Count various potential selectors
  const counts = await page.evaluate(() => {
    return {
      'article.jobTuple': document.querySelectorAll('article.jobTuple').length,
      'div.srp-jobtuple-wrapper': document.querySelectorAll('div.srp-jobtuple-wrapper').length,
      '.cust-job-tuple': document.querySelectorAll('.cust-job-tuple').length,
      'a[href*="/job-listings"]': document.querySelectorAll('a[href*="/job-listings"]').length,
      'a[class*="title"]': document.querySelectorAll('a[class*="title"]').length,
      'div[data-job-id]': document.querySelectorAll('div[data-job-id]').length,
      'all-articles': document.querySelectorAll('article').length,
      'all-divs-with-job': Array.from(document.querySelectorAll('div')).filter(d => /job|tuple/i.test(d.className)).length,
      'login-prompt': document.body.innerText.match(/login|sign.{0,5}in/i)?.[0] || 'NO'
    };
  });

  // Take screenshot
  const ssPath = path.join(__dirname, '..', 'output', 'debug_naukri.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  console.log(JSON.stringify({
    title, url, counts, screenshot: ssPath, htmlLength: html.length,
    htmlSnippet: html.substring(0, 1000)
  }, null, 2));

  await browser.close();
})();
