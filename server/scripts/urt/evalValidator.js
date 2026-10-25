// Runs the validator evaluation set against the real models and reports the catch rate (target ≥ 95%).
//   node scripts/urt/evalValidator.js --max-usd 0.10 [--dry-run] [--data-dir ../data/corpus_analysis]
// Reads URT_* settings from the environment. --dry-run lists the cases and makes no calls.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validatorEvalCases } from '../../tests/urt/fixtures/validatorEval.js';
import { combination, PENDULUM_SUBTOPIC } from '../../tests/urt/helpers.js';
import { BudgetReachedError, buildRuntime, parseArgs } from './runtime.js';

const args = parseArgs(process.argv.slice(2));
const maxUsd = Number(args['max-usd'] ?? 0.1);

/** A near-copy of a real physics source passage, read from the local corpus data (never stored in git). */
function nearCopyCase(dataDir) {
  const segDir = path.join(dataDir, 'segments');
  const analysis = path.join(dataDir, 'analysis', 'per_passage.jsonl');
  if (!existsSync(segDir) || !existsSync(analysis)) return null;
  const physics = new Set(readFileSync(analysis, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.analysis.subject === 'physics').map((r) => r.segment_id));
  for (const f of readdirSync(segDir)) {
    for (const s of JSON.parse(readFileSync(path.join(segDir, f), 'utf8')).segments) {
      const words = s.passage_text.split(/\s+/);
      if (physics.has(s.segment_id) && words.length > 200) {
        const cut = words.slice(0, 300); // light edits: drop every 25th word
        const text = cut.filter((_, i) => i % 25 !== 24).join(' ');
        const d = structuredClone(validatorEvalCases.find((c) => c.id === 'control').draft);
        d.body = [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))];
        return { id: 'near_copy', flaw: 'lightly edited copy of a source passage', expected: 'reject', combination: combination(), draft: d };
      }
    }
  }
  return null;
}

const dataDir = path.resolve(args['data-dir'] ?? '../data/corpus_analysis');
const cases = [...validatorEvalCases];
const near = nearCopyCase(dataDir);
if (near) cases.push(near);
else console.warn(`near_copy case skipped: no corpus data in ${dataDir}`);

if (args['dry-run']) {
  for (const c of cases) console.log(`${c.id.padEnd(22)} expect ${c.expected.padEnd(7)} ${c.flaw}`);
  console.log(`\n${cases.length} cases; budget cap $${maxUsd}. Each case costs one embedding plus up to two validation calls.`);
  process.exit(0);
}

const rt = await buildRuntime({ maxUsd });
const rules = structuredClone(rt.rules.get('physics').rules);
rules.topics.find((t) => t.id === 'mechanics').subtopics.push({ ...PENDULUM_SUBTOPIC }); // the fixture's topic
const fingerprints = await rt.fingerprints('physics');
const rows = [];
for (const c of cases) {
  try {
    const v = await rt.validationAgent.validate({ draft: c.draft, combination: c.combination, rules, fingerprints, ref: `eval:${c.id}` });
    const outcome = v.report.passed ? 'accept' : 'reject';
    rows.push({ ...c, outcome, correct: outcome === c.expected, why: v.report.reasons.filter((r) => !r.includes('(minor)')).slice(0, 2) });
  } catch (err) {
    if (err instanceof BudgetReachedError) { console.error(err.message); break; }
    rows.push({ ...c, outcome: 'error', correct: false, why: [err.message] });
  }
}
for (const r of rows) {
  console.log(`${r.correct ? 'ok  ' : 'MISS'} ${r.id.padEnd(22)} expected ${r.expected}, got ${r.outcome}  ${r.why.join(' | ').slice(0, 160)}`);
}
const flawed = rows.filter((r) => r.expected === 'reject');
const caught = flawed.filter((r) => r.outcome === 'reject').length;
const control = rows.find((r) => r.id === 'control');
console.log(`\ncatch rate ${caught}/${flawed.length} (${((100 * caught) / Math.max(1, flawed.length)).toFixed(0)}%, target ≥ 95%);`
  + ` control ${control?.outcome ?? 'not run'}`);
console.log('cost:', JSON.stringify(rt.ledger.totals(), (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v)));
