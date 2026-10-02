"""Force one job through cv-builder → executor → apply, end-to-end.
Pushes a real job directly to /webhook/build-cv to skip the scoring step.
"""
import json, urllib.request, time, os, sys

# The two score=85 jobs from applied_jobs.json — pick the real one (Amazon)
job = {
    "company": "ASSPL - Karnataka",
    "job_title": "Operations Manager, Amazon",
    "location": "Delhi, Delhi",
    "source_platform": "linkedin_india",  # route to india-agent (LinkedIn apply)
    "job_url": "https://www.linkedin.com/jobs/view/4413566298",  # real LinkedIn URL
    "description": "Operations Manager role at Amazon (ASSPL Karnataka). Stakeholder management, process optimization, cross-functional coordination, MBA preferred. 25+ LPA.",
    "score": 85,
    "verdict": "STRONG_MATCH",
    "cv_variant": "B",
    "cover_letter_needed": True,
    "top_matches": ["Operations Manager", "AI Ops", "stakeholder management"]
}

print("=== Push to CV Builder -> Executor -> Playwright apply ===")
print(f"Job: {job['company']} | {job['job_title']}")
print(f"URL: {job['job_url']}")
print()

req = urllib.request.Request('http://127.0.0.1:5678/webhook/build-cv', method='POST',
    data=json.dumps(job).encode(), headers={'Content-Type': 'application/json'})
start = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        response = r.read().decode()
    print(f"Done in {time.time()-start:.0f}s")
    print(f"Response: {response[:500]}")
except Exception as e:
    print(f"Done in {time.time()-start:.0f}s (with error: {str(e)[:200]})")

# Check what was generated
print("\n=== Generated files ===")
output_dir = r"C:\Users\Dev\Desktop\Job Agents\job-agent\output"
files = sorted(os.listdir(output_dir), key=lambda f: os.path.getmtime(os.path.join(output_dir, f)), reverse=True)[:5]
for f in files:
    mtime = os.path.getmtime(os.path.join(output_dir, f))
    if time.time() - mtime < 600:  # last 10 minutes
        size = os.path.getsize(os.path.join(output_dir, f))
        print(f"  NEW: {f} ({size} bytes)")

# Final state of applied_jobs.json
print("\n=== applied_jobs.json final state ===")
with open(r'C:\Users\Dev\Desktop\Job Agents\job-agent\setup\applied_jobs.json', encoding='utf-8') as f:
    d = json.load(f)
print(f"Total entries: {len(d['applications'])}")
for a in d['applications'][-3:]:
    print(f"  {a.get('status','?'):25s} score={str(a.get('fit_score','-')):>4} {a.get('company','')[:25]:25s}")
