# Setup Guide — For Dev (Plain English)

## Part 1: Fix the auto-start (one-time, ever)

### Will Soul in Motion break? **No.** Here's exactly what changes:

| Soul in Motion property | Before | After |
|---|---|---|
| Auto-starts at boot | ✅ Yes | ✅ Yes (unchanged) |
| Runs `start_n8n.bat` | ✅ Yes | ✅ Yes (unchanged) |
| Owns n8n on port 5678 | ✅ Yes | ✅ Yes (unchanged) |
| LinkedIn workflows work | ✅ Yes | ✅ Yes (unchanged) |
| Runs as admin (elevated) | ✅ Yes | ❌ Normal user |

Only the last row changes. Soul in Motion doesn't need admin to post on LinkedIn — it just needs n8n running. So removing admin doesn't affect anything.

### Steps (like you're 5)

1. Press `Windows + E` (opens File Explorer)
2. Paste in the address bar: `C:\Users\Dev\Desktop\Job Agents\job-agent\setup`
3. Find `FIX_AUTOSTART_ONCE.bat`
4. **Right-click it → "Run as administrator"**
5. Click **"Yes"** on the blue Windows popup
6. Watch the black window. When it says *"ALL DONE"*, press any key.
7. You never need to run this again.

---

## Part 2: Create your Google Sheet (so dashboard has data)

### Step 1 — Create the sheet
1. Open https://sheets.google.com
2. Click the big colorful **"+"** button (Blank spreadsheet)
3. Top-left, click "Untitled spreadsheet" and rename to: **`Job Applications`**

### Step 2 — Rename the tab + add headers
1. Bottom-left, where it says "Sheet1", **right-click → Rename → type `Applications`** (capital A, must match exactly)
2. In **Row 1**, paste these headers exactly (paste in cell A1, Google spreads them across):

```
Timestamp	Company	Job Title	Platform	Location	Fit Score	CV Variant	Cover Letter	Status	Job URL	Notes
```

### Step 3 — Make it public-readable
1. Top-right → click green **"Share"** button
2. Under "General access" change **"Restricted"** to **"Anyone with the link"**
3. Make sure dropdown shows **"Viewer"** (not Editor)
4. Click **Done**

### Step 4 — Get the Sheet ID
Your browser URL looks like:
```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABC/edit#gid=0
```

The Sheet ID is the long string between `/d/` and `/edit`. **Copy it. Save it in a notes app.**

---

## Part 3: Open the Dashboard

1. Press `Windows + E`
2. Paste in address bar: `C:\Users\Dev\Desktop\Job Agents\job-agent\dashboard`
3. **Double-click `index.html`** — opens in Chrome
4. Top of page: a "Sheet ID" input box
5. **Paste your Sheet ID** there
6. Click **"Save & Load"**

The dashboard is now linked. Empty until first application — that's normal.

---

## Part 4: What "live" means right now

After Part 1 above, every 4 hours:

✅ 5 scrapers search LinkedIn / Naukri / Indeed / WTTJ / Tier 1 sites
✅ Qwen AI scores each found job 0-100 against your CV
✅ Score 70+: tailored CV + cover letter saved to `output/`
✅ Score 70+: auto-application via Playwright Chrome (silent background)
✅ Tier 1 (Capgemini/Accenture/JLL/CBRE/EY): form filled + screenshot, **you click submit yourself**

You do nothing. System runs while you sleep.

---

## Part 5: The action checklist

| # | Action | Time |
|---|---|---|
| 1 | Run `FIX_AUTOSTART_ONCE.bat` as admin | 30 sec |
| 2 | Create the Google Sheet (Part 2) | 2 min |
| 3 | Open dashboard, paste Sheet ID | 30 sec |
| 4 | Open http://localhost:5678 to verify all workflows are green | 30 sec |
| 5 | Done. Go live your life. | — |

---

## Future enhancements (just say the word)

- **"Set up Google Sheets credentials"** — n8n writes to the sheet directly, full cloud logging
- **"Build the follow-up watcher"** — auto-follow-up on jobs after 15 days no reply
- **"Add WhatsApp/Email notification"** — get pinged when a Tier 1 form is ready for your manual submit

---

## Files reference

| File | Purpose |
|---|---|
| `HOW_IT_WORKS.md` | Plain-English explanation of all 5 robots |
| `SETUP_GUIDE.md` | This file |
| `README.md` | Technical setup |
| `setup/FIX_AUTOSTART_ONCE.bat` | One-time admin fix for n8n auto-start |
| `setup/KILL_AND_RESTART_N8N.bat` | Manual restart helper if needed |
| `setup/install.sh` | Full install (Playwright, Chromium, output dir) |
| `setup/test_scorer.js` | Verify the AI scorer works end-to-end |
| `dashboard/index.html` | Live dashboard (reads Google Sheet via CSV) |
| `cv/cv_variant_a.md` | Operations-heavy CV (default) |
| `cv/cv_variant_b.md` | AI/Automation-heavy CV |
| `prompts/fit_scorer.md` | What the AI Judge looks for |
| `prompts/cv_tailor.md` | CV tailoring rules |
| `prompts/cover_letter.md` | Your voice for cover letters |
