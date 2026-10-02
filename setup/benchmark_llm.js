// LLM benchmark on the real workload: fit scoring, CV tailoring, cover letter, form-question mapping.
//
//   node setup/benchmark_llm.js [--backends local,ollama_cloud] [--cloud-models gemma4:31b,gpt-oss:20b]
//                               [--runs 1] [--concurrency 2,3,4] [--skip-long-local]
//
// Prompts are the production ones: score/CV/cover come from the helper's /prompt (same builder the
// pipeline uses), the mapping prompt from agentic_form_filler.buildMapperRequest. Jobs are real
// pipeline inputs (setup/benchmark_jobs.json). Needs the helper running (for /prompt and /parse-score).
// Local runs should be done while the pipeline is idle, otherwise they queue behind it.
// Writes output/benchmark/llm_<timestamp>.json and prints a summary table. Never prints the API key.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { createLlm } = require(path.join(ROOT, 'helper-service', 'llm_backend'));
const { buildMapperRequest, acceptMapping } = require(path.join(ROOT, 'playwright', 'agentic_form_filler'));
const { buildTrusted } = require(path.join(ROOT, 'playwright', 'answer_resolver'));

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); const v = i > 0 ? process.argv[i + 1] : undefined; return v === undefined || v.startsWith('--') ? d : v; };
const BACKENDS = arg('backends', 'local,ollama_cloud').split(',');
const CLOUD_MODELS = arg('cloud-models', process.env.OLLAMA_CLOUD_MODEL || 'gemma4:31b').split(',').filter(Boolean);
const RUNS = Number(arg('runs', 1));
const CONCURRENCY = arg('concurrency', '2,3,4').split(',').map(Number).filter(Boolean);
const SKIP_LONG_LOCAL = process.argv.includes('--skip-long-local');
const HELPER = (process.env.HELPER_URL || 'http://127.0.0.1:9999').replace(/\/$/, '');

const llm = createLlm({ log: m => console.log(`  [llm] ${m}`) });
const post = (p, body) => fetch(`${HELPER}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
const jobs = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup', 'benchmark_jobs.json'), 'utf8'));
const baseCv = v => fs.readFileSync(path.join(ROOT, 'cv', `cv_variant_${String(v || 'A').toLowerCase() === 'b' ? 'b' : 'a'}.md`), 'utf8');
const words = s => (String(s).match(/\S+/g) || []).length;
const headings = s => (String(s).match(/^#{1,3}\s+.+$/gm) || []).map(h => h.replace(/^#+\s*/, '').trim().toLowerCase());

// The mock ATS questions used by the real-Qwen integration test (unusual labels).
const MAP_FIELDS = [
  { ref: 'f1', kind: 'text', label: 'Anticipated compensation (LPA)', required: true, options: [] },
  { ref: 'f2', kind: 'text', label: 'Place of residence', required: true, options: [] },
  { ref: 'f3', kind: 'text', label: 'Name of your present organisation', required: true, options: [] },
  { ref: 'f4', kind: 'number', label: 'How soon can you come on board? (days)', required: true, options: [] }
];
const MAP_EXPECT = { f1: ['expectedSalaryLakhs'], f2: ['city', 'location'], f3: ['currentCompany'], f4: ['noticePeriodDays'] };

async function timed(kind, request, target) {
  const t = Date.now();
  try {
    const r = await llm.chat({ ...request, stream: true }, { backend: target.backend, model: target.model, fallback: false });
    const genS = r.eval_duration ? r.eval_duration / 1e9 : null;
    return { kind, ok: true, total_ms: Date.now() - t, ttft_ms: r.ttft_ms, prompt_tokens: r.prompt_eval_count ?? null, output_tokens: r.eval_count ?? null, tok_per_s: genS && r.eval_count ? +(r.eval_count / genS).toFixed(1) : null, content: r.message.content };
  } catch (e) {
    return { kind, ok: false, total_ms: Date.now() - t, error: e.toJSON ? e.toJSON() : { kind: 'error', message: e.message } };
  }
}

async function quality(kind, job, content) {
  if (kind === 'score') {
    const p = await post('/parse-score', { job, content, final: true });
    const bad = /unparseable/i.test(p.job?.rejection_reason || '');
    return { pass: !bad, score: p.job?.score, verdict: p.job?.verdict, passed: p.passed };
  }
  if (kind === 'cv') {
    const base = baseCv(job.cv_variant);
    const want = headings(base);
    const got = new Set(headings(content));
    const kept = want.filter(h => got.has(h)).length / (want.length || 1);
    const ratio = words(content) / words(base);
    const contact = content.includes(profile.email);
    return { pass: kept >= 0.7 && ratio > 0.5 && ratio < 1.8 && contact, headings_kept: +kept.toFixed(2), length_ratio: +ratio.toFixed(2), contact_restored: contact };
  }
  if (kind === 'cover') {
    // prompts/cover_letter.md: "3 paragraphs, max 250 words total" (local Qwen writes ~165-190).
    const n = words(content);
    const paragraphs = String(content).split(/\n\s*\n/).filter(p => words(p) >= 15).length;
    const named = content.toLowerCase().includes(String(job.company).toLowerCase().split(/\s+/)[0]);
    return { pass: n >= 100 && n <= 280 && paragraphs >= 3 && named, words: n, paragraphs, names_company: named };
  }
  if (kind === 'map') {
    let maps = [];
    try { maps = JSON.parse(content.replace(/```(?:json)?/g, '')).mappings || []; } catch (_) { return { pass: false, reason: 'invalid JSON' }; }
    const trusted = buildTrusted({ profile });
    let correct = 0;
    for (const f of MAP_FIELDS) {
      const m = maps.find(x => x.ref === f.ref);
      const accepted = m && acceptMapping(f, m.fact_key, trusted);
      if (accepted && MAP_EXPECT[f.ref].includes(m.fact_key)) correct++;
    }
    return { pass: correct >= 3, correct, of: MAP_FIELDS.length };
  }
}

