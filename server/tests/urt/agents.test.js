import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rulesExcerpt } from '../../services/urt/agents/promptKit.js';
import { countSyllables, fleschKincaid } from '../../services/urt/agents/readability.js';
import { createGenerationAgent } from '../../services/urt/agents/generationAgent.js';
import { checkFigures, checkFormat, checkLength, createValidationAgent } from '../../services/urt/agents/validationAgent.js';
import { contentHash, minhash } from '../../services/urt/dedup/minhash.js';
import { createPassageProducer, toPassageRows } from '../../services/urt/generation/passageProducer.js';
import { createFakeLlmClient } from '../../services/urt/llm/fakeLlmClient.js';
import { createLlm } from '../../services/urt/llm/llmClient.js';
import { createCostLedger } from '../../services/urt/observability/costLedger.js';
import { createRng } from '../../services/urt/selection/combinationSampler.js';
import { combination, draft, physicsRules, PROMPTS_DIR, silentLogger } from './helpers.js';

const PRICES = { gen: { input: 1, output: 4 }, val: { input: 0.5, output: 2 }, emb: { input: 0.02, output: 0 } };
const THRESHOLDS = { maxCorpusJaccard: 0.2, maxCorpusCosine: 0.85, maxPoolCosine: 0.85 };
const noSleep = async () => {};

function collect(fn) {
  const checks = { list: [], add(code, passed, severity, detail) { this.list.push({ code, passed, severity, detail }); } };
  fn(checks);
  return checks.list.filter((c) => !c.passed);
}

// A fingerprint set with one unrelated "source" passage; the embedding [1,0,0] is far from the drafts' [0,1,0].
function fingerprints(sourceText = 'Glaciers move slowly downhill under their own weight, carving valleys.') {
  const a = Array.from({ length: 128 }, (_, i) => BigInt(2 * i + 3));
  const b = Array.from({ length: 128 }, (_, i) => BigInt(7 * i + 1));
  return { a, b, shingleWords: 5, passages: [{ id: 'src', contentHash: contentHash(sourceText),
    signature: minhash(sourceText, a, b), embedding: Float32Array.from([1, 0, 0]) }] };
}

const solveAll = (d, overrides = {}) => ({ answers: d.questions.map((q) => ({ orderIndex: q.orderIndex,
  answer: q.correctAnswer, confidence: 0.9, otherDefensible: [], reasoning: 'from the table', ...(overrides[q.orderIndex] ?? {}) })) });
const cleanReview = { issues: [], difficultyAssessed: 'medium', summary: 'fine' };

function harness(respond, { embed = () => [0, 1, 0] } = {}) {
  const client = createFakeLlmClient({ respond, embedFn: embed });
  const ledger = createCostLedger(PRICES);
  const llm = createLlm({ client, ledger, sleep: noSleep });
  return { client, ledger, llm };
}

describe('readability', () => {
  it('counts syllables and grades text', () => {
    assert.equal(countSyllables('pendulum'), 3);
    assert.equal(countSyllables('the'), 1);
    const easy = fleschKincaid('The cat sat. The dog ran. It was fun.');
    const hard = fleschKincaid('Thermodynamic equilibrium necessitates comprehensive consideration of intermolecular interactions.');
    assert.ok(easy.grade < 3 && hard.grade > 15, `${easy.grade} / ${hard.grade}`);
  });
});

describe('validation: deterministic checks', () => {
  it('a well-formed draft passes format, length and figure checks', async () => {
    const rules = await physicsRules();
    const failed = collect((c) => { checkFormat(draft(), combination(), c); checkLength(draft(), rules, c); checkFigures(draft(), combination(), rules, c); });
    assert.deepEqual(failed.filter((f) => f.severity === 'hard'), []);
  });

  const hardCases = [
    ['wrong option count', (d) => { d.questions[0].options.pop(); }, 'format_options'],
    ['key not among options', (d) => { d.questions[1].correctAnswer = 'E'; }, 'format_key'],
    ['missing question', (d) => { d.questions.pop(); }, 'format_question_count'],
    ['duplicate options', (d) => { d.questions[0].options[1].text = d.questions[0].options[0].text; }, 'format_duplicate_options'],
    ['ragged table', (d) => { d.figures[0].rows[2] = [0.75]; }, 'figures'],
    ['figureRef to a missing figure', (d) => { d.questions[0].figureRef = 'fig9'; }, 'figures'],
    ['passage far too short', (d) => { d.body = ['Too short.']; }, 'length_words'],
  ];
  for (const [name, mutate, code] of hardCases) {
    it(`hard failure: ${name}`, async () => {
      const rules = await physicsRules();
      const d = draft();
      mutate(d);
      const failed = collect((c) => { checkFormat(d, combination(), c); checkLength(d, rules, c); checkFigures(d, combination(), rules, c); });
      assert.ok(failed.some((f) => f.code === code && f.severity === 'hard'), JSON.stringify(failed));
    });
  }

  it('rejects LaTeX, Markdown and HTML but allows plain prices and Unicode symbols', () => {
    const bad = [['body', (d) => { d.body[1] += ' The activation energy $E_a$ matters.'; }],
      ['option', (d) => { d.questions[0].options[0].text = '\\frac{1}{2} s'; }],
      ['stem', (d) => { d.questions[1].stem = 'Which is **not** changed?'; }],
      ['title', (d) => { d.title = 'Period of a pendulum<sub>1</sub>'; }]];
    for (const [where, mutate] of bad) {
      const d = draft();
      mutate(d);
      assert.ok(collect((c) => checkFormat(d, combination(), c)).some((f) => f.code === 'format_markup'), where);
    }
    const ok = draft();
    ok.body[0] += ' A kit costs $5 and a timer $10; Eₐ, μ, Δθ and 2NO + O2 → 2NO2 are fine.';
    assert.ok(!collect((c) => checkFormat(ok, combination(), c)).some((f) => f.code === 'format_markup'));
  });

  it('soft failures: key at an unplanned letter, figures for English', async () => {
    const d = draft();
    d.questions[0].correctAnswer = 'A';
    const failed = collect((c) => checkFormat(d, combination(), c));
    assert.ok(failed.some((f) => f.code === 'format_planned_key' && f.severity === 'soft'));
    const rules = await physicsRules();
    rules.figures.probability = 0;
    assert.ok(collect((c) => checkFigures(draft(), combination(), rules, c)).some((f) => f.severity === 'hard'));
  });

  it('reading level is reported but never rejects on its own', async () => {
    const rules = await physicsRules();
    const failed = collect((c) => checkLength(draft(), rules, c));
    assert.ok(failed.every((f) => f.severity !== 'hard'));
  });
});

