// Indeed scraper. Standard browser, no stealth. India uses in.indeed.com; abroad uses each
// location's country domain.
//   node scrape_indeed.js --visible  VISIBLE mode: headed browser with your saved Indeed session,
//                                    slow (5 s between pages); a check you can solve waits for you
// Any block that isn't solved (Cloudflare, Access Denied) stops the whole run: no retries, no
// bypass. Indeed Apply is never automated (see indeed_apply.js).
const path = require('path');
const { runScraper } = require('./common');

// Tests only: a local mock instead of the real Indeed domain.
const BASE = process.env.INDEED_BASE_URL ? process.env.INDEED_BASE_URL.replace(/\/$/, '') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

runScraper('indeed', async ({ cfg, context, nextSearch, checkBlocked }) => {
  const plans = [];
  if (cfg.india?.enabled) for (const loc of cfg.india.locations) for (const role of cfg.india.roles) plans.push({ role, loc, domain: 'in.indeed.com', region: 'india' });
  if (cfg.abroad?.enabled) for (const loc of cfg.abroad.locations) for (const role of cfg.abroad.roles) plans.push({ role, loc: loc.city, domain: loc.indeedDomain || 'www.indeed.com', region: 'abroad' });

  const all = [];
  for (const p of plans) {
    if (!(await nextSearch())) return all; // time budget, visible-mode limit, or a block
    const origin = BASE || `https://${p.domain}`;
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/jobs?q=${encodeURIComponent(p.role)}&l=${encodeURIComponent(p.loc)}&fromage=3&sort=date`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
      if (await checkBlocked(page)) return all; // blocked: stop the whole run, never evade

      const jobs = await page.evaluate(originUrl => Array.from(document.querySelectorAll('div.job_seen_beacon, div[data-jk]'))
        .slice(0, 15).map(c => {
          const link = c.querySelector('a[data-jk], h2 a, a.jcs-JobTitle');
          const jk = c.getAttribute('data-jk') || link?.getAttribute('data-jk') || '';
          return {
            job_id: jk ? `indeed_${jk}` : '',
            job_title: c.querySelector('h2 span[title], h2 a span, span[id^="jobTitle"]')?.textContent.trim() || '',
            job_url: jk ? `${originUrl}/viewjob?jk=${jk}` : (link?.href || ''),
            company: c.querySelector('[data-testid="company-name"], .companyName')?.textContent.trim() || '',
            location: c.querySelector('[data-testid="text-location"], .companyLocation')?.textContent.trim() || '',
            description: c.querySelector('.job-snippet, [data-testid="snippet"]')?.textContent.trim() || ''
          };
        }).filter(j => j.job_url && j.job_title), origin);

      for (const j of jobs) all.push({ ...j, job_id: j.job_id || j.job_url, region: p.region, search_term: p.role });
    } catch (_) {
    } finally {
      await page.close().catch(() => {});
    }
    await sleep(1500);
  }
  return all;
}, {
  storageState: path.join(__dirname, 'indeed_auth.json'),
  locale: 'en-IN',
  descriptionSelectors: ['#jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]']
});
