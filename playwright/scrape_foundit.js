// foundit.in (formerly Monster India) scraper. India only. Standard browser, no stealth.
//   node scrape_foundit.js            NORMAL mode (scheduled)
//   node scrape_foundit.js --visible  VISIBLE mode: headed browser with your saved foundit session
// A block (e.g. "Access Denied") stops the run; it is never retried or bypassed.
// foundit's bot protection blocks automated visits to job pages, so this uses the site's own
// JSON APIs from inside a search-page session instead:
//   search results  <- the /middleware/jobsearch response the search page loads
//   descriptions    <- /middleware/jobdetail/<id>, fetched from that same page
const path = require('path');
const { runScraper, clip } = require('./common');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = (process.env.FOUNDIT_BASE_URL || 'https://www.foundit.in').replace(/\/$/, ''); // override: tests only
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
let apiPage = null; // a live foundit page used for jobdetail calls

const isRemote = loc => /^remote$/i.test(String(loc).trim());
const REMOTE_TEXT = /\bremote\b|work\s*from\s*home|\bwfh\b|work-from-home/i;

async function search(context, role, loc, checkBlocked) {
  let page;
  try { page = await context.newPage(); } catch (_) { return []; }
  let results = null;
  page.on('response', async r => {
    if (r.url().includes('/middleware/jobsearch')) {
      try { results = (await r.json()).jobSearchResponse?.data || []; } catch (_) {}
    }
  });
  // foundit has no working remote/WFH filter, so "Remote" searches run without a location
  // and describe() later keeps only jobs whose description actually says remote.
  const where = isRemote(loc) ? '' : `&locations=${encodeURIComponent(loc)}`;
  try {
    await page.goto(`${BASE}/srp/results?query=${encodeURIComponent(role)}${where}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 20 && results === null; i++) await page.waitForTimeout(500);
    if (results === null && await checkBlocked(page)) { await page.close().catch(() => {}); return []; } // blocked: run stops
  } catch (_) {}
  if (!apiPage && results !== null) apiPage = page; else await page.close().catch(() => {});
  return results || [];
}

runScraper('foundit', async ({ cfg, context, nextSearch, checkBlocked }) => {
  if (!cfg.india?.enabled) return [];
  const maxMinExp = cfg.foundit?.maxMinExperience ?? 5;
  // Many foundit listings are reposts that apply on another site (mostly LinkedIn); skip those hosts.
  const skipHosts = (cfg.foundit?.skipApplyHosts ?? ['linkedin.com']).map(h => h.toLowerCase());
  const appliesOnSkippedHost = j => {
    try { const h = new URL(j.applyUrl || j.redirectUrl).hostname.toLowerCase(); return skipHosts.some(s => h === s || h.endsWith(`.${s}`)); }
    catch (_) { return false; }
  };
  const all = [];
  const pre = { apiResults: 0, appliedOrClosed: 0, overExperienced: 0, skippedApplyHost: 0 };
  all.preFiltered = pre; // reported in the scraper's stats
  for (const loc of cfg.india.locations) {
    for (const role of cfg.india.roles) {
      if (!(await nextSearch())) return all; // time budget, visible-mode limit, or a block
      for (const j of await search(context, role, loc, checkBlocked)) {
        pre.apiResults++;
        if (j.isApplied || j.isJobActive === false || j.activeJob === false) { pre.appliedOrClosed++; continue; }
        if ((j.minimumExperience?.years ?? 0) > maxMinExp) { pre.overExperienced++; continue; }
        if (appliesOnSkippedHost(j)) { pre.skippedApplyHost++; continue; }
        all.push({
          job_id: `foundit_${j.jobId}`,
          foundit_id: j.jobId,
          job_title: String(j.title || '').trim(),
          company: j.hideCompanyName ? 'Confidential' : String(j.companyName || '').trim(),
          location: j.locations || loc,
          job_url: `${BASE}${j.seoJdUrl || j.jdUrl}`,
          external_apply_url: j.applyUrl || j.redirectUrl || '',
          experience: `${j.minimumExperience?.years ?? '?'}-${j.maximumExperience?.years ?? '?'} years`,
          skills: j.skills || '',
          remote_only: isRemote(loc) && !REMOTE_TEXT.test(`${j.title} ${j.locations}`),
          region: 'india',
          search_term: role
        });
      }
      await sleep(2500);
    }
  }
  return all;
}, {
  storageState: path.join(__dirname, 'foundit_auth.json'),
  locale: 'en-IN',
  describe: async job => {
    if (!apiPage) return '';
    const d = await apiPage.evaluate(async id => {
      const r = await fetch(`/middleware/jobdetail/${id}`, { headers: { Accept: 'application/json' } });
      return r.ok ? (await r.json()).jobDetailResponse : null;
    }, job.foundit_id).catch(() => null);
    await sleep(1500);
    const text = stripHtml(d?.description);
    if (job.remote_only && !REMOTE_TEXT.test(text)) return null; // from a "Remote" search but not remote
    if (!text) return '';
    return clip(`Experience: ${job.experience}. Skills: ${job.skills}.\n\n${text}`);
  }
});
