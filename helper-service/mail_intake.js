// Job-alert emails -> pipeline. Naukri, foundit and Indeed email you the jobs that match your
// alerts; this reads those emails from your Gmail (read-only) and sends each job to the existing
// feeder. No job-site search page is loaded, so there are no Cloudflare / bot checks here.
//
// One-time setup: node setup/gmail_auth.js  (Google consent page, scope gmail.readonly).
//   config/gmail_oauth_client.json  your "Desktop app" OAuth client (from Google Cloud Console)
//   config/gmail_token.json         refresh token saved by gmail_auth.js (gitignored, never logged)
// Emails are never modified or deleted. Processed message ids: setup/mail_seen.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT_FILE = path.join(ROOT, 'config', 'gmail_oauth_client.json');
const TOKEN_FILE = path.join(ROOT, 'config', 'gmail_token.json');
const SEEN_FILE = path.join(ROOT, 'setup', 'mail_seen.json');
const QUERY = 'from:(naukri.com OR foundit.in OR monsterindia.com OR indeed.com) newer_than:3d';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ---------- parsing (pure; unit-tested with sample emails) ----------

const decodeEntities = s => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const textOf = html => decodeEntities(String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

const GENERIC_LINK = /^(apply( now)?|view( job| details)?|see (job|details)|know more|details|click here|easily apply|more|save|unsubscribe|similar jobs.*)$/i;

// A job-page URL on one of the three sites -> { platform, url } (canonical), else null.
function canonicalJobUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const h = u.hostname.toLowerCase();
  if (/(^|\.)naukri\.com$/.test(h) && /\/job-listings-.*-\d{9,}/.test(u.pathname)) return { platform: 'naukri', url: `https://www.naukri.com${u.pathname}` };
  if (/(^|\.)foundit\.in$/.test(h) && /\/job\/.+-\d{5,}\/?$/.test(u.pathname)) return { platform: 'foundit', url: `https://www.foundit.in${u.pathname.replace(/\/$/, '')}` };
  if (/(^|\.)indeed\.[a-z.]+$/.test(h)) {
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    if (jk && /^[a-f0-9]{8,}$/i.test(jk)) return { platform: 'indeed', url: `https://in.indeed.com/viewjob?jk=${jk.toLowerCase()}` };
  }
  return null;
}

