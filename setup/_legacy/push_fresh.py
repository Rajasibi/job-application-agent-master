"""Pull fresh Naukri jobs and push first N through fit-scorer."""
import json, urllib.request, time, sys

print("Scraping Naukri...")
req = urllib.request.Request('http://127.0.0.1:9999/scrape/naukri', method='POST',
    data=b'{}', headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(req, timeout=240) as r:
    data = json.loads(r.read())

jobs = data.get('jobs', [])
print(f"Got {len(jobs)} jobs\n")

N = 8
for i, j in enumerate(jobs[:N]):
    payload = {
        'job_title': j.get('job_title', ''),
        'company': j.get('company', ''),
        'location': j.get('location', ''),
        'description': j.get('description', '') or f"{j.get('job_title','')} at {j.get('company','')}",
        'source_platform': j.get('source_platform', 'naukri'),
        'job_url': j.get('job_url', '')
    }
    start = time.time()
    req = urllib.request.Request('http://127.0.0.1:5678/webhook/score-job', method='POST',
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            r.read()
        print(f"[{i+1}/{N}] {time.time()-start:.0f}s OK: {j.get('company','')[:25]:25s} | {j.get('job_title','')[:50]}")
    except Exception as e:
        print(f"[{i+1}/{N}] ERR: {str(e)[:120]}")

print("\nFinal applied_jobs.json:")
d = json.load(open(r'C:/Users/Dev/Desktop/Job Agents/job-agent/setup/applied_jobs.json', encoding='utf-8'))
print(f"Total: {len(d['applications'])} entries")
for a in d['applications'][-10:]:
    print(f"  {a.get('timestamp','')[:19]}  {a.get('status','')[:22]:22s} score={str(a.get('fit_score','-')):>4}  {a.get('company','')[:25]:25s}")
