// Generates sample passages with the real models, for review and to measure cost per passage (M6 gate).
//   node scripts/urt/samplePassages.js --subjects physics,english --per-subject 1 --max-usd 0.30 [--seed s] [--dry-run]
// Writes each result (passed or not) to ../data/urt_samples/ (gitignored). --dry-run shows the
// sampled combinations and makes no calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRng, sampleCombination } from '../../services/urt/selection/combinationSampler.js';
import { loadRules } from '../../services/urt/rules/rulesLoader.js';
import { BudgetReachedError, buildRuntime, parseArgs } from './runtime.js';

const args = parseArgs(process.argv.slice(2));
const subjects = String(args.subjects ?? 'physics').split(',');
const perSubject = Number(args['per-subject'] ?? 1);
const maxUsd = Number(args['max-usd'] ?? 0.3);
const seed = String(args.seed ?? 'samples');
const outDir = path.resolve(args['out-dir'] ?? '../data/urt_samples');

if (args['dry-run']) {
  const rules = await loadRules({ dir: path.resolve('urt/rules') });
  const rng = createRng(seed);
  for (const s of subjects) {
    for (let i = 0; i < perSubject; i += 1) {
      const c = sampleCombination({ rules: rules.get(s).rules, rng });
      console.log(`${s} #${i + 1}: ${c.topicId}/${c.subtopicId}, ${c.styleId}, ${c.difficulty}, ${c.targetWords} words, `
        + `${c.figures.map((f) => f.kind).join('+') || 'no figures'}, ${c.questionPlan.length} questions`);
    }
  }
  console.log(`\nbudget cap $${maxUsd}; expect roughly $0.05–0.10 per passage (1–3 attempts).`);
  process.exit(0);
}

const rt = await buildRuntime({ maxUsd });
mkdirSync(outDir, { recursive: true });
const rng = createRng(seed);
const summary = [];
outer: for (const s of subjects) {
  const rules = rt.rules.get(s).rules;
  const fingerprints = await rt.fingerprints(s);
  for (let i = 0; i < perSubject; i += 1) {
    const before = rt.ledger.totals().costUsd;
    let result;
    try {
      result = await rt.producer.produce({ rules, fingerprints, rng, ref: `sample:${s}:${i + 1}` });
    } catch (err) {
      if (err instanceof BudgetReachedError) { console.error(err.message); break outer; }
      throw err;
    }
    const cost = rt.ledger.totals().costUsd - before;
    const file = path.join(outDir, `${s}-${seed}-${i + 1}.json`);
    writeFileSync(file, JSON.stringify({ ...result, costUsd: cost }, null, 2));
    summary.push({ subject: s, ok: result.ok, attempts: result.attempts.length, costUsd: +cost.toFixed(4), file });
    console.log(`${s} #${i + 1}: ${result.ok ? 'PASSED' : 'FAILED'} after ${result.attempts.length} attempt(s), $${cost.toFixed(4)} -> ${file}`);
    if (!result.ok) console.log(`  last reasons: ${result.attempts.at(-1).reasons.slice(0, 3).join(' | ')}`);
  }
}
const ok = summary.filter((r) => r.ok);
console.log(`\n${ok.length}/${summary.length} passed; average cost per produced passage `
  + `$${(rt.ledger.totals().costUsd / Math.max(1, ok.length)).toFixed(4)}`);
console.log('cost by role:', JSON.stringify(rt.ledger.totals().byRole, (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v)));