// Alert links are usually click-tracking redirects: look for the real job URL inside them.
function unwrapLink(href) {
  const direct = canonicalJobUrl(href);
  if (direct) return direct;
  let s = String(href || '');
  for (let i = 0; i < 3; i++) {
    try { s = decodeURIComponent(s); } catch (_) { break; }
    const m = s.match(/https?:\/\/[^\s"'<>&]*(naukri\.com\/job-listings-[^\s"'<>&?#]+|foundit\.in\/job\/[^\s"'<>&?#]+|indeed\.[a-z.]+\/[^\s"'<>]*?[?&](?:jk|vjk)=[a-f0-9]+)/i);
    if (m) { const c = canonicalJobUrl(m[0]); if (c) return c; }
    try {
      const u = new URL(s);
      for (const v of u.searchParams.values()) { const c = /^https?:/i.test(v) ? canonicalJobUrl(v) : null; if (c) return c; }
    } catch (_) {}
  }
  return null;
}

const LOC_HINT = /\b(chennai|coimbatore|madurai|trichy|tiruchirappalli|salem|tamil nadu|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurgaon|gurugram|kolkata|kochi|india|remote|work from home|wfh|hybrid|anywhere)\b/i;
const EXP_HINT = /\b\d+\s*(?:-|–|to)\s*\d+\s*(?:yrs?|years?)\b|\b\d+\+?\s*(?:yrs?|years?)\b/i;
const SALARY_HINT = /(lpa|lakh|₹|inr|salary|ctc|not disclosed)/i;

// Email HTML -> [{ platform, job_url, job_title, company, location, experience, snippet }]
function parseAlertEmail(html) {
  const byUrl = new Map();
  const re = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const target = unwrapLink(decodeEntities(m[2]));
    if (!target) continue;
    const anchor = textOf(m[3]).replace(/\n/g, ' ').trim();
    const after = textOf(html.slice(re.lastIndex, re.lastIndex + 1200)).split('\n').slice(0, 8);
    const before = textOf(html.slice(Math.max(0, m.index - 600), m.index)).split('\n').slice(-3);
    const e = byUrl.get(target.url) || { platform: target.platform, job_url: target.url, titles: [], after: [], before: [] };
    if (anchor && !GENERIC_LINK.test(anchor) && anchor.length <= 140) e.titles.push(anchor);
    if (!e.after.length) e.after = after;
    if (!e.before.length) e.before = before;
    byUrl.set(target.url, e);
  }
  const jobs = [];
  for (const e of byUrl.values()) {
    const title = e.titles.sort((a, b) => b.length - a.length)[0] || e.before.filter(l => !GENERIC_LINK.test(l)).pop() || '';
    const lines = e.after.flatMap(l => l.split(/\s*[|•·]\s*/)).map(s => s.trim()).filter(s => s && s !== title && !GENERIC_LINK.test(s));
    const location = lines.find(s => LOC_HINT.test(s) && s.length <= 120) || '';
    const experience = (lines.find(s => EXP_HINT.test(s)) || '').match(EXP_HINT)?.[0] || '';
    const company = lines.find(s => s !== location && !EXP_HINT.test(s) && !SALARY_HINT.test(s) && s.length >= 2 && s.length <= 80 && !/^\d/.test(s)) || '';
    const snippet = lines.filter(s => s !== company && s !== location).join(' ').slice(0, 600);
    if (!title || title.length < 4) continue;
    jobs.push({ platform: e.platform, job_url: e.job_url, job_title: title.slice(0, 200), company: company || 'Unknown company', location, experience, snippet });
  }
  return jobs;
}

// Gmail message payload (format=full) -> HTML (or plain text wrapped) of the body.
function bodyOf(payload) {
  const found = { html: '', text: '' };
  const walk = p => {
    if (!p) return;
    const data = p.body && p.body.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.mimeType === 'text/html' && data) found.html += data;
    else if (p.mimeType === 'text/plain' && data) found.text += data;
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  if (found.html) return found.html;
  return found.text.replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
}

// ---------- Gmail API (read-only) ----------

function configured() { return fs.existsSync(CLIENT_FILE) && fs.existsSync(TOKEN_FILE); }

function oauthClient() {
  const j = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const c = j.installed || j.web || j;
  return { client_id: c.client_id, client_secret: c.client_secret };
}

let cachedToken = null;
async function accessToken(fetchImpl = fetch) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.value;
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const { client_id, client_secret } = oauthClient();
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token: saved.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20000)
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || !b.access_token) throw new Error(`Gmail auth failed (HTTP ${res.status}${b.error ? `: ${b.error}` : ''}). Run: node setup/gmail_auth.js`);
  cachedToken = { value: b.access_token, exp: Date.now() + (b.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function gmail(pathAndQuery, fetchImpl = fetch) {
  const res = await fetchImpl(`${GMAIL}${pathAndQuery}`, { headers: { Authorization: `Bearer ${await accessToken(fetchImpl)}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Gmail API HTTP ${res.status}`);
  return res.json();
}

const loadSeen = () => { try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch (_) { return new Set(); } };
const saveSeen = set => { fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-3000))); };

// Reads new alert emails -> pipeline jobs (not yet filtered). Returns { jobs, emails, stats }.
async function readAlerts({ fetchImpl = fetch, max = 40 } = {}) {
  const seen = loadSeen();
  const list = await gmail(`/messages?q=${encodeURIComponent(QUERY)}&maxResults=${max}`, fetchImpl);
  const ids = (list.messages || []).map(m => m.id).filter(id => !seen.has(id));
  const jobs = [];
  const stats = { emails: ids.length, perSite: { naukri: 0, foundit: 0, indeed: 0 } };
  for (const id of ids) {
    const msg = await gmail(`/messages/${id}?format=full`, fetchImpl);
    for (const j of parseAlertEmail(bodyOf(msg.payload))) { jobs.push(j); stats.perSite[j.platform]++; }
    seen.add(id);
  }
  saveSeen(seen);
  return { jobs, stats };
}

// Parsed email job -> pipeline job (same shape and job ids as the scrapers).
function toPipelineJob(j, jobIdFor) {
  return {
    job_id: jobIdFor(j.platform, j.job_url),
    job_url: j.job_url,
    job_title: j.job_title,
    company: j.company,
    location: j.location,
    experience: j.experience,
    description: [j.job_title, j.company, j.location, j.experience, j.snippet].filter(Boolean).join('. '),
    snippet: j.snippet,
    source_platform: j.platform,
    region: 'india',
    search_term: 'email alert',
    discovered_via: 'email'
  };
}

module.exports = { parseAlertEmail, unwrapLink, canonicalJobUrl, bodyOf, readAlerts, toPipelineJob, configured, QUERY, CLIENT_FILE, TOKEN_FILE };
