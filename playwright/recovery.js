// Conditional human-assisted browser recovery.
//
// The normal Playwright flow is the default. This only does something when a browser step hits a
// challenge you can solve (Cloudflare / CAPTCHA / OTP / login). Access Denied is a hard block and is
// never sent here. NOTHING here solves, hides from, or bypasses a check: you solve it in the window.
//
//   flag JOB_AGENT_RECOVERY (default "on"): "off" -> never wait; behave as a plain challenge stop.
//   ATTENDED  = you looked at the dashboard in the last 2 min (heartbeat), or pressed "I'm at the laptop".
//     attended    -> pause, keep a checkpoint, you solve it in the reused headed browser, verify, resume.
//     unattended  -> DON'T block: save a checkpoint and stop now (SECURITY_CHALLENGE). "Resolve now"
//                    on the dashboard replays parked checkpoints one at a time while you are present.
//   One recovery attempt per checkpoint per run (a check that returns immediately isn't retried).

const fs = require('fs');
const path = require('path');
const { waitForHuman, detectChallenge } = require('./browser_modes');

const ROOT = path.join(__dirname, '..');
const dir = () => process.env.JOB_AGENT_CHECKPOINT_DIR || path.join(ROOT, 'setup', 'checkpoints');
const attendedFile = () => process.env.JOB_AGENT_ATTENDED_FILE || path.join(ROOT, 'setup', 'attended.json');
const ATTENDED_WINDOW_MS = 2 * 60 * 1000;

const enabled = () => !/^(off|false|0|no)$/i.test(process.env.JOB_AGENT_RECOVERY || 'on');
const HUMAN_SOLVABLE = new Set(['cloudflare', 'captcha', 'otp', 'login']);

function attended() {
  if (process.env.JOB_AGENT_FORCE_ATTENDED === '1') return true;
  if (process.env.JOB_AGENT_FORCE_ATTENDED === '0') return false;
  try {
    const { at } = JSON.parse(fs.readFileSync(attendedFile(), 'utf8'));
    return Date.now() - Date.parse(at) < ATTENDED_WINDOW_MS;
  } catch (_) { return false; }
}

const cpPath = id => path.join(dir(), `${String(id).replace(/[^a-z0-9_-]/gi, '_')}.json`);

function saveCheckpoint(cp) {
  fs.mkdirSync(dir(), { recursive: true });
  const full = { ...cp, created: cp.created || new Date().toISOString(), updated: new Date().toISOString() };
  fs.writeFileSync(cpPath(cp.id), JSON.stringify(full, null, 2));
  return full;
}
function loadCheckpoints() {
  try { return fs.readdirSync(dir()).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'))); } catch (_) { return []; }
}
function deleteCheckpoint(id) { try { fs.unlinkSync(cpPath(id)); } catch (_) {} }

// The page must be genuinely accessible before we resume: no challenge, same host, real content.
async function verifyAccessible(page, expectHost) {
  const ch = await detectChallenge(page);
  if (ch.kind) return false;
  try {
    if (expectHost && new URL(page.url()).hostname !== expectHost) return false;
    const len = await page.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().length : 0).catch(() => 0);
    return len >= 200;
  } catch (_) { return false; }
}

// Called at a challenge in a VISIBLE page. Returns:
//   { resumed: true }                         -> the page is clear; the caller re-does its step
//   { parked: true, checkpoint }              -> stopped; a checkpoint was saved for "Resolve now"
//   { stop: true }                            -> recovery off / not solvable; caller -> SECURITY_CHALLENGE
// ctx: { id, kind, site, job, url, cursor }
async function recover(page, challenge, ctx = {}) {
  if (!enabled() || !challenge || !HUMAN_SOLVABLE.has(challenge.kind)) return { stop: true };
  const id = ctx.id || ctx.url || `cp_${Date.now()}`;
  const checkpoint = saveCheckpoint({
    id, kind: ctx.kind || 'job_page', site: ctx.site || '', url: ctx.url || page.url(),
    job: ctx.job || null, cursor: ctx.cursor || null, challenge: challenge.kind
  });
  if (!attended()) return { parked: true, checkpoint };

  const target = ctx.url || page.url();
  const ok = await waitForHuman(page, challenge, { site: ctx.site || '', task: ctx.kind || 'recovery' });
  if (ok) {
    if (page.url() !== target) await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (await verifyAccessible(page, safeHost(target))) { deleteCheckpoint(id); return { resumed: true }; }
  }
  return { parked: true, checkpoint }; // did not clear / could not verify: leave it for "Resolve now"
}

function safeHost(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }

module.exports = { recover, attended, enabled, saveCheckpoint, loadCheckpoints, deleteCheckpoint, verifyAccessible, cpPath, HUMAN_SOLVABLE };
