// Background Google Sheets sync for the application log.
//
// enqueue(record) is instant and never throws: records go into a small outbox file
// (setup/sheets_outbox.json, one entry per job URL, latest wins). A worker flushes the
// outbox every few seconds and upserts rows by Job URL, so repeats never create
// duplicates. If Google is slow or down, entries stay queued and are retried with
// backoff (30 s doubling up to 15 min); the job agent itself is never blocked.
//
// Auth: a service-account JSON key file (never logged). The private key is only used
// in memory to sign a short-lived OAuth token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Columns after the original 11 (Next action, Source, Security status, Checkpoint) are added to the
// header once, in place, without disturbing existing rows.
const COLUMNS = ['Timestamp', 'Company', 'Job Title', 'Platform', 'Location', 'Fit Score', 'CV Variant', 'Cover Letter', 'Status', 'Job URL', 'Notes', 'Next action', 'Source', 'Security status', 'Checkpoint'];
const ORIGINAL_COLUMNS = COLUMNS.slice(0, 11);
const LAST_COL = 'O';
const TAB = 'Applications';
const TICK_MS = 15 * 1000;
const PUSH_DELAY_MS = 2000; // a new status reaches the Sheet ~2 s after it happens
const MIN_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

function rowFor(r) {
  return [
    r.updated_at || r.timestamp || '',
    r.company || '',
    r.job_title || '',
    r.platform || '',
    r.location || '',
    r.fit_score ?? '',
    r.cv_variant || '',
    r.cover_letter || '',
    r.status || '',
    r.job_url,
    r.notes || '',
    r.next_action || '',
    r.source || r.discovered_via || '',
    r.security_status || '',
    r.checkpoint_status || ''
  ].map(v => (v === null || v === undefined ? '' : String(v)));
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function createSheetsSync({ sheetId, keyFile, outboxPath, log = () => {}, baseUrl = 'https://sheets.googleapis.com', tokenUrl }) {
  let key = null;
  let token = null;
  let tokenExp = 0;
  let timer = null;
  let pushTimer = null;
  let flushing = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let lastSyncAt = null;
  let lastError = null;
  let headerChecked = false;

  const configured = !!(sheetId && keyFile && fs.existsSync(keyFile));

  // ---------- outbox (persisted, keyed by job URL) ----------
  function loadOutbox() {
    try { return JSON.parse(fs.readFileSync(outboxPath, 'utf8')) || {}; } catch (_) { return {}; }
  }
  function saveOutbox(ob) {
    fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
    const tmp = `${outboxPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ob));
    fs.renameSync(tmp, outboxPath);
  }

  function enqueue(record) {
    try {
      if (!configured || !record || !record.job_url) return;
      const ob = loadOutbox();
      ob[record.job_url] = { row: rowFor(record), v: record.updated_at || new Date().toISOString() };
      saveOutbox(ob);
      // New work: allow an early attempt unless we're backing off after failures, and push it in
      // ~2 s (several stage changes in a row go in one batch).
      if (!failures) {
        nextAttemptAt = 0;
        if (timer && !pushTimer) pushTimer = setTimeout(() => { pushTimer = null; flush(); }, PUSH_DELAY_MS);
      }
    } catch (e) {
      log(`sheets: enqueue failed (${e.message})`);
    }
  }

  // ---------- Google auth (service-account JWT, RS256) ----------
  function loadKey() {
    if (key) return key;
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (!j.client_email || !j.private_key) throw new Error('service-account file is missing client_email/private_key');
    key = { email: j.client_email, pem: j.private_key, tokenUri: tokenUrl || j.token_uri || 'https://oauth2.googleapis.com/token' };
    return key;
  }

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60 * 1000) return token;
    const k = loadKey();
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: k.email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: k.tokenUri, iat: now, exp: now + 3600
    }));
    const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(k.pem));
    const res = await fetch(k.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Google auth failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`);
    token = body.access_token;
    tokenExp = Date.now() + (body.expires_in || 3600) * 1000;
    return token;
  }

  async function api(method, pathAndQuery, body) {
    const res = await fetch(`${baseUrl}/v4/spreadsheets/${encodeURIComponent(sheetId)}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Only Google's status + short message; never request details that could include credentials.
      throw new Error(`Sheets API HTTP ${res.status}: ${String(json.error?.message || res.statusText).slice(0, 200)}`);
    }
    return json;
  }

  const range = r => encodeURIComponent(`${TAB}!${r}`);

  async function ensureHeader() {
    if (headerChecked) return;
    const got = (await api('GET', `/values/${range(`A1:${LAST_COL}1`)}`)).values?.[0] || [];
    const cell = i => String(got[i] || '').trim();
    if (got.every(c => !String(c).trim())) {
      await api('PUT', `/values/${range(`A1:${LAST_COL}1`)}?valueInputOption=RAW`, { values: [COLUMNS] });
      log('sheets: wrote header row');
    } else if (ORIGINAL_COLUMNS.every((c, i) => cell(i) === c) && COLUMNS.slice(11).some((c, i) => cell(11 + i) !== c)) {
      // Extra columns (L..O) missing or partial on an existing sheet: write them without touching A-K.
      await api('PUT', `/values/${range(`L1:${LAST_COL}1`)}?valueInputOption=RAW`, { values: [COLUMNS.slice(11)] });
      log('sheets: added the Next action / Source / Security status / Checkpoint columns');
    } else if (COLUMNS.some((c, i) => cell(i) !== c)) {
      throw new Error(`"${TAB}" row 1 must be exactly: ${COLUMNS.join(' | ')}; not syncing so the sheet isn't scrambled`);
    }
    headerChecked = true;
  }

  // ---------- flush ----------
  async function flush() {
    if (!configured || flushing) return;
    const ob = loadOutbox();
    const urls = Object.keys(ob);
    if (!urls.length) return;
    flushing = true;
    try {
      await ensureHeader();
      const col = (await api('GET', `/values/${range('J:J')}`)).values || [];
      const rowOf = new Map();
      col.forEach((cells, i) => { if (i > 0 && cells[0]) rowOf.set(cells[0], i + 1); });

      const updates = [];
      const appends = [];
      for (const u of urls) {
        const n = rowOf.get(u);
        if (n) updates.push({ range: `${TAB}!A${n}:${LAST_COL}${n}`, values: [ob[u].row] });
        else appends.push(ob[u].row);
      }
      if (updates.length) await api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: updates });
      if (appends.length) {
        await api('POST', `/values/${range(`A:${LAST_COL}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: appends });
      }

      // Drop only what we sent; anything re-enqueued meanwhile (newer version) stays for next time.
      const now = loadOutbox();
      for (const u of urls) if (now[u] && now[u].v === ob[u].v) delete now[u];
      saveOutbox(now);

      failures = 0;
      nextAttemptAt = 0;
      lastError = null;
      lastSyncAt = new Date().toISOString();
      log(`sheets: synced ${updates.length} updated + ${appends.length} new row(s)`);
    } catch (e) {
      failures++;
      const wait = Math.min(MIN_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      nextAttemptAt = Date.now() + wait;
      lastError = e.message;
      if (/auth|401|403/.test(e.message)) token = null;
      log(`sheets: sync failed (${e.message}); ${urls.length} queued, retry in ${Math.round(wait / 1000)} s`);
    } finally {
      flushing = false;
    }
  }

  function start() {
    if (!configured || timer) return;
    timer = setInterval(() => { if (Date.now() >= nextAttemptAt) flush(); }, TICK_MS);
    timer.unref();
    log(`sheets: background sync on (tab "${TAB}")`);
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function status() {
    return {
      configured,
      pending: Object.keys(loadOutbox()).length,
      lastSyncAt,
      lastError,
      nextAttemptAt: nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null
    };
  }

  return { enqueue, flush, start, stop, status, COLUMNS, TAB, _api: api };
}

module.exports = { createSheetsSync, COLUMNS, rowFor };
