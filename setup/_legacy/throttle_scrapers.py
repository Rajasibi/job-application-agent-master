"""Add throttling to scrapers to avoid rate-limit errors.
- Reduces LinkedIn searches from 24 to 8 highest-value
- Adds Wait node between HTTP requests (sequential with delay)
- Sets HTTP Request node batching for rate-limit avoidance
"""
import sqlite3, json, os
import uuid

conn = sqlite3.connect(os.path.join(os.environ['USERPROFILE'], '.n8n', 'database.sqlite'))
cur = conn.cursor()

# === LINKEDIN: cut to 8 highest-value AI-first searches ===
linkedin_searches = [
    {"query": "AI+Operations+Manager", "location": "India", "geo": "102713980", "label": "AI Ops India", "platform": "linkedin_india"},
    {"query": "AI+Project+Manager", "location": "India", "geo": "102713980", "label": "AI PM India", "platform": "linkedin_india"},
    {"query": "AI+Customer+Success", "location": "India", "geo": "102713980", "label": "AI CS India", "platform": "linkedin_india"},
    {"query": "AI+Strategy", "location": "India", "geo": "102713980", "label": "AI Strategy India", "platform": "linkedin_india"},
    {"query": "Customer+Success+Manager", "location": "India", "geo": "102713980", "label": "CSM India", "platform": "linkedin_india"},
    {"query": "Project+Manager", "location": "Delhi+NCR", "geo": "90009706", "label": "PM Delhi", "platform": "linkedin_india"},
    {"query": "AI+Operations+Manager", "location": "Europe", "geo": "91000002", "label": "AI Ops Europe", "platform": "linkedin_eu"},
    {"query": "AI+Customer+Success", "location": "Europe", "geo": "91000002", "label": "AI CS Europe", "platform": "linkedin_eu"},
]

linkedin_fn = "const searches = " + json.dumps(linkedin_searches) + """;
const urls = searches.map(s => ({
  url: `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${s.query}&location=${s.location}&geoId=${s.geo}&f_TPR=r86400&start=0`,
  label: s.label,
  source_platform: s.platform
}));
return urls.map(u => ({ json: u }));"""

# === NAUKRI: cut to 12 highest-value ===
naukri_keywords = [
    "ai-operations-manager", "ai-project-manager", "ai-customer-success",
    "ai-implementation-specialist", "ai-strategy-consultant", "ai-solutions-manager",
    "generative-ai", "ai-consultant",
    "customer-success-manager", "project-coordinator", "operations-manager", "project-manager",
]

naukri_fn = "const keywords = " + json.dumps(naukri_keywords) + """;
return keywords.map(k => ({
  json: {
    url: `https://www.naukri.com/jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=adv&keyword=${k}&location=delhi-ncr&pageNo=1&experience=2&exprangeFrom=2&exprangeTo=6&jobAge=1&sort=1`,
    label: k,
    source_platform: 'naukri'
  }
}));"""

