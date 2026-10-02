const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { fillIndeedForm } = require('./indeed_form');
const { loadUserProfile } = require('./user_profile');

const PROJECT_ROOT = path.join(__dirname, '..');
const USER_DATA_PATH = path.join(__dirname, '.indeed-user-data');
const RESUME_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf']);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') args.dryRun = true;
    else if (argv[index] === '--url' && argv[index + 1]) args.url = argv[++index];
  }
  return args;
}

function validateIndeedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Provide a valid HTTPS Indeed job URL.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !(hostname === 'indeed.com' || hostname.endsWith('.indeed.com'))) {
    throw new Error('Only HTTPS Indeed.com URLs are allowed.');
  }
  return parsed.toString();
}

function validateResume(profile) {
  const configuredPath = String(profile.resumePath || '').trim();
  if (!configuredPath) throw new Error('Set resumePath in profile.json to your PDF, DOC, DOCX, or RTF resume.');
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(PROJECT_ROOT, configuredPath);
  if (!RESUME_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
    throw new Error('The configured resume must be PDF, DOC, DOCX, or RTF.');
  }
  if (!fs.existsSync(resolvedPath)) throw new Error('The configured resume file does not exist.');
  return resolvedPath;
}

async function hasIndeedApplicationForm(page) {
  const forms = page.locator('form');
  for (let index = 0; index < await forms.count(); index += 1) {
    const form = forms.nth(index);
    if (!(await form.isVisible().catch(() => false))) continue;
    const text = await form.innerText().catch(() => '');
    const hasApplicationCopy = /application|resume|contact information|personal information/i.test(text);
    const hasRelevantControl = await form.locator(
      'input[type="file"], input[type="email"], input[type="tel"], input[autocomplete*="name" i], input[name*="first" i], input[name*="last" i]'
    ).count();
    if (hasApplicationCopy && hasRelevantControl > 0) return true;
  }
  return false;
}

async function waitForManualApplication(context, jobPage, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      const host = new URL(page.url()).hostname.toLowerCase();
      if ((host === 'indeed.com' || host.endsWith('.indeed.com')) && await hasIndeedApplicationForm(page)) {
        return page;
      }
    }
    if (jobPage.isClosed()) return null;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = loadUserProfile();

  if (args.dryRun) {
    let resumeReady = false;
    try { validateResume(profile); resumeReady = true; } catch {}
    const configuredFields = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'location']
      .filter(key => String(profile[key] || '').trim()).length;
    console.log(JSON.stringify({
      dryRun: true,
      browserStarted: false,
      submitActionsAvailable: false,
      configuredProfileFields: configuredFields,
      resumeReady
    }));
    return;
  }

  const jobUrl = validateIndeedUrl(args.url || '');
  const resumePath = validateResume(profile);
  profile.resumePath = resumePath;

  const context = await chromium.launchPersistentContext(USER_DATA_PATH, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1365, height: 900 }
  });
  const jobPage = context.pages()[0] || await context.newPage();

  try {
    await jobPage.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('Indeed is open. Sign in if needed, then click Apply yourself. This tool will fill configured fields only and will never submit.');
    const applicationPage = await waitForManualApplication(context, jobPage);
    if (!applicationPage) {
      console.log('No in-site Indeed application form detected within five minutes. No fields were filled.');
      return;
    }

    const result = await fillIndeedForm(applicationPage, profile, PROJECT_ROOT);
    const outputDir = path.join(PROJECT_ROOT, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, `indeed-review-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await applicationPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(JSON.stringify({
      reviewReady: true,
      filledFieldLabels: result.fields,
      unansweredQuestionLabels: result.unanswered,
      resumeUploaded: result.resumeUploaded,
      screenshotPath,
      submitActionsAvailable: false
    }, null, 2));
    console.log('Review every value in the browser. Click Submit yourself only if the answers are correct. Close the browser when finished.');
    await new Promise(resolve => context.once('close', resolve));
  } finally {
    if (!context.pages().length) return;
    await context.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Indeed review stopped: ${error.message}`);
  process.exitCode = 1;
});