describe('validation agent', () => {
  async function agent(llm) {
    return createValidationAgent({ llm, model: 'val', embeddingModel: 'emb', promptsDir: PROMPTS_DIR, thresholds: THRESHOLDS });
  }

  it('passes a good draft after blind solve and review', async () => {
    const d = draft();
    const h = harness((call) => (call.messages[0].content.includes('careful, strong student') ? solveAll(d) : cleanReview));
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(),
      fingerprints: fingerprints() });
    assert.equal(v.report.passed, true, v.report.reasons.join('\n'));
    assert.equal(v.contentHash.length, 64);
    assert.deepEqual(Object.keys(h.ledger.totals().byRole).sort(), ['embedding', 'validation_blind_solve', 'validation_review']);
  });

  it('never shows the key to the blind solver', async () => {
    const d = draft();
    const h = harness((call) => (call.messages[0].content.includes('careful, strong student') ? solveAll(d) : cleanReview));
    await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    const solverInput = h.client.calls.find((c) => c.type === 'chat').messages[1].content;
    assert.ok(!solverInput.includes('correctAnswer') && !solverInput.includes('distractorRationale'));
  });

  it('fails when the blind solver disagrees with the key, without calling the review', async () => {
    const d = draft();
    const h = harness(() => solveAll(d, { 3: { answer: 'B' } }));
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.equal(v.report.passed, false);
    assert.ok(v.report.reasons.some((r) => r.startsWith('blind_solve') && r.includes('Q3')));
    assert.equal(h.client.calls.filter((c) => c.type === 'chat').length, 1);
  });

  it('asks the solver again when it skips a question, instead of rejecting the passage', async () => {
    const d = draft();
    let solves = 0;
    const h = harness((call) => {
      if (!call.messages[0].content.includes('careful, strong student')) return cleanReview;
      solves += 1;
      const all = solveAll(d);
      return solves === 1 ? { answers: all.answers.filter((a) => a.orderIndex !== 2) } : all;
    });
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.equal(solves, 2);
    assert.equal(v.report.passed, true, v.report.reasons.join('\n'));
  });

  it('fails when a second option is defensible', async () => {
    const d = draft();
    const h = harness(() => solveAll(d, { 2: { otherDefensible: ['A'] } }));
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.ok(v.report.reasons.some((r) => r.includes('also defensible')));
  });

  it('fails on a hard review issue, keeps soft ones as minor reasons', async () => {
    const d = draft();
    const review = { issues: [{ code: 'factual_error', severity: 'hard', orderIndex: 3, detail: 'period scales with sqrt(L)' },
      { code: 'weak_distractor', severity: 'soft', orderIndex: 2, detail: 'D is absurd' }], difficultyAssessed: 'medium', summary: 'x' };
    const h = harness((call) => (call.messages[0].content.includes('careful, strong student') ? solveAll(d) : review));
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.equal(v.report.passed, false);
    assert.ok(v.report.reasons.some((r) => r.startsWith('review_factual_error: Q3')));
    assert.ok(v.report.reasons.some((r) => r.startsWith('review_weak_distractor (minor)')));
  });

  it('stops at originality before any LLM call', async () => {
    const d = draft();
    const h = harness(() => { throw new Error('must not be called'); }, { embed: () => [1, 0, 0] });
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.equal(v.report.passed, false);
    assert.ok(v.report.reasons.some((r) => r.startsWith('originality_corpus_cosine')));
    assert.equal(h.client.calls.filter((c) => c.type === 'chat').length, 0);
  });

  it('skips every paid check when a free check fails', async () => {
    const d = draft();
    d.questions[0].options.pop();
    const h = harness(() => { throw new Error('must not be called'); });
    const v = await (await agent(h.llm)).validate({ draft: d, combination: combination(), rules: await physicsRules(), fingerprints: fingerprints() });
    assert.equal(v.report.passed, false);
    assert.equal(h.client.calls.length, 0);
  });
});

