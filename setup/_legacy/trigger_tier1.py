"""Push a real Tier 1 job through full pipeline to populate the Tier 1 queue."""
import json, urllib.request, time, os

# Pick an EY job from the live scrape - one that scores well
job = {
    "company": "EY",
    "job_title": "Senior Project Manager - Business Consulting",
    "location": "India",
    "source_platform": "tier1_ey",  # router will detect 'ey' and route to apply-tier1
    "job_url": "https://careers.ey.com/ey/job/New-Delhi-Senior-Project-Manager-Business-Consulting-PI-TMT-CNS-BC-FINANCE/1290659902/",
    "description": "Senior Project Manager - Business Consulting at EY New Delhi. TMT (Technology, Media & Telecom) practice. Manage multi-stakeholder client engagements, deliver consulting projects on time and budget, mentor junior consultants. MBA preferred. 5+ years experience. 25-35 LPA.",
    "score": 88,
    "verdict": "STRONG_MATCH",
    "cv_variant": "A",
    "cover_letter_needed": True,
    "top_matches": ["Senior Project Manager", "Business Consulting", "stakeholder management"]
}

print("=== Push EY job through cv-builder -> Tier 1 queue ===")
print(f"Job: {job['company']} | {job['job_title']}")
print()

req = urllib.request.Request('http://127.0.0.1:5678/webhook/build-cv', method='POST',
    data=json.dumps(job).encode(), headers={'Content-Type': 'application/json'})
start = time.time()
try:
    with urllib.request.urlopen(req, timeout=1000) as r:
        response = r.read().decode()
    print(f"Done in {time.time()-start:.0f}s")
    print(f"Response: {response[:300]}")
except Exception as e:
    print(f"Done in {time.time()-start:.0f}s (Error: {str(e)[:200]})")

print()
print("=== Tier 1 queue after run ===")
try:
    with urllib.request.urlopen('http://127.0.0.1:9999/tier1-pending') as r:
        d = json.loads(r.read())
    items = d.get('pending', [])
    print(f"Total items in queue: {len(items)}")
    for x in items:
        print(f"  {x.get('status','?'):10s} {x.get('company','')[:15]:15s} | {x.get('job_title','')[:60]}")
        print(f"    CV: {x.get('tailoredCvPath','(none)')[:80]}")
        print(f"    CL: {x.get('coverLetterPath','(none)')[:80]}")
except Exception as e:
    print(f"queue check failed: {e}")
