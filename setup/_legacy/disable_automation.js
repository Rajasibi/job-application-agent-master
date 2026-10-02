const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflowDirs = ['core', 'agents', 'scrapers'];
const changed = [];

function removeNodes(workflow, shouldRemove) {
  const removedNames = new Set(workflow.nodes.filter(shouldRemove).map(node => node.name));
  workflow.nodes = workflow.nodes.filter(node => !removedNames.has(node.name));
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    if (removedNames.has(source)) {
      delete workflow.connections[source];
      continue;
    }
    for (const [kind, branches] of Object.entries(outputs)) {
      outputs[kind] = branches.map(branch => branch.filter(edge => !removedNames.has(edge.node)));
    }
  }
}

for (const directory of workflowDirs) {
  const folder = path.join(root, directory);
  for (const filename of fs.readdirSync(folder).filter(name => name.endsWith('.json'))) {
    const filePath = path.join(folder, filename);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const workflows = Array.isArray(parsed) ? parsed : [parsed];

    for (const workflow of workflows) {
      workflow.active = false;
      removeNodes(workflow, node => node.type === 'n8n-nodes-base.scheduleTrigger');

      if (workflow.id === 'fit-scorer-workflow') {
        removeNodes(workflow, node => node.name === 'Trigger CV Builder');
      }
      if (workflow.id === 'cv-builder-workflow') {
        removeNodes(workflow, node => node.name === 'Trigger Executor Agent' || node.name === 'Route to Executor');
      }
      if (workflow.id === 'india-agent-workflow' || workflow.id === 'abroad-agent-workflow' || workflow.id === 'tier1-agent-workflow') {
        removeNodes(workflow, node => node.type === 'n8n-nodes-base.executeCommand' || /Run Playwright/.test(node.name || ''));
      }
    }

    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    changed.push(path.relative(root, filePath));
  }
}

console.log(`Disabled schedules, activation metadata, and automatic executor edges in ${changed.length} workflow exports.`);
for (const file of changed) console.log(file);