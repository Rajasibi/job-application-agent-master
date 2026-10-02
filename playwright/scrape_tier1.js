// Tier 1 company career pages (Capgemini, Accenture, JLL, CBRE, EY). India region.
// Career sites change often; each target keeps its own link selector.
const { runScraper } = require('./common');

const TARGETS = {
  Capgemini: {
    url: q => `https://www.capgemini.com/jobs/?_sft_country=india&_keyword=${q}`,
    links: 'a[href*="/jobs/"]:not([href*="?_sft"])'
  },
  Accenture: {
    url: q => `https://www.accenture.com/in-en/careers/jobsearch?jk=${q}&jl=India`,
    links: 'a[href*="/jobdetails"], a[href*="/job/"]'
  },
  JLL: {
    url: q => `https://careers.jll.com/global/en/search-results?keywords=${q}&location=India`,
    links: 'a[data-ph-at-id*="job-link"], a[href*="/job/"]'
  },
  CBRE: {
    url: q => `https://careers.cbre.com/en_US/careers/SearchJobs/${q}?listFilterMode=1&jobRecordsPerPage=20&3_12_3=India`,
    links: 'a[href*="/JobDetail/"]'
  },
  EY: {
    url: q => `https://careers.ey.com/ey/search/?q=${q}&locationsearch=India`,
    links: 'a.jobTitle-link, a[href*="/job/"]'
  }
};

runScraper('tier1', async ({ cfg, context }) => {
  if (!cfg.tier1?.enabled) return [];
  const q = encodeURIComponent(cfg.tier1.keywords || '');
  const all = [];

  for (const company of cfg.tier1.companies || Object.keys(TARGETS)) {
    const target = TARGETS[company];
    if (!target) continue;
    const page = await context.newPage();
    try {
      await page.goto(target.url(q), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(6000);
      const jobs = await page.$$eval(target.links, as => as.slice(0, 10).map(a => ({
        job_title: (a.querySelector('h3, h4, span, [class*="title"]')?.textContent || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        job_url: a.href
      })).filter(j => j.job_url.startsWith('http') && j.job_title.length > 5));

      for (const j of jobs) {
        all.push({ ...j, job_id: j.job_url, company, location: 'India', region: 'india', source_platform: `tier1_${company.toLowerCase()}` });
      }
    } catch (_) {
    } finally {
      await page.close().catch(() => {});
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return all;
});
