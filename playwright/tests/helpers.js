// Shared test helpers: a local fixture server that records any submit attempt, a fixed test
// profile, and throwaway CV / cover-letter files. Tests never touch real job sites.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

async function startServer() {
  const hits = { submitted: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__submitted') {
      hits.submitted++;
      res.writeHead(204); return res.end();
    }
    const file = path.join(FIXTURES, path.basename(url.pathname));
    if (!file.endsWith('.html') || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise(r => server.close(r)) };
}

const testProfile = {
  firstName: 'Raja Sibi', lastName: 'S', fullName: 'Raja Sibi S',
  email: 'test@example.com', phone: '9025906485',
  location: 'Chennai, Tamil Nadu, India', city: 'Chennai', country: 'India',
  preferredLocation: 'Chennai / Tamil Nadu / Remote',
  linkedin: '', portfolio: '',
  currentCompany: 'Finsurge Private Limited', currentTitle: 'Software Developer',
  yearsExperience: '3', education: 'M.A. English Literature', university: 'Annamalai University', graduationYear: '2023',
  currentSalary: '420000', expectedSalary: '1100000', noticePeriod: '0',
  authorizedToWork: 'Yes', requiresSponsorship: 'No', willingToRelocate: 'No',
  answers: { 'What is your notice period?': 'Immediate' }
};

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
  const cv = path.join(dir, 'cv.pdf');
  const coverLetter = path.join(dir, 'cover_letter.pdf');
  fs.writeFileSync(cv, '%PDF-1.4\n% test CV\n');
  fs.writeFileSync(coverLetter, '%PDF-1.4\n% test cover letter\n');
  fs.writeFileSync(path.join(dir, 'cover_letter.md'), 'Dear Hiring Team, this is a test cover letter.');
  return { dir, cv, coverLetter, outputDir: path.join(dir, 'out'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { startServer, testProfile, tempFiles, FIXTURES };
