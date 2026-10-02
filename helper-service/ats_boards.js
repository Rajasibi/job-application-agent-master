// Public ATS job-board APIs: jobs straight from employers' official, documented JSON feeds.
// No job-site page is loaded, so there is nothing to block and no check to hit.
//
//   greenhouse       GET https://boards-api.greenhouse.io/v1/boards/<id>/jobs?content=true
//   lever            GET https://api.lever.co/v0/postings/<id>?mode=json
//   ashby            GET https://api.ashbyhq.com/posting-api/job-board/<id>
//   smartrecruiters  GET https://api.smartrecruiters.com/v1/companies/<id>/postings
//   workable         GET https://apply.workable.com/api/v1/widget/accounts/<id>?details=true
//
// Companies come from config/companies.json. Jobs go to the existing feeder (same dedupe,
// scoring, CV, application check and Sheet); the company form is filled but never submitted.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMPANIES = path.join(ROOT, 'config', 'companies.json');
const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'];

const stripHtml = s => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const ENDPOINT = {
  greenhouse: id => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(id)}/jobs?content=true`,
  lever: id => `https://api.lever.co/v0/postings/${encodeURIComponent(id)}?mode=json`,
  ashby: id => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(id)}`,
  smartrecruiters: id => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings`,
  workable: id => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(id)}?details=true`
};

// Provider JSON -> [{ id, title, location, url, description }]. Pure; unit-tested with sample JSON.
const NORMALIZE = {
  greenhouse: (d, c) => (d.jobs || []).map(j => ({
    id: j.id, title: j.title, location: j.location?.name || '', url: j.absolute_url, description: stripHtml(j.content)
  })),
  lever: (d, c) => (Array.isArray(d) ? d : []).map(j => ({
    id: j.id, title: j.text, location: [j.categories?.location, j.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(', '),
    url: j.hostedUrl, description: stripHtml(j.descriptionPlain || j.description) + (j.lists || []).map(l => ` ${l.text}: ${stripHtml(l.content)}`).join('')
  })),
  ashby: (d, c) => (d.jobs || []).filter(j => j.isListed !== false).map(j => ({
    id: j.id, title: j.title, location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join(', '),
    url: j.jobUrl || j.applyUrl, description: stripHtml(j.descriptionPlain || j.descriptionHtml)
  })),
  smartrecruiters: (d, c) => (d.content || []).map(j => ({
    id: j.id, title: j.name,
    location: [j.location?.city, j.location?.region, j.location?.country?.toUpperCase?.(), j.location?.remote ? 'Remote' : ''].filter(Boolean).join(', '),
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(c.id)}/${j.id}`,
    description: stripHtml([j.name, j.department?.label, j.function?.label, j.experienceLevel?.label].filter(Boolean).join('. '))
  })),
  workable: (d, c) => (d.jobs || []).map(j => ({
    id: j.shortcode || j.id, title: j.title,
    location: [j.city, j.state, j.country, j.telecommuting || j.remote ? 'Remote' : ''].filter(Boolean).join(', '),
    url: j.url || j.shortlink || j.application_url, description: stripHtml(j.description)
  }))
};

// Keeps only roles relevant to your search (company boards list every job the company has).
const DEFAULT_RELEVANCE = '\\b(ai|a\\.i\\.|ml|llm|llms|genai|gen ai|generative|machine learning|deep learning|nlp|natural language|prompt|rag|data scien|computer vision|applied scien)\\b';

function toPipelineJob(company, provider, j) {
  return {
    job_id: `ats_${provider}_${company.id}_${j.id}`,
    job_url: j.url,
    external_apply_url: j.url,
    job_title: String(j.title || '').trim(),
    company: company.name || company.id,
    location: String(j.location || '').trim(),
    description: String(j.description || '').slice(0, 4000),
    source_platform: 'external',
    region: 'india',
    search_term: `${provider} board`,
    discovered_via: `ats:${provider}`
  };
}