describe('validator evaluation set', () => {
  it('every flawed case really differs from the control', async () => {
    const { validatorEvalCases } = await import('./fixtures/validatorEval.js');
    const control = JSON.stringify(validatorEvalCases.find((c) => c.id === 'control').draft);
    const flawed = validatorEvalCases.filter((c) => c.expected === 'reject');
    assert.ok(flawed.length >= 7);
    for (const c of flawed) assert.notEqual(JSON.stringify(c.draft), control, c.id);
    const fact = validatorEvalCases.find((c) => c.id === 'factual_error').draft;
    assert.match(fact.body[3], /direct proportion/);
  });
});

describe('generation agent and producer', () => {
  it('prompts with the rules excerpt and the plan, never source text', async () => {
    const rules = await physicsRules();
    const h = harness(() => draft());
    const gen = await createGenerationAgent({ llm: h.llm, model: 'gen', promptsDir: PROMPTS_DIR });
    await gen.generate({ combination: combination(), rules });
    const [system, user] = h.client.calls[0].messages;
    assert.match(system.content, /Style: Experiment report/);
    assert.match(system.content, /Never do this/);
    assert.ok(!system.content.includes('{{'));
    assert.match(user.content, /"answer": "B"/);
    assert.ok(!user.content.includes('rulesVersion'));
    const excerpt = rulesExcerpt(rules, combination());
    assert.ok(excerpt.includes('Question types in this set') && excerpt.includes('data_interpretation'));
  });

  it('retries with the validator reasons, then passes', async () => {
    const rules = await physicsRules();
    let genCalls = 0;
    const respond = (call) => {
      const sys = call.messages[0].content;
      if (sys.includes('You write original reading passages')) {
        genCalls += 1;
        const d = draft();
        if (genCalls === 1) d.figures[0].rows[1] = [0.5]; // ragged table on the first attempt
        return d;
      }
      return sys.includes('careful, strong student') ? solveAll(draft()) : cleanReview;
    };
    const h = harness(respond);
    const producer = createPassageProducer({
      generationAgent: await createGenerationAgent({ llm: h.llm, model: 'gen', promptsDir: PROMPTS_DIR }),
      validationAgent: await createValidationAgent({ llm: h.llm, model: 'val', embeddingModel: 'emb', promptsDir: PROMPTS_DIR, thresholds: THRESHOLDS }),
      maxAttempts: 3, logger: silentLogger });
    const result = await producer.produce({ rules, fingerprints: fingerprints(), rng: createRng('p'),
      combination: combination(), ref: 't' });
    assert.equal(result.ok, true, JSON.stringify(result.attempts));
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].passed, false);
    assert.match(result.attempts[0].reasons.join(' '), /figures: fig1: row 2/);
    const secondGen = h.client.calls.filter((c) => c.type === 'chat' && c.messages[0].content.includes('You write original'))[1];
    assert.ok(secondGen, 'a second generation attempt was made');
    assert.match(secondGen.messages[1].content, /previous attempt was rejected[\s\S]*row 2/);
  });

  it('gives up after maxAttempts and reports every attempt', async () => {
    const rules = await physicsRules();
    const h = harness((call) => {
      const d = draft();
      d.body = ['Too short.'];
      return call.messages[0].content.includes('You write original') ? d : cleanReview;
    });
    const producer = createPassageProducer({
      generationAgent: await createGenerationAgent({ llm: h.llm, model: 'gen', promptsDir: PROMPTS_DIR }),
      validationAgent: await createValidationAgent({ llm: h.llm, model: 'val', embeddingModel: 'emb', promptsDir: PROMPTS_DIR, thresholds: THRESHOLDS }),
      maxAttempts: 2, logger: silentLogger });
    const result = await producer.produce({ rules, fingerprints: fingerprints(), rng: createRng('q'), ref: 't' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 2);
    assert.ok(result.attempts.every((a) => a.reasons.some((r) => r.startsWith('length_words'))));
  });

  it('maps a result onto passage and question rows', () => {
    const rows = toPassageRows({ combination: combination(), draft: draft(),
      validation: { report: { passed: true, checks: [], reasons: [] }, contentHash: 'h'.repeat(64), embedding: [0.5, 1] } },
    { generationModel: 'gen', promptVersion: 'generation.v1', embeddingModel: 'emb' });
    assert.equal(rows.passage.body.split('\n\n').length, 4);
    assert.equal(rows.passage.embedding.length, 8);
    assert.equal(rows.questions[0].question, draft().questions[0].stem);
    assert.equal(rows.questions[1].figureRef, null);
  });
});
