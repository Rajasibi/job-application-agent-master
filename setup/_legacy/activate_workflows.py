"""Legacy activation entry point, intentionally disabled for manual-review mode."""
import sqlite3
import os
import json
import sys
import uuid

sys.exit(
    "Workflow activation is disabled. The Indeed project mode is manual-review only; "
    "do not enable scheduled or executor workflows."
)

db_path = os.path.join(os.environ['USERPROFILE'], '.n8n', 'database.sqlite')
print(f"Opening: {db_path}")
if not os.path.exists(db_path):
    sys.exit(f"DB not found: {db_path}")

JOB_AGENT_WEBHOOKS = [
    ('fit-scorer-workflow', 'score-job'),
    ('cv-builder-workflow', 'build-cv'),
    ('app-logger-workflow', 'log-application'),
    ('india-agent-workflow', 'apply-india'),
    ('abroad-agent-workflow', 'apply-abroad'),
    ('tier1-agent-workflow', 'apply-tier1'),
]

ALL_WORKFLOW_IDS = [w[0] for w in JOB_AGENT_WEBHOOKS] + [
    'linkedin-scraper-workflow',
    'naukri-scraper-workflow',
    'indeed-scraper-workflow',
    'wttj-scraper-workflow',
    'tier1-scraper-workflow',
]

REMOVED_NODE_TYPES = {
    'n8n-nodes-base.executeCommand': 'n8n-nodes-base.httpRequest',
}

def fix_nodes(nodes):
    """Apply all fixes to a nodes list. Returns (new_nodes, changed)."""
    changed = False
    for n in nodes:
        # Fix 1: webhook node typeVersion + webhookId
        if n.get('type') == 'n8n-nodes-base.webhook':
            if n.get('typeVersion') != 2.1:
                n['typeVersion'] = 2.1
                changed = True
            if not n.get('webhookId'):
                n['webhookId'] = str(uuid.uuid4())
                changed = True
        # Fix 2: replace removed node types
        if n.get('type') in REMOVED_NODE_TYPES:
            old_type = n.get('type')
            n['type'] = REMOVED_NODE_TYPES[old_type]
            n['typeVersion'] = 4
            cmd = n.get('parameters', {}).get('command', '')
            n['parameters'] = {
                'method': 'POST',
                'url': 'http://localhost:9999/run-command',
                'sendBody': True,
                'specifyBody': 'json',
                'jsonBody': json.dumps({'command': cmd}),
                'options': {'timeout': 600000}
            }
            n['notes'] = f"WARNING: executeCommand removed in n8n v2. Original command: {cmd}\nNeeds replacement: install community node OR run a local helper webhook."
            changed = True
    return nodes, changed

conn = sqlite3.connect(db_path)
cur = conn.cursor()

print("\n=== Step 1: Fix workflow_entity nodes + active flag ===")
for wf_id in ALL_WORKFLOW_IDS:
    cur.execute("SELECT versionId, nodes FROM workflow_entity WHERE id = ?", (wf_id,))
    r = cur.fetchone()
    if not r:
        print(f"  MISS {wf_id}")
        continue
    version_id, nodes_json = r
    nodes = json.loads(nodes_json)
    nodes, changed = fix_nodes(nodes)
    cur.execute(
        "UPDATE workflow_entity SET nodes = ?, active = 1, activeVersionId = ? WHERE id = ?",
        (json.dumps(nodes), version_id, wf_id)
    )
    print(f"  OK   {wf_id} (changed={changed})")

print("\n=== Step 2: Fix workflow_history nodes for activeVersionId ===")
for wf_id in ALL_WORKFLOW_IDS:
    cur.execute("SELECT activeVersionId, nodes FROM workflow_entity WHERE id = ?", (wf_id,))
    r = cur.fetchone()
    if not r:
        continue
    active_vid, current_nodes = r
    # Update workflow_history row for the active version with the corrected nodes
    cur.execute(
        "UPDATE workflow_history SET nodes = ? WHERE workflowId = ? AND versionId = ?",
        (current_nodes, wf_id, active_vid)
    )
    rows = cur.rowcount
    print(f"  {wf_id}: updated {rows} history row(s) for version {active_vid[:8]}")

print("\n=== Step 3: Register webhook routes ===")
for wf_id, _ in JOB_AGENT_WEBHOOKS:
    cur.execute("DELETE FROM webhook_entity WHERE workflowId = ?", (wf_id,))

for wf_id, path in JOB_AGENT_WEBHOOKS:
    cur.execute("SELECT nodes FROM workflow_entity WHERE id = ?", (wf_id,))
    nodes = json.loads(cur.fetchone()[0])
    webhook_node = next((n for n in nodes if n.get('type') == 'n8n-nodes-base.webhook'), None)
    if not webhook_node:
        continue
    try:
        cur.execute(
            "INSERT INTO webhook_entity (workflowId, webhookPath, method, node, webhookId, pathLength) VALUES (?, ?, ?, ?, ?, NULL)",
            (wf_id, path, 'POST', webhook_node['name'], webhook_node.get('webhookId'))
        )
        print(f"  OK   POST /{path} -> {wf_id}")
    except Exception as e:
        print(f"  ERR  {path}: {e}")

conn.commit()
conn.close()
print("\nDone. Restart n8n.")