// cfg = config/search.json; keep = makeJobFilter(cfg); cardSkip = makeCardFilter(cfg)
function filterJobs(jobs, cfg, { keep = () => true, cardSkip = () => null } = {}) {
  const rel = new RegExp(cfg?.discovery?.relevancePattern || DEFAULT_RELEVANCE, 'i');
  const stats = { fetched: jobs.length, notRelevant: 0, filteredTitle: 0, filteredLocation: 0, filteredExperience: 0, noLink: 0 };
  const kept = [];
  for (const j of jobs) {
    if (!/^https?:\/\//.test(j.job_url || '')) { stats.noLink++; continue; }
    if (!rel.test(j.job_title)) { stats.notRelevant++; continue; }
    if (!keep(j)) { stats.filteredTitle++; continue; }
    const skip = cardSkip(j);
    if (skip === 'location') { stats.filteredLocation++; continue; }
    if (skip === 'experience') { stats.filteredExperience++; continue; }
    kept.push(j);
  }
  return { jobs: kept, stats };
}

function loadCompanies(file = COMPANIES) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(d) ? d : d.companies || []).filter(c => c && PROVIDERS.includes(c.ats) && c.id && c.enabled !== false);
  } catch (_) { return []; }
}

// Recognises a public ATS board from a job/apply link, e.g. https://jobs.lever.co/netomi/... -> {lever, netomi}.
function boardFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const h = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    const i = seg.indexOf('boards'); const id = h.startsWith('boards') || h.startsWith('job-boards') ? seg[0] : (i >= 0 ? seg[i + 1] : seg[0]);
    return id ? { ats: 'greenhouse', id } : null;
  }
  if (h === 'jobs.lever.co' && seg[0]) return { ats: 'lever', id: seg[0] };
  if (h === 'jobs.ashbyhq.com' && seg[0]) return { ats: 'ashby', id: seg[0] };
  if ((h === 'jobs.smartrecruiters.com' || h === 'careers.smartrecruiters.com') && seg[0]) return { ats: 'smartrecruiters', id: seg[0] };
  if (h === 'apply.workable.com' && seg[0] && seg[0] !== 'api') return { ats: 'workable', id: seg[0] };
  return null;
}

// Adds boards found in links already in your log to config/companies.json (keeps your own entries).
function seedCompanies(records, file = COMPANIES) {
  let doc = { _note: 'Public ATS job boards to read (greenhouse | lever | ashby | smartrecruiters | workable). Add { "name", "ats", "id" }; set "enabled": false to pause one.', companies: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); doc = Array.isArray(d) ? { ...doc, companies: d } : { ...doc, ...d }; } catch (_) {}
  const have = new Set(doc.companies.map(c => `${c.ats}:${String(c.id).toLowerCase()}`));
  const added = [];
  for (const r of records) {
    for (const link of [r.external_apply_url, r.form_url, r.job_url]) {
      const b = link && boardFromUrl(link);
      if (!b || have.has(`${b.ats}:${b.id.toLowerCase()}`)) continue;
      have.add(`${b.ats}:${b.id.toLowerCase()}`);
      const entry = { name: r.company || b.id, ats: b.ats, id: b.id, added_from: 'your application log' };
      doc.companies.push(entry);
      added.push(entry);
    }
  }
  if (added.length || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  }
  return added;
}

// Fetches every enabled board and returns pipeline jobs. Per-board errors are reported, never thrown.
async function fetchAll({ cfg, keep, cardSkip, fetchImpl = fetch, companies = loadCompanies(), log = () => {} } = {}) {
  const out = [];
  const perBoard = [];
  for (const c of companies) {
    const t = Date.now();
    try {
      const res = await fetchImpl(ENDPOINT[c.ats](c.id), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = NORMALIZE[c.ats](await res.json(), c).map(j => toPipelineJob(c, c.ats, j));
      const { jobs, stats } = filterJobs(raw, cfg, { keep, cardSkip });
      out.push(...jobs);
      perBoard.push({ company: c.name || c.id, ats: c.ats, ms: Date.now() - t, ...stats, kept: jobs.length });
    } catch (e) {
      perBoard.push({ company: c.name || c.id, ats: c.ats, error: String(e.message).slice(0, 120) });
      log(`ats board ${c.ats}/${c.id}: ${e.message}`);
    }
  }
  return { jobs: out, boards: perBoard };
}

module.exports = { fetchAll, filterJobs, loadCompanies, seedCompanies, boardFromUrl, toPipelineJob, NORMALIZE, ENDPOINT, PROVIDERS, stripHtml };