async function prompts() {
  const out = [];
  for (const job of jobs) out.push({ kind: 'score', job, request: (await post('/prompt', { kind: 'score', job })).ollama_request });
  const cvJob = { ...jobs[0], top_matches: ['LLM applications', 'RAG pipelines', 'Python'] };
  out.push({ kind: 'cv', job: cvJob, request: (await post('/prompt', { kind: 'cv', job: cvJob })).ollama_request, long: true });
  out.push({ kind: 'cover', job: cvJob, request: (await post('/prompt', { kind: 'cover', job: cvJob })).ollama_request, long: true });
  out.push({ kind: 'map', job: {}, request: buildMapperRequest(MAP_FIELDS, buildTrusted({ profile }).facts) });
  return out;
}

const avg = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null; };

async function sequential(target, work) {
  const results = [];
  for (let run = 0; run < RUNS; run++) {
    for (const w of work) {
      if (target.backend === 'local' && w.long && (SKIP_LONG_LOCAL || run > 0)) continue;
      process.stdout.write(`  ${target.label} ${w.kind}${w.job.company ? ` (${w.job.company})` : ''} ... `);
      const r = await timed(w.kind, w.request, target);
      r.company = w.job.company;
      if (r.ok) r.quality = await quality(w.kind, w.job, r.content);
      console.log(r.ok ? `${(r.total_ms / 1000).toFixed(1)} s, quality ${r.quality.pass ? 'ok' : 'FAIL'} ${JSON.stringify(r.quality)}` : `FAILED ${r.error.kind}: ${r.error.message}`);
      delete r.content;
      results.push(r);
    }
  }
  return results;
}

// N parallel "jobs" (score + cover letter each), like N pipeline chains at once.
async function concurrencyStep(target, work, n, baselineP95) {
  const score = work.filter(w => w.kind === 'score');
  const cover = work.find(w => w.kind === 'cover');
  const t = Date.now();
  const chains = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const s = score[i % score.length];
    const a = await timed('score', s.request, target);
    if (a.ok) a.quality = await quality('score', s.job, a.content);
    const b = await timed('cover', cover.request, target);
    if (b.ok) b.quality = await quality('cover', cover.job, b.content);
    return [a, b];
  }));
  const calls = chains.flat();
  const errors = calls.filter(c => !c.ok);
  const qualityFails = calls.filter(c => c.ok && !c.quality.pass);
  const lat = calls.filter(c => c.ok).map(c => c.total_ms);
  const res = {
    n, wall_ms: Date.now() - t, calls: calls.length, errors: errors.length, rate_limited: errors.filter(e => e.error.kind === 'rate_limited').length,
    error_kinds: [...new Set(errors.map(e => e.error.kind))], quality_fails: qualityFails.length, p95_ms: p95(lat), avg_ms: avg(lat)
  };
  res.stable = res.errors === 0 && res.quality_fails === 0 && (!baselineP95 || res.p95_ms <= 2 * baselineP95);
  return res;
}

function passRate() {
  try {
    const apps = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup', 'applied_jobs.json'), 'utf8')).applications || [];
    const scored = apps.filter(a => Number(a.fit_score) > 0);
    return scored.length ? scored.filter(a => Number(a.fit_score) >= 70).length / scored.length : 0.3;
  } catch (_) { return 0.3; }
}

