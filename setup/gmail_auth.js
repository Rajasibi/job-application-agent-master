// One-time Gmail sign-in for job-alert emails (READ-ONLY access: gmail.readonly).
//
// Before running:
//   1. Google Cloud Console (your existing project) -> APIs & Services -> enable "Gmail API".
//   2. APIs & Services -> OAuth consent screen: External, add your Gmail as a Test user.
//   3. Credentials -> Create credentials -> OAuth client ID -> type "Desktop app" -> Download JSON.
//   4. Save it as config\gmail_oauth_client.json (do not paste it in chat).
// Then:  node setup\gmail_auth.js
// Your browser opens Google's consent page. After you allow read-only access, the refresh token is
// saved to config\gmail_token.json (gitignored). Nothing is printed except success / errors.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIENT_FILE = path.join(ROOT, 'config', 'gmail_oauth_client.json');
const TOKEN_FILE = path.join(ROOT, 'config', 'gmail_token.json');
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

if (!fs.existsSync(CLIENT_FILE)) {
  console.log(`Missing ${path.relative(ROOT, CLIENT_FILE)}. Create a "Desktop app" OAuth client in Google Cloud Console, download its JSON, and save it there (see the top of this file).`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
const client = raw.installed || raw.web || raw;
if (!client.client_id || !client.client_secret) { console.log('gmail_oauth_client.json has no client_id / client_secret.'); process.exit(1); }

const b64url = buf => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
  const done = (msg, ok) => { res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' }); res.end(`<p style="font-family:sans-serif">${msg}</p>`); };
  if (u.searchParams.get('state') !== state) return done('State mismatch; run gmail_auth.js again.', false);
  if (u.searchParams.get('error')) { done(`Google returned: ${u.searchParams.get('error')}`, false); console.log(`Not authorised: ${u.searchParams.get('error')}`); return server.close(); }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: u.searchParams.get('code'), client_id: client.client_id, client_secret: client.client_secret,
        redirect_uri: `http://127.0.0.1:${server.address().port}`, grant_type: 'authorization_code', code_verifier: verifier
      })
    });
    const b = await r.json();
    if (!r.ok || !b.refresh_token) throw new Error(b.error_description || b.error || `HTTP ${r.status} (no refresh token)`);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: b.refresh_token, scope: b.scope, saved_at: new Date().toISOString() }));
    done('Done. The job agent can now read your job-alert emails (read-only). You can close this tab.', true);
    console.log(`Saved ${path.relative(ROOT, TOKEN_FILE)} (read-only Gmail access).`);
  } catch (e) {
    done(`Failed: ${e.message}`, false);
    console.log(`Failed: ${e.message}`);
  }
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256'
  }).toString();
  console.log('Opening Google sign-in in your browser (read-only Gmail access). If it does not open, paste this link:');
  console.log(auth.toString());
  if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', auth.toString()], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => { console.log('Timed out waiting for sign-in (5 min).'); server.close(); process.exit(1); }, 5 * 60 * 1000).unref();
});
