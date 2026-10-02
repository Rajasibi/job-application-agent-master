// Naukri.com scraper. India only. Standard browser, no stealth.
//   node scrape_naukri.js            NORMAL mode (scheduled)
//   node scrape_naukri.js --visible  VISIBLE mode: headed browser with your saved Naukri session
// A block (e.g. Akamai "Access Denied") stops the run; it is never retried or bypassed.
const path = require('path');
const { runScraper } = require('./common');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kebab = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const BASE = (process.env.NAUKRI_BASE_URL || 'https://www.naukri.com').replace(/\/$/, ''); // override: tests only

runScraper('naukri', async ({ cfg, context, nextSearch, checkBlocked }) => {
  if (!cfg.india?.enabled) return [];
  const all = [];
  const params = new URLSearchParams();
  if (cfg.naukri?.experience) params.set('experience', cfg.naukri.experience);
  if (cfg.naukri?.ctcFilter) params.set('ctcFilter', cfg.naukri.ctcFilter);
  const qs = params.toString() ? `?${params}` : '';

  for (const loc of cfg.india.locations) {
    for (const role of cfg.india.roles) {
      if (!(await nextSearch())) return all; // time budget, visible-mode limit, or a block
      let page;
      try {
        page = await context.newPage();
        const where = /^india$/i.test(loc) ? '' : `-in-${kebab(loc)}`;
        await page.goto(`${BASE}/${kebab(role)}-jobs${where}${qs}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4500);
        if (await checkBlocked(page)) return all; // blocked: stop the whole run, never evade

        const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('div.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple'))
          .slice(0, 10).map(c => {
            const t = c.querySelector('a.title, a[class*="title"]');
            return {
              job_title: t?.textContent.trim() || '',
              job_url: t?.href || '',
              company: c.querySelector('a.comp-name, a.subTitle, [class*="comp-name"]')?.textContent.trim() || '',
              location: c.querySelector('span.locWdth, [class*="loc"]')?.textContent.trim() || '',
              experience: c.querySelector('span.expwdth, [class*="exp-wrap"], [class*="expwdth"], [class*="experience"]')?.textContent.trim() || '',
              description: c.querySelector('span.job-desc, [class*="job-desc"]')?.textContent.trim() || ''
            };
          }).filter(j => j.job_url && j.job_title));

        for (const j of jobs) {
          const id = j.job_url.match(/-(\d{6,})/)?.[1];
          all.push({ ...j, job_id: id ? `naukri_${id}` : j.job_url, region: 'india', search_term: role });
        }
      } catch (e) {
        if (/context or browser has been closed|Target closed|Session closed/i.test(e.message)) return all;
      } finally {
        if (page) await page.close().catch(() => {});
      }
      await sleep(2500);
    }
  }
  return all;
}, {
  storageState: path.join(__dirname, 'naukri_auth.json'),
  locale: 'en-IN',
  descriptionSelectors: ['section[class*="job-desc"]', '.dang-inner-html', '[class*="JDC"]']
});
