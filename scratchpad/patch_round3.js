// Round 3 workflow patch: bounded timeouts, single Ollama retry, and a new foundit scraper
// cloned from the Naukri one. Re-runnable. Usage: node scratchpad/patch_round3.js
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const write = (rel, wf) => { fs.writeFileSync(path.join(root, rel), `${JSON.stringify(wf, null, 2)}\n`); console.log('wrote', rel); };

function patchNodes(rel, changes) {
  const wf = read(rel);
  for (const [name, { timeout, maxTries }] of Object.entries(changes)) {
    const node = wf.nodes.find(n => n.name === name);
    if (!node) throw new Error(`${rel}: node "${name}" not found`);
    node.parameters.options = node.parameters.options || {};
    node.parameters.options.timeout = timeout;
    if (maxTries !== undefined) {
      if (maxTries <= 1) { delete node.retryOnFail; delete node.maxTries; delete node.waitBetweenTries; }
      else { node.retryOnFail = true; node.maxTries = maxTries; }
    }
  }
  write(rel, wf);
}

const MIN = 60 * 1000;

// Nothing in the chain may run for hours: every hop now has a hard ceiling.
patchNodes('core/fit_scorer.json', {
  'Ollama — Score': { timeout: 25 * MIN, maxTries: 1 },
  'Ollama — Retry': { timeout: 25 * MIN, maxTries: 1 },
  'Build CV + Apply': { timeout: 70 * MIN }
});
patchNodes('core/cv_builder.json', {
  'Ollama — Tailor CV': { timeout: 25 * MIN, maxTries: 1 },
  'Ollama — Cover Letter': { timeout: 25 * MIN, maxTries: 1 },
  'Send to Executor Agent': { timeout: 15 * MIN }
});
for (const f of fs.readdirSync(path.join(root, 'scrapers')).filter(f => f.endsWith('.json') && f !== 'foundit_scraper.json')) {
  patchNodes(`scrapers/${f}`, { 'Score Job (one at a time)': { timeout: 90 * MIN } });
}

// foundit scraper: clone of the Naukri workflow with fresh ids.
const wf = read('scrapers/naukri_scraper.json');
wf.id = 'foundit-scraper-workflow';
wf.name = 'Scraper — foundit';
const renames = {};
for (const n of wf.nodes) {
  n.id = randomUUID();
  if (n.webhookId) n.webhookId = randomUUID();
  if (n.name === 'Scrape naukri') { renames[n.name] = 'Scrape foundit'; n.name = 'Scrape foundit'; }
  if (n.type === 'n8n-nodes-base.httpRequest' && typeof n.parameters.url === 'string') n.parameters.url = n.parameters.url.replace('/scrape/naukri', '/scrape/foundit');
  if (n.type === 'n8n-nodes-base.webhook') n.parameters.path = 'run-scraper-foundit';
  if (n.type === 'n8n-nodes-base.scheduleTrigger') n.parameters = { rule: { interval: [{ field: 'cronExpression', expression: '0 3-23/4 * * *' }] } };
}
const conns = {};
for (const [from, v] of Object.entries(wf.connections)) {
  for (const outs of v.main) for (const c of outs) c.node = renames[c.node] || c.node;
  conns[renames[from] || from] = v;
}
wf.connections = conns;
for (const k of ['versionId', 'shared', 'meta', 'tags']) delete wf[k];
wf.active = false;
write('scrapers/foundit_scraper.json', wf);
