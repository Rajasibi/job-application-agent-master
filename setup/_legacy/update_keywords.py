"""Update all 5 scrapers with AI-first keywords + retain traditional roles."""
import sqlite3, json, os

conn = sqlite3.connect(os.path.join(os.environ['USERPROFILE'], '.n8n', 'database.sqlite'))
cur = conn.cursor()

# === LINKEDIN ===
linkedin_searches = [
    # AI - India
    {"query": "AI+Operations+Manager", "location": "India", "geo": "102713980", "label": "AI Ops India", "platform": "linkedin_india"},
    {"query": "AI+Project+Manager", "location": "India", "geo": "102713980", "label": "AI PM India", "platform": "linkedin_india"},
    {"query": "AI+Project+Coordinator", "location": "India", "geo": "102713980", "label": "AI PC India", "platform": "linkedin_india"},
    {"query": "AI+Customer+Success", "location": "India", "geo": "102713980", "label": "AI CS India", "platform": "linkedin_india"},
    {"query": "AI+Implementation+Specialist", "location": "India", "geo": "102713980", "label": "AI Impl India", "platform": "linkedin_india"},
    {"query": "AI+Strategy", "location": "India", "geo": "102713980", "label": "AI Strategy India", "platform": "linkedin_india"},
    {"query": "AI+Solutions", "location": "India", "geo": "102713980", "label": "AI Solutions India", "platform": "linkedin_india"},
    {"query": "AI+Adoption", "location": "India", "geo": "102713980", "label": "AI Adoption India", "platform": "linkedin_india"},
    {"query": "AI+Transformation", "location": "India", "geo": "102713980", "label": "AI Transformation India", "platform": "linkedin_india"},
    {"query": "Generative+AI", "location": "India", "geo": "102713980", "label": "Gen AI India", "platform": "linkedin_india"},
    # AI - Europe
    {"query": "AI+Operations+Manager", "location": "Europe", "geo": "91000002", "label": "AI Ops Europe", "platform": "linkedin_eu"},
    {"query": "AI+Project+Manager", "location": "Europe", "geo": "91000002", "label": "AI PM Europe", "platform": "linkedin_eu"},
    {"query": "AI+Customer+Success", "location": "Europe", "geo": "91000002", "label": "AI CS Europe", "platform": "linkedin_eu"},
    {"query": "AI+Implementation", "location": "Netherlands", "geo": "102890719", "label": "AI Impl NL", "platform": "linkedin_eu"},
    # Traditional - India
    {"query": "Customer+Success+Manager", "location": "India", "geo": "102713980", "label": "CSM India", "platform": "linkedin_india"},
    {"query": "Project+Coordinator", "location": "India", "geo": "102713980", "label": "PC India", "platform": "linkedin_india"},
    {"query": "Project+Manager", "location": "Delhi+NCR", "geo": "90009706", "label": "PM Delhi", "platform": "linkedin_india"},
    {"query": "Operations+Manager", "location": "Delhi+NCR", "geo": "90009706", "label": "Ops Delhi", "platform": "linkedin_india"},
    {"query": "Client+Operations", "location": "Delhi+NCR", "geo": "90009706", "label": "ClientOps Delhi", "platform": "linkedin_india"},
    {"query": "Business+Development+Manager+consulting", "location": "India", "geo": "102713980", "label": "BDM Consulting India", "platform": "linkedin_india"},
    # Traditional - Europe
    {"query": "Customer+Success+Manager", "location": "Europe", "geo": "91000002", "label": "CSM Europe", "platform": "linkedin_eu"},
    {"query": "Operations+Manager", "location": "Netherlands", "geo": "102890719", "label": "Ops NL", "platform": "linkedin_eu"},
    {"query": "Project+Manager", "location": "Germany", "geo": "101282230", "label": "PM Germany", "platform": "linkedin_eu"},
    {"query": "Business+Analyst", "location": "United+Kingdom", "geo": "101165590", "label": "BA UK", "platform": "linkedin_eu"},
]

linkedin_fn = "const searches = " + json.dumps(linkedin_searches) + """;
const urls = searches.map(s => ({
  url: `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${s.query}&location=${s.location}&geoId=${s.geo}&f_TPR=r86400&start=0`,
  label: s.label,
  source_platform: s.platform
}));
return urls.map(u => ({ json: u }));"""