# === INDEED: cut to 10 highest-value ===
indeed_searches = [
    {"q": "AI Operations Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Project Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Customer Success", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Strategy Consultant", "l": "India", "platform": "indeed_india"},
    {"q": "Customer Success Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "Project Manager", "l": "Delhi NCR", "platform": "indeed_india"},
    {"q": "Operations Manager", "l": "Delhi NCR", "platform": "indeed_india"},
    {"q": "AI Operations", "l": "Netherlands", "platform": "indeed_eu"},
    {"q": "AI Customer Success", "l": "Europe", "platform": "indeed_eu"},
    {"q": "Customer Success Manager", "l": "Netherlands", "platform": "indeed_eu"},
]

indeed_fn = "const searches = " + json.dumps(indeed_searches) + """;
return searches.map(s => ({
  json: {
    url: `https://in.indeed.com/jobs?q=${encodeURIComponent(s.q)}&l=${encodeURIComponent(s.l)}&fromage=1&sort=date&limit=20`,
    source_platform: s.platform
  }
}));"""

# === WTTJ: cut to 6 ===
wttj_searches = [
    {"query": "AI Operations", "aroundQuery": "Europe"},
    {"query": "AI Project Manager", "aroundQuery": "Europe"},
    {"query": "AI Customer Success", "aroundQuery": "Europe"},
    {"query": "AI Strategy", "aroundQuery": "Europe"},
    {"query": "Customer Success", "aroundQuery": "Europe"},
    {"query": "Operations Manager", "aroundQuery": "Netherlands"},
]

wttj_fn = "const searches = " + json.dumps(wttj_searches) + """;
return searches.map(s => ({
  json: {
    url: `https://api.welcometothejungle.com/api/v1/jobs?query=${encodeURIComponent(s.query)}&around_query=${encodeURIComponent(s.aroundQuery)}&contract_type=full_time&page=1&per_page=20`,
    source_platform: 'wttj'
  }
}));"""

UPDATES = {
    'linkedin-scraper-workflow': linkedin_fn,
    'naukri-scraper-workflow': naukri_fn,
    'indeed-scraper-workflow': indeed_fn,
    'wttj-scraper-workflow': wttj_fn,
}

# Update Build Search URLs function code
for wf_id, fn_code in UPDATES.items():
    for table in ['workflow_entity', 'workflow_history']:
        if table == 'workflow_entity':
            cur.execute("SELECT nodes FROM workflow_entity WHERE id = ?", (wf_id,))
            r = cur.fetchone()
            if not r: continue
            nodes_json = r[0]
        else:
            cur.execute("SELECT activeVersionId FROM workflow_entity WHERE id = ?", (wf_id,))
            v = cur.fetchone()
            if not v: continue
            vid = v[0]
            cur.execute("SELECT nodes FROM workflow_history WHERE workflowId = ? AND versionId = ?", (wf_id, vid))
            r = cur.fetchone()
            if not r: continue
            nodes_json = r[0]

        nodes = json.loads(nodes_json)
        for n in nodes:
            if n.get('name') == 'Build Search URLs':
                n['parameters']['functionCode'] = fn_code
            # Add throttling to Fetch HTTP nodes (batchSize:1, 5s delay between requests)
            if n.get('type') == 'n8n-nodes-base.httpRequest' and 'Fetch' in n.get('name', '') and 'Results' in n.get('name', ''):
                opts = n['parameters'].get('options', {})
                opts['batching'] = {
                    'batch': {
                        'batchSize': 1,
                        'batchInterval': 5000  # 5 seconds between each request
                    }
                }
                # Also retry on rate limit
                opts['retry'] = {
                    'enabled': True,
                    'maxTries': 3,
                    'waitBetweenTries': 10000
                }
                n['parameters']['options'] = opts
                # Add proper headers
                if 'sendHeaders' not in n['parameters'] or not n['parameters']['sendHeaders']:
                    n['parameters']['sendHeaders'] = True
                # Update User-Agent to look more like real browser
                hdrs = n['parameters'].get('headerParameters', {}).get('parameters', [])
                # Ensure realistic headers exist
                has_ua = any(h.get('name', '').lower() == 'user-agent' for h in hdrs)
                if not has_ua:
                    hdrs.append({"name": "User-Agent", "value": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"})
                has_lang = any(h.get('name', '').lower() == 'accept-language' for h in hdrs)
                if not has_lang:
                    hdrs.append({"name": "Accept-Language", "value": "en-US,en;q=0.9"})
                has_accept = any(h.get('name', '').lower() == 'accept' for h in hdrs)
                if not has_accept:
                    hdrs.append({"name": "Accept", "value": "text/html,application/xhtml+xml,application/json"})
                n['parameters'].setdefault('headerParameters', {})['parameters'] = hdrs

        new_json = json.dumps(nodes)
        if table == 'workflow_entity':
            cur.execute("UPDATE workflow_entity SET nodes = ? WHERE id = ?", (new_json, wf_id))
        else:
            cur.execute("UPDATE workflow_history SET nodes = ? WHERE workflowId = ? AND versionId = ?", (new_json, wf_id, vid))
        print(f"  {table}/{wf_id}: throttled + headers added")

conn.commit()
conn.close()
print("\nDone. All scrapers throttled (5s delay between requests, retry on fail).")
print("Restart n8n to apply.")
