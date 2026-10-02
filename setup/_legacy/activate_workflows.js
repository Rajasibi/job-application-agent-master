// Direct SQLite activation of Job Agent workflows.
// Required because n8n v2.14.2 has no CLI active-state command.
// Run when n8n is DOWN. The `active` column controls webhook registration.

const path = require('path');
const Database = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'n8n', 'node_modules', 'better-sqlite3'));

const dbPath = path.join(process.env.USERPROFILE, '.n8n', 'database.sqlite');
console.log(`Opening: ${dbPath}`);

const db = new Database(dbPath);

const workflowIds = [
  'fit-scorer-workflow',
  'cv-builder-workflow',
  'app-logger-workflow',
  'india-agent-workflow',
  'abroad-agent-workflow',
  'tier1-agent-workflow',
  'linkedin-scraper-workflow',
  'naukri-scraper-workflow',
  'indeed-scraper-workflow',
  'wttj-scraper-workflow',
  'tier1-scraper-workflow'
];

// Check schema
const cols = db.prepare("PRAGMA table_info(workflow_entity)").all();
console.log('workflow_entity columns:', cols.map(c => c.name).join(', '));

const hasActive = cols.some(c => c.name === 'active');
if (!hasActive) {
  console.error('No "active" column found. n8n schema may have changed.');
  process.exit(1);
}

// Update each workflow to active
const stmt = db.prepare('UPDATE workflow_entity SET active = 1 WHERE id = ?');
let updated = 0;
for (const id of workflowIds) {
  const result = stmt.run(id);
  if (result.changes > 0) {
    console.log(`✓ Activated: ${id}`);
    updated++;
  } else {
    console.log(`✗ Not found: ${id}`);
  }
}

console.log(`\nActivated ${updated}/${workflowIds.length} workflows.`);

// Verify
const verify = db.prepare("SELECT id, name, active FROM workflow_entity WHERE id IN (" + workflowIds.map(() => '?').join(',') + ")").all(...workflowIds);
console.log('\nFinal state:');
for (const r of verify) {
  console.log(`  ${r.active ? 'ACTIVE  ' : 'inactive'}  ${r.id}  ${r.name}`);
}

db.close();
console.log('\nDone. Restart n8n for webhooks to register.');
