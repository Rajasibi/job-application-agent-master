"""Scrape Naukri, push first 5 jobs through fit-scorer webhook, show dashboard data."""
import json, urllib.request, time, os, sys

print("=== Step 1: Scrape Naukri (60-90s) ===")
req = urllib.request.Request('http://127.0.0.1:9999/scrape/naukri', method='POST',
    data=b'{}', headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(req, timeout=240) as r:
    data = json.loads(r.read())

jobs = data.get('jobs', [])
print(f"Got {len(jobs)} jobs from Naukri")
if not jobs:
    sys.exit("No jobs scraped")

print("\n=== Step 2: Push first 5 jobs through fit-scorer (~7-10 min) ===")
for i, job in enumerate(jobs[:5]):
    payload = {
        'job_title': job.get('job_title', ''),
        'company': job.get('company', ''),
        'location': job.get('location', ''),
        'description': job.get('description', '') or f"{job.get('job_title','')} at {job.get('company','')}",
        'source_platform': job.get('source_platform', 'naukri'),
        'job_url': job.get('job_url', '')
    }
    start = time.time()
    req = urllib.request.Request('http://127.0.0.1:5678/webhook/score-job', method='POST',
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            response = r.read().decode()
        elapsed = time.time() - start
        print(f"  [{i+1}/5] {elapsed:.0f}s: {job.get('company','?')[:25]:25s} | {job.get('job_title','?')[:50]}")
    except Exception as e:
        print(f"  [{i+1}/5] ERR: {str(e)[:120]}")

print("\n=== Step 3: applied_jobs.json contents ===")
log_path = r"C:\Users\Dev\Desktop\Job Agents\job-agent\setup\applied_jobs.json"
if os.path.exists(log_path):
    with open(log_path, encoding='utf-8') as f:
        d = json.load(f)
    print(f"Total entries: {len(d['applications'])}")
    for a in d['applications']:
        print(f"  {a.get('status','?'):25s} score={str(a.get('fit_score','-')):4s} {a.get('company','')[:25]:25s} {a.get('job_title','')[:50]}")
else:
    print("applied_jobs.json STILL not created - Log Score node may not be firing")
