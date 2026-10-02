// End-to-end smoke test: sends one sample job into n8n's /score-job webhook and prints
// the record the pipeline wrote to setup/applied_jobs.json.
//
// Usage: node setup/test_scorer.js ["Job title"] ["Company"]
// A job that scores below FIT_THRESHOLD ends as REJECTED; a passing one gets a tailored CV
// in output/ and then FAILED at the apply step (the sample URL is fake) — both prove the chain works.

const path = require('path');
const appLog = require(path.join(__dirname, '..', 'playwright', 'application_log.js'));

const N8N_URL = (process.env.N8N_WEBHOOK_URL || 'http://localhost:5678').replace(/\/$/, '');
const title = process.argv[2] || 'GenAI Engineer';
const company = process.argv[3] || 'Sample Company';

const job = {
  job_title: title,
  company,
  location: 'Chennai, India',
  source_platform: 'naukri',
  region: 'india',
  job_url: `https://example.com/jobs/test-${Date.now()}`,
  description: `We are hiring a GenAI Engineer (2-4 years) in Chennai to build RAG pipelines with LangChain, embeddings and vector databases
(Pinecone/Chroma/FAISS), LLM chatbots with guardrails, FastAPI inference services on AWS, and LoRA fine-tuning of open-source LLMs. Python and SQL required.`
};

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = require('http').request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response after ${timeoutMs / 60000} min`)));
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  console.log(`\nPOST ${N8N_URL}/webhook/score-job`);
  console.log(`Sample: ${title} at ${company}`);
  console.log('Local Qwen on CPU: scoring ~15-90s; a passing job also tailors a CV (several minutes).\n');

  const started = Date.now();
  try {
    // Plain http, not fetch: fetch gives up after 5 min without response headers,
    // and a passing job (score + CV + cover letter on CPU) takes longer than that.
    const { status, body } = await postJson(`${N8N_URL}/webhook/score-job`, job, 75 * 60 * 1000);
    console.log(`HTTP ${status} after ${Math.round((Date.now() - started) / 1000)}s`);
    if (status >= 400) console.log(body.slice(0, 500));
  } catch (e) {
    console.error(`ERROR: ${e.message}\nIs n8n running (START_AGENT.bat) and are the workflows active?`);
    process.exit(1);
  }

  const rec = appLog.findByUrl(job.job_url);
  if (!rec) {
    console.log('\nNo log record written — check the n8n Executions tab for errors.');
    process.exit(1);
  }
  console.log('\nLogged record:');
  for (const k of ['status', 'fit_score', 'cv_variant', 'cover_letter', 'notes', 'cv_pdf']) {
    if (rec[k] !== undefined) console.log(`  ${k.padEnd(13)} ${rec[k]}`);
  }
  console.log('\nPipeline OK.\n');
})();
