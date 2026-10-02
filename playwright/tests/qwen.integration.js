// Real local-Qwen mapping test (needs Ollama running; ~1-3 min on CPU). Not part of the default
// suite because it is slow. Run:  node --test playwright/tests/qwen.integration.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../application_engine');
const { startServer, testProfile, tempFiles } = require('./helpers');

test('local Qwen maps unusual labels to trusted facts; free text still needs a human', { timeout: 6 * 60 * 1000 }, async () => {
  const up = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}/api/tags`).then(r => r.ok).catch(() => false);
  assert.ok(up, 'Ollama must be running for this test');
  const srv = await startServer();
  const files = tempFiles();
  try {
    const r = await run({
      mode: 'prefill', platform: 'external', url: `${srv.base}/ats_llm.html`, company: 'QwenTest', title: 'x',
      profile: testProfile, cv: files.cv, coverLetter: files.coverLetter, outputDir: files.outputDir
      // llm omitted -> the real qwenMapper
    });
    console.log(JSON.stringify({ status: r.status, filled: r.report.filled, needs: r.needs_input, llmError: r.report.llmError }, null, 1));
    assert.equal(r.report.llmUsed, true);
    assert.equal(r.report.llmError, null);
    const val = re => r.report.values[Object.keys(r.report.values).find(l => re.test(l))];
    console.log('values:', JSON.stringify(r.report.values), '\nsources:', JSON.stringify(r.report.sources));
    assert.equal(val(/anticipated compensation/i), '11', 'expected CTC in lakhs');
    assert.match(val(/place of residence/i) || '', /chennai/i, 'current location');
    assert.equal(val(/present organisation/i), 'Finsurge Private Limited', 'current employer');
    const soon = val(/come on board/i);
    assert.ok(soon === undefined || soon === '0', `notice period must be 0 days if filled (got ${soon})`);
    assert.ok(r.needs_input.some(l => /why us/i.test(l)), 'free-text motivation never answered by the model');
    assert.equal(r.status, 'NEEDS_HUMAN_INPUT');
    assert.equal(srv.hits.submitted, 0);
  } finally {
    await srv.close();
    files.cleanup();
  }
});
