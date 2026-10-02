// Welcome to the Jungle scraper (stealth browser). Abroad only.
const { runScraper } = require('./common');

const sleep = ms => new Promise(r => setTimeout(r, ms));

runScraper('wttj', async ({ cfg, context }) => {
  if (!cfg.abroad?.enabled) return [];
  const all = [];
  for (const loc of cfg.abroad.locations) {
    for (const role of cfg.abroad.roles) {
      const page = await context.newPage();
      try {
        await page.goto(`https://www.welcometothejungle.com/en/jobs?query=${encodeURIComponent(role)}&aroundQuery=${encodeURIComponent(`${loc.city}, ${loc.country}`)}&page=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        const consent = page.locator('button:has-text("OK for me"), button:has-text("Accept")').first();
        if (await consent.isVisible({ timeout: 2500 }).catch(() => false)) await consent.click().catch(() => {});
        await page.waitForTimeout(3000);

        const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('li[data-testid*="search-results"], li[role="listitem"]'))
          .slice(0, 10).map(c => {
            const link = c.querySelector('a[href*="/jobs/"]');
            if (!link) return null;
            return {
              job_url: new URL(link.getAttribute('href'), location.origin).toString(),
              job_title: (c.querySelector('h2, h3, h4, [data-testid*="title"]')?.textContent || '').trim().slice(0, 200),
              company: (c.querySelector('[data-testid*="company"], [class*="organization"]')?.textContent || '').trim(),
              location: (c.querySelector('[data-testid*="location"], [class*="location"]')?.textContent || '').trim()
            };
          }).filter(j => j && j.job_title));

        for (const j of jobs) all.push({ ...j, job_id: j.job_url, location: j.location || loc.city, region: 'abroad', search_term: role });
      } catch (_) {
      } finally {
        await page.close().catch(() => {});
      }
      await sleep(2500);
    }
  }
  return all;
}, { descriptionSelectors: ['[data-testid="job-section-description"]', 'section#the-position-section', 'main'] });
