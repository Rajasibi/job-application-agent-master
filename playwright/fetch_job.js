// Reads ONE job page the user pasted (NORMAL mode, standard browser, no stealth) and returns
// { title, company, location, description } — or { blocked } if the site shows a bot check.
// Never used for Indeed pages (Indeed jobs need a pasted description instead).
//   node fetch_job.js --url <job or ATS URL>
const { MODES, launch, detectChallenge } = require('./browser_modes');
const { out, clip } = require('./common');

(async () => {
  const url = String(require('minimist')(process.argv.slice(2)).url || '');
  let browser;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs');
    if (/(^|\.)indeed\./i.test(u.hostname)) throw new Error('Indeed pages are not fetched automatically; paste the description');
    ({ browser } = await launch(MODES.NORMAL));
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const ch = await detectChallenge(page);
    if (ch.kind && ch.kind !== 'login') return out({ blocked: { kind: ch.kind, detail: ch.detail } });
    const info = await page.evaluate(() => {
      const meta = n => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '';
      const text = s => (s || '').replace(/\s+/g, ' ').trim();
      const main = document.querySelector('[class*="job-desc"], [class*="description"], [id*="description"], main, article') || document.body;
      return {
        title: text(document.querySelector('h1')?.innerText || meta('og:title') || document.title),
        company: text(meta('og:site_name') || document.querySelector('[class*="company"], [class*="employer"]')?.innerText || ''),
        location: text(document.querySelector('[class*="location"]')?.innerText || ''),
        description: text(main.innerText)
      };
    });
    out({ ...info, title: info.title.slice(0, 200), company: info.company.slice(0, 120), location: info.location.slice(0, 120), description: clip(info.description) });
  } catch (e) {
    out({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
