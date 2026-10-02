// One long-lived visible browser per site (naukri / foundit / indeed), reused by visible searches and
// visible application checks instead of starting a new browser for every job.
//
// It runs Playwright's own Chromium on that site's persistent profile (setup/profiles/<site>), with
// the DevTools port on 127.0.0.1 only, and WITH --enable-automation (the flag Playwright itself sets):
// the browser does not hide that it is automated. No stealth, spoofing or proxy.
// Scripts attach through browser_modes.launch() (connectOverCDP) using setup/profiles/<site>.cdp.json.
// The browser closes itself after `idleMs` without use.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function waitForDevtools(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('browser did not start');
}

function createKeeper({ log = () => {}, profileRoot = process.env.JOB_AGENT_PROFILE_DIR || path.join(ROOT, 'setup', 'profiles'), idleMs = 10 * 60 * 1000, chromiumPath, headless = process.env.JOB_AGENT_HEADLESS === '1' } = {}) {
  const live = {}; // site -> { proc, port, lastUsed, active }
  const SYSTEM_CHROME = process.env.JOB_AGENT_CHROMIUM_PATH;
  const exe = () => chromiumPath || SYSTEM_CHROME || require(path.join(ROOT, 'playwright', 'node_modules', 'playwright')).chromium.executablePath();
  const endpointFile = site => path.join(profileRoot, `${site}.cdp.json`);
  const alive = site => live[site] && live[site].proc.exitCode === null && !live[site].proc.killed;

  async function start(site) {
    const dir = path.join(profileRoot, site);
    fs.mkdirSync(dir, { recursive: true });
    const port = await freePort();
    const args = [
      `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--enable-automation',
      '--no-first-run', '--no-default-browser-check', '--window-size=1366,900', ...(headless ? ['--headless=new'] : []), 'about:blank'
    ];
    const proc = spawn(exe(), args, { stdio: 'ignore', windowsHide: false });
    proc.on('exit', () => { if (live[site] && live[site].proc === proc) { delete live[site]; try { fs.unlinkSync(endpointFile(site)); } catch (_) {} } });
    try {
      await waitForDevtools(port);
    } catch (e) {
      try { proc.kill(); } catch (_) {}
      throw e;
    }
    live[site] = { proc, port, lastUsed: Date.now(), active: 0 };
    fs.writeFileSync(endpointFile(site), JSON.stringify({ port, pid: proc.pid, started: new Date().toISOString() }));
    log(`browser for ${site} started (reused for its visible tasks; closes after ${Math.round(idleMs / 60000)} min idle)`);
  }

  // Runs fn while the site's browser is up (started if needed). If it can't start, fn still runs and
  // the scripts fall back to launching their own browser.
  async function use(site, fn) {
    try { if (!alive(site)) await start(site); } catch (e) { log(`browser for ${site} could not start (${e.message}); tasks launch their own`); }
    if (live[site]) { live[site].active++; live[site].lastUsed = Date.now(); }
    try { return await fn(); } finally {
      if (live[site]) { live[site].active--; live[site].lastUsed = Date.now(); }
    }
  }

  async function close(site) {
    const b = live[site];
    if (!b) return;
    try {
      const v = await waitForDevtools(b.port, 2000);
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; setTimeout(reject, 3000); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); // a normal browser shutdown (profile saved)
      await new Promise(r => setTimeout(r, 1500));
    } catch (_) {}
    // Force-kill only a browser this helper started (a stale pid could belong to another program now).
    if (!b.stale && b.proc.exitCode === null) try { b.proc.kill(); } catch (_) {}
    delete live[site];
    try { fs.unlinkSync(endpointFile(site)); } catch (_) {}
    log(`browser for ${site} closed (idle)`);
  }

  const timer = setInterval(() => {
    for (const site of Object.keys(live)) {
      if (live[site].active === 0 && Date.now() - live[site].lastUsed > idleMs) close(site);
    }
  }, 30 * 1000);
  timer.unref();

  // After a helper restart: close browsers a previous helper left running (they hold the profile).
  async function cleanupStale() {
    let files = [];
    try { files = fs.readdirSync(profileRoot).filter(f => f.endsWith('.cdp.json')); } catch (_) { return; }
    for (const f of files) {
      const site = f.replace(/\.cdp\.json$/, '');
      if (live[site]) continue;
      try {
        const { port, pid } = JSON.parse(fs.readFileSync(path.join(profileRoot, f), 'utf8'));
        live[site] = { stale: true, proc: { pid, exitCode: null, killed: false, kill: () => {} }, port, lastUsed: 0, active: 0 };
        await close(site);
      } catch (_) {
        try { fs.unlinkSync(path.join(profileRoot, f)); } catch (__) {}
      }
    }
  }

  const closeAll = () => Promise.all(Object.keys(live).map(close));
  const status = () => Object.fromEntries(Object.entries(live).map(([s, b]) => [s, { pid: b.proc.pid, active: b.active, idle_s: Math.round((Date.now() - b.lastUsed) / 1000) }]));
  return { use, close, closeAll, cleanupStale, status, endpointFile, busy: () => Object.values(live).some(b => b.active > 0) };
}

module.exports = { createKeeper };