# === NAUKRI ===
naukri_keywords = [
    "ai-operations-manager", "ai-project-manager", "ai-project-coordinator",
    "ai-customer-success", "ai-implementation-specialist", "ai-strategy-consultant",
    "ai-solutions-manager", "ai-adoption-specialist", "ai-transformation",
    "generative-ai", "ai-program-manager", "ai-consultant",
    "conversational-ai-project-manager", "ai-product-operations",
    "customer-success-manager", "project-coordinator", "client-operations",
    "operations-manager", "project-manager", "business-development-manager",
    "business-analyst",
]

naukri_fn = "const keywords = " + json.dumps(naukri_keywords) + """;
return keywords.map(k => ({
  json: {
    url: `https://www.naukri.com/jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=adv&keyword=${k}&location=delhi-ncr&pageNo=1&experience=2&exprangeFrom=2&exprangeTo=6&jobAge=1&sort=1`,
    label: k,
    source_platform: 'naukri'
  }
}));"""

# === INDEED ===
indeed_searches = [
    {"q": "AI Operations Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Project Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Customer Success", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "AI Implementation Specialist", "l": "India", "platform": "indeed_india"},
    {"q": "AI Strategy Consultant", "l": "India", "platform": "indeed_india"},
    {"q": "AI Solutions Manager", "l": "India", "platform": "indeed_india"},
    {"q": "AI Transformation Lead", "l": "India", "platform": "indeed_india"},
    {"q": "Customer Success Manager", "l": "Delhi, India", "platform": "indeed_india"},
    {"q": "Client Operations", "l": "Noida", "platform": "indeed_india"},
    {"q": "Project Coordinator", "l": "Delhi NCR", "platform": "indeed_india"},
    {"q": "Project Manager", "l": "Delhi NCR", "platform": "indeed_india"},
    {"q": "Operations Manager", "l": "Delhi NCR", "platform": "indeed_india"},
    {"q": "Business Development Manager consulting", "l": "Delhi", "platform": "indeed_india"},
    {"q": "AI Operations", "l": "Netherlands", "platform": "indeed_eu"},
    {"q": "AI Project Manager", "l": "Germany", "platform": "indeed_eu"},
    {"q": "AI Customer Success", "l": "Europe", "platform": "indeed_eu"},
    {"q": "Customer Success Manager", "l": "Netherlands", "platform": "indeed_eu"},
    {"q": "Operations Manager", "l": "Germany", "platform": "indeed_eu"},
]

indeed_fn = "const searches = " + json.dumps(indeed_searches) + """;
return searches.map(s => ({
  json: {
    url: `https://in.indeed.com/jobs?q=${encodeURIComponent(s.q)}&l=${encodeURIComponent(s.l)}&fromage=1&sort=date&limit=20`,
    source_platform: s.platform
  }
}));"""

# === WTTJ ===
wttj_searches = [
    {"query": "AI Operations", "aroundQuery": "Europe"},
    {"query": "AI Project Manager", "aroundQuery": "Europe"},
    {"query": "AI Customer Success", "aroundQuery": "Europe"},
    {"query": "AI Implementation", "aroundQuery": "Netherlands"},
    {"query": "AI Strategy", "aroundQuery": "Europe"},
    {"query": "AI Solutions", "aroundQuery": "Germany"},
    {"query": "Customer Success", "aroundQuery": "Europe"},
    {"query": "Operations Manager", "aroundQuery": "Netherlands"},
    {"query": "Project Manager", "aroundQuery": "Germany"},
    {"query": "Business Analyst", "aroundQuery": "United Kingdom"},
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
            if n.get('name') == 'Build Search URLs' or n.get('name') == 'Build Tier1 Targets':
                n['parameters']['functionCode'] = fn_code
                print(f"  {table}/{wf_id}: updated {n.get('name')}")

        new_json = json.dumps(nodes)
        if table == 'workflow_entity':
            cur.execute("UPDATE workflow_entity SET nodes = ? WHERE id = ?", (new_json, wf_id))
        else:
            cur.execute("UPDATE workflow_history SET nodes = ? WHERE workflowId = ? AND versionId = ?", (new_json, wf_id, vid))

conn.commit()
conn.close()
print("\nDone. All 4 scrapers (LinkedIn, Naukri, Indeed, WTTJ) updated.")
print("Restart n8n for changes to apply.")
