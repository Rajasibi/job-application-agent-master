// LinkedIn scraper using the public guest jobs API (no login, no browser needed for search).
const { runScraper, clip } = require('./common');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

function parseCards(html) {
  const jobs = [];
  // Split per card so title/company/location stay paired with their job id.
  for (const card of html.split(/<li[\s>]/).slice(1)) {
    const id = card.match(/urn:li:jobPosting:(\d+)/)?.[1];
    if (!id) continue;
    jobs.push({
      job_id: `linkedin_${id}`,
      linkedin_id: id,
      job_title: text(card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1]),
      company: text(card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1]),
      location: text(card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1]),
      job_url: `https://www.linkedin.com/jobs/view/${id}`
    });
  }
  return jobs;
}

async function search(role, location, region) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}&f_TPR=r86400&start=0`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return [];
  return parseCards(await res.text()).map(j => ({ ...j, region, search_term: role }));
}

async function describe(job) {
  const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.linkedin_id}`, { headers: HEADERS });
  if (!res.ok) return '';
  const html = await res.text();
  await sleep(1500);
  return clip(text(html.match(/show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]));
}

runScraper('linkedin', async ({ cfg }) => {
  const all = [];
  const plans = [];
  if (cfg.india?.enabled) for (const loc of cfg.india.locations) for (const role of cfg.india.roles) plans.push([role, loc, 'india']);
  if (cfg.abroad?.enabled) for (const loc of cfg.abroad.locations) for (const role of cfg.abroad.roles) plans.push([role, `${loc.city}, ${loc.country}`, 'abroad']);
  for (const [role, loc, region] of plans) {
    all.push(...await search(role, loc, region).catch(() => []));
    await sleep(4000); // stay polite to avoid rate limiting
  }
  return all;
}, { describe });
