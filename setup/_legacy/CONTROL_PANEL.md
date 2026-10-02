# Job Agent — Control Panel

> Everything you need to know, in one place. Last updated: 2026-05-07

---

## Are you fully automated?

**YES.** From this point on, you do nothing. The agent applies for you every day.

The only manual step left: clicking "Submit" on Tier 1 form-fills (Capgemini/Accenture/JLL/CBRE/EY) — you wanted that gate.

---

## How to see what jobs were applied to

### Option A — Local Dashboard (no setup)

Double-click: `dashboard\OPEN_DASHBOARD.bat`

Opens in your browser. Shows:
- Total applications
- Applied / Failed / Awaiting Submit / Today counts
- Filterable table: company, role, platform, score, status, link
- Auto-refreshes every 30 seconds

### Option B — CLI summary

```bash
node "C:\Users\Dev\Desktop\Job Agents\job-agent\playwright\application_log.js" stats
node "C:\Users\Dev\Desktop\Job Agents\job-agent\playwright\application_log.js" list
```

### Option C — Raw data

`setup\applied_jobs.json` — JSON file with every application attempt

### Option D — Generated CVs and cover letters

`output\` folder — every tailored CV and cover letter saved per job

---

## What kinds of jobs will the agent apply for?

### Search keywords (per platform)

**LinkedIn (every 4 hours):**
- Customer Success Manager (India + Europe)
- Project Coordinator (India)
- Operations Manager (Delhi NCR + Netherlands)
- Business Development Manager (consulting, India)
- Project Manager (Germany)
- Business Analyst (UK)

**Naukri.com (every 4 hours, Delhi NCR only):**
- customer-success-manager
- project-coordinator
- client-operations
- operations-manager
- business-development-manager
- account-manager
- business-analyst

**Indeed (every 4 hours):**
- Customer Success Manager (India + Netherlands + Germany + Europe remote)
- Client Operations (Noida)
- Project Coordinator (Delhi NCR)
- Business Development Manager (consulting, Delhi)

**Welcome to the Jungle (every 6 hours, Europe focus):**
- Customer Success (Europe)
- Operations Manager (Netherlands)
- Project Manager (Germany)
- Business Development (Europe)
- Business Analyst (UK)

**Tier 1 career pages (every 6 hours):**
- Capgemini India career page
- Accenture India career page
- JLL India career page
- CBRE India career page
- EY India career page
- Filters: customer success, operations, coordinator, project, business development, client, account manager

---

## Filtering criteria (the AI Judge)

Every job found is scored 0–100 by Llama 3.2. **Only 70+ scoring jobs get applied to.**

### Hard filters (instant REJECT regardless of other factors)

- **Salary below 10 LPA** (in India) — automatic reject
- **Pure technical coding roles** (Software Engineer, Data Scientist, ML Engineer) — Dev is non-technical
- **Pure real estate sales** (channel partner, broker)
- **Cold calling / telesales / data entry**

### Bonus points (raise the score)

- AI-related operational roles (AI Operations, AI Customer Success, AI Project Coordinator)
- Roles at known AI companies (OpenAI, Anthropic, Cohere, Hugging Face, etc.)
- Europe-friendly companies (EU offices, EU transfer paths, remote-first EU)

### Score → action mapping

| Score | Verdict | Action |
|---|---|---|
| 85–100 | STRONG_MATCH | Auto-apply |
| 70–84 | GOOD_MATCH | Auto-apply |
| Below 70 | REJECT | Discard, log only |

---

## The 3 executor agents — your matrix

You guessed correctly:

| Agent | Handles | Behavior |
|---|---|---|
| **India Agent** | Naukri, LinkedIn India, Indeed India | Auto-applies fully |
| **Abroad Agent** | LinkedIn EU, WTTJ, Indeed EU/Netherlands/Germany/UK | Auto-applies fully WITH cover letter |
| **Tier 1 Agent** | Capgemini, Accenture, JLL, CBRE, EY | Fills form + screenshots + STOPS for your manual submit |

The router (inside `core/cv_builder.json`) sends each job to the right agent based on `source_platform`.

---

## How to edit criteria

### Change the score threshold (currently 70+)

File: `prompts\fit_scorer.md`

Find: `- below 70 → REJECT`
Edit the number wherever it appears.

Then run: `python "C:\Users\Dev\Desktop\Job Agents\job-agent\setup\activate_workflows.py"` (re-syncs the prompt into the workflow)

### Change the minimum salary (currently 10 LPA)

File: `prompts\fit_scorer.md`

Find: `HARD MINIMUM SALARY: 10 LPA`
Change to your target. Then re-sync as above.

Also update: `.env` → `MIN_SALARY_LPA=10`

### Add or remove search keywords

These are inside the n8n workflow JSONs. Easiest editing:

1. Open n8n UI: http://localhost:5678
2. Go to: Workflows → "Scraper — LinkedIn Jobs" (or any other scraper)
3. Click the "Build Search URLs" Function node
4. Edit the `searches` array — add/remove entries
5. Save (Ctrl+S)

Same for Naukri, Indeed, WTTJ, Tier 1 scrapers. No restart needed.

### Add new target companies to Tier 1

Open n8n UI → "Scraper — Tier 1 Career Pages" → "Build Tier1 Targets" Function node.

Add a new entry to the `targets` array:
```js
{
  company: 'Microsoft',
  url: 'https://careers.microsoft.com/...search...india...'
}
```

### Edit your CV variants

Files:
- `cv\cv_variant_a.md` — operations-heavy (default for most roles)
- `cv\cv_variant_b.md` — AI/automation-heavy (for tech/consulting roles)

Edit normally in any text editor. Llama uses these as the base for tailoring.

### Edit the AI's voice for cover letters

File: `prompts\cover_letter.md`

Change tone, structure, sign-off, anything. Llama follows this prompt for every cover letter.

### Change daily rate limit (currently 30/platform/day)

File: `playwright\application_log.js`

Find: `const DAILY_LIMIT = 30;`
Change the number. Saves you from LinkedIn flagging if you raise it too much.

---

## Schedule

| Scraper | Frequency | When in your day (rough) |
|---|---|---|
| LinkedIn | Every 4 hours | 6 times/day |
| Naukri | Every 4 hours | 6 times/day |
| Indeed | Every 4 hours | 6 times/day |
| WTTJ | Every 6 hours | 4 times/day |
| Tier 1 | Every 6 hours | 4 times/day |

Total scrape runs per day: ~26.

Each run: ~5–20 new jobs found. Of those, ~10–20% pass the 70+ threshold. So expect ~10–30 applications per day.

Daily cap: 30 per platform (so max ~150/day across all 5 platforms). Set this lower if you want to be more selective.

---

## Files reference (where things live)

```
job-agent/
├── CONTROL_PANEL.md         <-- This file (your reference)
├── HOW_IT_WORKS.md          <-- Plain English explanation
├── SETUP_GUIDE.md           <-- Initial setup steps
├── README.md                <-- Technical README
│
├── cv/
│   ├── cv_variant_a.md      <-- EDIT: ops-heavy CV
│   ├── cv_variant_b.md      <-- EDIT: AI-heavy CV
│   └── master_profile.md    <-- DON'T EDIT (AI reference)
│
├── prompts/
│   ├── fit_scorer.md        <-- EDIT: score criteria, salary floor, threshold
│   ├── cv_tailor.md         <-- EDIT: CV tailoring rules
│   └── cover_letter.md      <-- EDIT: cover letter voice
│
├── playwright/
│   ├── linkedin_apply.js    <-- LinkedIn auto-apply
│   ├── naukri_apply.js      <-- Naukri auto-apply
│   ├── tier1_form_fill.js   <-- Tier 1 fill (no submit)
│   ├── application_log.js   <-- EDIT: rate limit, dedup
│   ├── linkedin_auth.json   <-- DON'T COMMIT (your session)
│   └── naukri_auth.json     <-- DON'T COMMIT (your session)
│
├── core/                    <-- n8n workflow definitions (rarely edit directly)
├── agents/                  <-- n8n executor workflows
├── scrapers/                <-- n8n scraper workflows
│
├── output/                  <-- Generated CVs, cover letters, screenshots
├── helper-service/          <-- Playwright command runner (port 9999)
│
├── dashboard/
│   ├── local.html           <-- Your local dashboard
│   └── OPEN_DASHBOARD.bat   <-- Double-click to open dashboard
│
└── setup/
    ├── applied_jobs.json    <-- Application log
    ├── activate_workflows.py <-- Re-syncs n8n DB (run after edits)
    ├── start_n8n_master.bat <-- Boot script
    ├── LOGIN_ONCE.bat       <-- Re-run when LinkedIn logs you out
    └── FOREVER_FIX.bat      <-- Already used (one-time admin fix)
```

---

## Daily routine (your part)

1. **Open dashboard** in the morning to see overnight applications: double-click `dashboard\OPEN_DASHBOARD.bat`
2. **Click submit on Tier 1 forms** (when you see new screenshots in `output\` named `tier1_*`)
3. **Re-run LOGIN_ONCE.bat** if applications start failing (~once a month)

That's it. No other manual work.

---

## Three "say the word" enhancements waiting

- **"Build the 15-day follow-up watcher"** — auto-nudge after 15 days no reply
- **"Add WhatsApp notification"** — get pinged when Tier 1 form ready
- **"Set up Google Sheets credentials"** — also log to cloud sheet (currently local only)
