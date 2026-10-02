const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { fillIndeedForm } = require('./indeed_form');

async function main() {
  const resumePath = path.join(os.tmpdir(), `job-agent-test-${process.pid}.pdf`);
  fs.writeFileSync(resumePath, '%PDF-1.4 test fixture');
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="application">
        <label for="first">First name</label><input id="first" name="firstName">
        <label for="last">Last name</label><input id="last" name="lastName">
        <label for="email">Email</label><input id="email" type="email" name="email">
        <label for="phone">Phone</label><input id="phone" type="tel" name="phone">
        <label for="city">City</label><input id="city" name="city">
        <label for="authorization">Are you authorized to work here?</label><input id="authorization" name="authorization">
        <label for="resume">Resume</label><input id="resume" type="file">
        <button id="submit" type="submit">Submit application</button>
      </form>
      <script>window.submitCount = 0; document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submitCount += 1; });</script>
    `);

    const profile = {
      firstName: 'Test',
      lastName: 'Candidate',
      fullName: 'Test Candidate',
      email: 'test@example.invalid',
      phone: '0000000000',
      location: 'Test City',
      resumePath,
      answers: {}
    };
    const result = await fillIndeedForm(page, profile, process.cwd());

    assert.equal(await page.locator('#first').inputValue(), 'Test');
    assert.equal(await page.locator('#last').inputValue(), 'Candidate');
    assert.equal(await page.locator('#email').inputValue(), 'test@example.invalid');
    assert.equal(await page.locator('#phone').inputValue(), '0000000000');
    assert.equal(await page.locator('#city').inputValue(), 'Test City');
    assert.equal(await page.locator('#authorization').inputValue(), '');
    assert.equal(await page.locator('#resume').evaluate(element => element.files.length), 1);
    assert.equal(await page.evaluate(() => window.submitCount), 0);
    assert.equal(result.resumeUploaded, true);
    assert.equal(result.unanswered.length, 1);
    console.log('PASS: configured fields and resume filled; unknown answer left blank; no submit occurred.');
  } finally {
    await browser.close();
    fs.rmSync(resumePath, { force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
