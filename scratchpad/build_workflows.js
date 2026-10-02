const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const schedules = {
  linkedin_scraper: '0 */4 * * *',
  naukri_scraper: '0 1-23/4 * * *',
  indeed_scraper: '0 2-23/4 * * *',
  tier1_scraper: '30 3-23/6 * * *',
  wttj_scraper: '30 5-23/6 * * *'
};

function readWorkflow(name) {
  const file = path.join(root, 'scrapers', `${name}.json`);
  return { file, workflow: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function updateScraper(name, cronExpression) {
  const { file, workflow } = readWorkflow(name);
  const schedule = workflow.nodes.find(node => node.type === 'n8n-nodes-base.scheduleTrigger');
  const items = workflow.nodes.find(node => node.name === 'One Item Per Job');
  const score = workflow.nodes.find(node => node.name === 'Score Job (one at a time)');
  if (!schedule || !items || !score) throw new Error(`${name}: expected scraper nodes not found`);

  const oldScheduleName = schedule.name;
  schedule.name = 'Schedule';
  schedule.parameters = {
    rule: { interval: [{ field: 'cronExpression', expression: cronExpression }] }
  };

  let loop = workflow.nodes.find(node => node.name === 'Loop Over Jobs');
  if (!loop) {
    loop = {
      parameters: { batchSize: 1, options: {} },
      id: randomUUID(),
      name: 'Loop Over Jobs',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [900, 300]
    };
    workflow.nodes.push(loop);
  } else {
    loop.parameters = { batchSize: 1, options: {} };
    loop.typeVersion = 3;
  }

  score.parameters.options = score.parameters.options || {};
  delete score.parameters.options.batching;
  score.parameters.options.timeout = 10800000;
  score.position = [1120, 300];
  score.onError = 'continueRegularOutput';

  const priorConnections = workflow.connections;
  const nextConnections = {};
  for (const [source, value] of Object.entries(priorConnections)) {
    const key = source === oldScheduleName ? 'Schedule' : source;
    nextConnections[key] = value;
  }
  nextConnections['One Item Per Job'] = {
    main: [[{ node: 'Loop Over Jobs', type: 'main', index: 0 }]]
  };
  nextConnections['Loop Over Jobs'] = {
    main: [
      [],
      [{ node: 'Score Job (one at a time)', type: 'main', index: 0 }]
    ]
  };
  nextConnections['Score Job (one at a time)'] = {
    main: [[{ node: 'Loop Over Jobs', type: 'main', index: 0 }]]
  };
  workflow.connections = nextConnections;

  fs.writeFileSync(file, `${JSON.stringify(workflow, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, file)} (${cronExpression})`);
}

for (const [name, cronExpression] of Object.entries(schedules)) {
  updateScraper(name, cronExpression);
}

function setTimeouts(file, nodeTimeouts) {
  const fullPath = path.join(root, file);
  const workflow = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  for (const [name, timeout] of Object.entries(nodeTimeouts)) {
    const node = workflow.nodes.find(candidate => candidate.name === name);
    if (!node) throw new Error(`${file}: node ${name} not found`);
    node.parameters.options = node.parameters.options || {};
    node.parameters.options.timeout = timeout;
  }
  fs.writeFileSync(fullPath, `${JSON.stringify(workflow, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, fullPath)} timeouts`);
}

setTimeouts('core/fit_scorer.json', {
  'Ollama — Score': 3600000,
  'Ollama — Retry': 3600000,
  'Build CV + Apply': 7200000
});
setTimeouts('core/cv_builder.json', {
  'Ollama — Tailor CV': 3600000,
  'Ollama — Cover Letter': 3600000,
  'Send to Executor Agent': 1800000
});
