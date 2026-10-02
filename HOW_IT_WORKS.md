# How the job agent works (plain English)

Think of it as five helpers working for you on your own laptop.

1. **The scout** checks Naukri, Indeed and foundit every 4 hours, an hour apart from each other. It only looks for the roles and cities in `config/search.json`, skips anything it has already seen, and drops obvious mismatches such as internships, manager or architect titles, and Java or frontend roles.

2. **The judge** (the Qwen AI running on your laptop) reads each job description next to your profile and gives it a score out of 100. Anything below **70** is logged as REJECTED along with the reason.

3. **The writer** takes each job that scores 70 or more and tailors your CV to it. It only rephrases and reorders what is already in your CV and never invents anything. It saves the CV as a PDF, and writes a short cover letter when the job asks for one. Everything goes into `output/`.

4. **The form-filler** opens the application in a hidden browser and fills in what it knows from `profile.json`: name, email, phone, CV upload, notice period, and so on. **It never clicks Submit.** It takes a screenshot and marks the job **AWAITING_MANUAL_SUBMIT**.
   - On Naukri and foundit, clicking Apply sends the application immediately, so the agent doesn't click it at all. It only checks that the job is open and that you haven't applied already.
   - For foundit, **Review & submit** opens the job in your normal browser, because foundit blocks automated ones.

5. **The clerk** records everything in `setup/applied_jobs.json`, and in your Google Sheet if you've set one up.

## What you do

1. Double-click `START_AGENT.bat`, or let it start automatically when you log in.
2. Open the dashboard. The **Awaiting your review** tab lists the prepared applications.
3. For each one:
   - Click **Review & submit**. A browser opens with the form filled in.
   - Check every answer, fill in anything the agent flagged under "Needs answers", and click Submit on the website yourself.
   - Back in the dashboard, click **Mark submitted**, or **Skip** if you changed your mind.

## Statuses

| Status | Meaning |
|---|---|
| AWAITING_MANUAL_SUBMIT | Prepared by the agent and waiting for you |
| APPLIED | You submitted it |
| REJECTED | Scored below 70, or you skipped it |
| FAILED | Something went wrong (expired login, job closed, error). The reason is in Notes |

## Limits

- At most 30 prepared applications per site per day, and at most 15 new jobs per scraper run.
- Scoring runs on your CPU: roughly 15–90 seconds per job. Tailoring a CV takes a few minutes.
- Websites change their layouts. If one site starts failing, check its Notes and the screenshot.
