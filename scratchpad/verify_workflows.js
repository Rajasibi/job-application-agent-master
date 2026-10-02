const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const schedules = {
  linkedin_scraper: '0 */4 * * *',
  naukri_scraper: '0 1-23/4 * * *',
  indeed_scraper: '0 2-23/4 * * *',
  tier1_scraper: '30 3-23/6 * * *',
  wttj_scraper: '30 5-23/6 * * *'
};

for (const [name, cron] of Object.entries(schedules)) {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'scrapers', `${name}.json`), 'utf8'));
  const schedule = workflow.nodes.find(node => node.name === 'Schedule');
  const loop = workflow.nodes.find(node => node.name === 'Loop Over Jobs');
  const score = workflow.nodes.find(node => node.name === 'Score Job (one at a time)');
  assert.equal(schedule.parameters.rule.interval[0].expression, cron, `${name} cron`);
  assert.equal(loop.type, 'n8n-nodes-base.splitInBatches', `${name} loop type`);
  assert.equal(loop.typeVersion, 3, `${name} loop version`);
  assert.equal(loop.parameters.batchSize, 1, `${name} batch size`);
  assert.equal(score.parameters.options.timeout, 10800000, `${name} score timeout`);
  assert.equal(score.parameters.options.batching, undefined, `${name} batching removal`);
  assert.equal(score.onError, 'continueRegularOutput', `${name} per-job error handling`);
  assert.equal(workflow.connections['One Item Per Job'].main[0][0].node, 'Loop Over Jobs');
  assert.equal(workflow.connections['Loop Over Jobs'].main[0].length, 0);
  assert.equal(workflow.connections['Loop Over Jobs'].main[1][0].node, 'Score Job (one at a time)');
  assert.equal(workflow.connections['Score Job (one at a time)'].main[0][0].node, 'Loop Over Jobs');
}

function verifyTimeouts(file, expected) {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const [name, timeout] of Object.entries(expected)) {
    const node = workflow.nodes.find(candidate => candidate.name === name);
    assert.ok(node, `${file}: ${name} exists`);
    assert.equal(node.parameters.options.timeout, timeout, `${file}: ${name} timeout`);
  }
}

verifyTimeouts('core/fit_scorer.json', {
  'Ollama — Score': 3600000,
  'Ollama — Retry': 3600000,
  'Build CV + Apply': 7200000
});
verifyTimeouts('core/cv_builder.json', {
  'Ollama — Tailor CV': 3600000,
  'Ollama — Cover Letter': 3600000,
  'Send to Executor Agent': 1800000
});

console.log('PASS: all workflow JSON parses; loop wiring, schedules, timeouts, and error continuation are correct.');
