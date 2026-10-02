// Renders a markdown file (tailored CV or cover letter) to an ATS-friendly PDF.
// Usage: node render_pdf.js --in file.md --out file.pdf
const fs = require('fs');
const { chromium } = require('playwright');
const { marked } = require('marked');
const args = require('minimist')(process.argv.slice(2));

const CSS = `
  body { font-family: Calibri, Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  h2 { font-size: 12pt; border-bottom: 1px solid #999; margin: 12pt 0 4pt; padding-bottom: 2pt; text-transform: uppercase; }
  h3 { font-size: 11pt; margin: 8pt 0 2pt; }
  p { margin: 3pt 0; }
  ul { margin: 2pt 0 4pt 16pt; padding: 0; }
  li { margin: 1pt 0; }
  a { color: #111; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 8pt 0; }
`;

(async () => {
  const md = fs.readFileSync(args.in, 'utf-8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${marked.parse(md)}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: args.out, format: 'A4', margin: { top: '14mm', bottom: '14mm', left: '16mm', right: '16mm' } });
    console.log(JSON.stringify({ success: true, pdf: args.out }));
  } finally {
    await browser.close();
  }
})().catch(e => { console.log(JSON.stringify({ success: false, error: e.message })); process.exitCode = 1; });