(async () => {
  const health = await fetch(`${HELPER}/health`).then(r => r.ok).catch(() => false);
  if (!health) { console.log('Helper is not running (needed for /prompt and /parse-score). Start the agent first.'); process.exit(1); }
  const work = await prompts();
  const targets = [];
  if (BACKENDS.includes('local')) targets.push({ backend: 'local', model: process.env.OLLAMA_MODEL, label: `LOCAL ${process.env.OLLAMA_MODEL}` });
  if (BACKENDS.includes('ollama_cloud')) for (const m of CLOUD_MODELS) targets.push({ backend: 'ollama_cloud', model: m, label: `CLOUD ${m}` });

  const report = { at: new Date().toISOString(), jobs: jobs.map(j => `${j.company} - ${j.job_title}`), runs: RUNS, targets: [] };
  for (const target of targets) {
    console.log(`\n== ${target.label} ==`);
    const results = await sequential(target, work);
    const byKind = {};
    for (const k of ['score', 'cv', 'cover', 'map']) {
      const rs = results.filter(r => r.kind === k);
      if (!rs.length) continue;
      const ok = rs.filter(r => r.ok);
      byKind[k] = {
        calls: rs.length, ok: ok.length, quality_pass: ok.filter(r => r.quality.pass).length,
        avg_ms: avg(ok.map(r => r.total_ms)), avg_ttft_ms: avg(ok.map(r => r.ttft_ms).filter(x => x !== null)),
        avg_output_tokens: avg(ok.map(r => r.output_tokens).filter(x => x !== null)), avg_tok_per_s: avg(ok.map(r => r.tok_per_s).filter(x => x !== null)),
        scores: k === 'score' ? ok.map(r => `${r.company}: ${r.quality.score}`) : undefined,
        errors: rs.filter(r => !r.ok).map(r => r.error)
      };
    }
    const entry = { ...target, byKind, results };
    if (target.backend === 'ollama_cloud' && CONCURRENCY.length) {
      const allOk = results.every(r => r.ok && r.quality.pass);
      entry.concurrency = [];
      if (!allOk) entry.concurrency_note = 'skipped: sequential run had errors or quality failures';
      else {
        const baseP95 = p95(results.filter(r => ['score', 'cover'].includes(r.kind)).map(r => r.total_ms));
        entry.safe_concurrency = 1;
        for (const n of CONCURRENCY) {
          process.stdout.write(`  concurrency ${n} ... `);
          const c = await concurrencyStep(target, work, n, baseP95);
          console.log(JSON.stringify(c));
          entry.concurrency.push(c);
          if (!c.stable) break;
          entry.safe_concurrency = n;
        }
      }
    }
    report.targets.push(entry);
  }

  // 15-job batch estimate from the measured stage times.
  const rate = passRate();
  report.pass_rate = +rate.toFixed(2);
  const APPLY_MS = 90 * 1000; // browser apply check per passing job (serial, local)
  for (const t of report.targets) {
    const k = t.byKind;
    if (!k.score) continue;
    const cv = k.cv?.avg_ms;
    const cover = k.cover?.avg_ms;
    if (cv == null || cover == null) { t.batch15_min = null; continue; }
    const perJobLlm = k.score.avg_ms + rate * (cv + cover);
    const n = t.safe_concurrency || 1;
    t.batch15_min = +(((15 * perJobLlm) / n + 15 * rate * APPLY_MS) / 60000).toFixed(1);
  }

  const outDir = path.join(ROOT, 'output', 'benchmark');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `llm_${report.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  console.log('\n| backend | score avg s | cv avg s | cover avg s | map avg s | TTFT score s | quality pass | safe conc. | 15-job batch min |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const s = ms => (ms == null ? '-' : (ms / 1000).toFixed(1));
  for (const t of report.targets) {
    const k = t.byKind;
    const q = Object.values(k).reduce((a, x) => [a[0] + x.quality_pass, a[1] + x.calls], [0, 0]);
    console.log(`| ${t.label} | ${s(k.score?.avg_ms)} | ${s(k.cv?.avg_ms)} | ${s(k.cover?.avg_ms)} | ${s(k.map?.avg_ms)} | ${s(k.score?.avg_ttft_ms)} | ${q[0]}/${q[1]} | ${t.safe_concurrency || (t.backend === 'local' ? 1 : '-')} | ${t.batch15_min ?? '-'} |`);
  }
  console.log(`\npass rate used for estimates: ${report.pass_rate}; report: ${path.relative(ROOT, file)}`);
})().catch(e => { console.log('BENCHMARK ERROR', e.message); process.exit(1); });
