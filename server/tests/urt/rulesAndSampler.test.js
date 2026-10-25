import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import yaml from 'js-yaml';
import { loadRules, RulesInvalidError } from '../../services/urt/rules/rulesLoader.js';
import { allocateTypes, balancedAnswers, createRng, poolBalanceFactor, sampleCombination }
  from '../../services/urt/selection/combinationSampler.js';
import { physicsRules, RULES_DIR } from './helpers.js';

describe('rules loader', () => {
  let tmp;
  before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'urt-rules-')); });
  after(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('loads the five approved rules files', async () => {
    const loaded = await loadRules({ dir: RULES_DIR });
    assert.deepEqual([...loaded.keys()].sort(), ['biology', 'chemistry', 'english', 'geology', 'physics']);
    for (const v of loaded.values()) assert.match(v.contentHash, /^[0-9a-f]{64}$/);
  });

  async function loadMutated(mutate, { allowDraft = false } = {}) {
    const dir = await mkdtemp(path.join(tmp, 'case-'));
    await copyFile(path.join(RULES_DIR, 'rules.schema.json'), path.join(dir, 'rules.schema.json'));
    const r = yaml.load(await readFile(path.join(RULES_DIR, 'physics.yaml'), 'utf8'));
    const fileName = mutate(r) ?? 'physics.yaml';
    await writeFile(path.join(dir, fileName), yaml.dump(r));
    return loadRules({ dir, allowDraft });
  }

  const cases = [
    ['draft status', (r) => { r.status = 'draft'; }, /only approved rules/],
    ['unsupported schema_version', (r) => { r.schema_version = 2; }, /unsupported schema_version/],
    ['schema violation', (r) => { r.topics[0].weight = -1; }, /weight/],
    ['unknown style in a combination', (r) => { r.allowed_combinations.push({ style: 'essay', difficulty: 'hard', weight: 1 }); },
      /unknown style 'essay'/],
    ['zero weights', (r) => { r.topics.forEach((t) => { t.weight = 0; }); }, /topics: weights must sum/],
    ['table without rows', (r) => { delete r.figures.kinds[0].rows; }, /rows and columns/],
    ['subject not matching file name', (r) => { r.subject = 'biology'; r.rules_version = 'biology-2026.10.0'; },
      /does not match the file name/],
    ['bad question count', (r) => { r.question_set.count.typical = 99; }, /min <= typical <= max/],
  ];
  for (const [name, mutate, message] of cases) {
    it(`rejects: ${name}`, async () => {
      await assert.rejects(loadMutated(mutate), (err) => err instanceof RulesInvalidError && message.test(err.message));
    });
  }

  it('accepts draft rules only when allowed (dev)', async () => {
    const loaded = await loadMutated((r) => { r.status = 'draft'; }, { allowDraft: true });
    assert.equal(loaded.get('physics').rules.status, 'draft');
  });
});

describe('combination sampler', () => {
  it('is reproducible for a seed', async () => {
    const rules = await physicsRules();
    assert.deepEqual(sampleCombination({ rules, rng: createRng('s1') }), sampleCombination({ rules, rng: createRng('s1') }));
  });

  it('draws style × difficulty only from allowed_combinations', async () => {
    const rules = await physicsRules();
    const allowed = new Set(rules.allowed_combinations.map((c) => `${c.style}|${c.difficulty}`));
    const rng = createRng('allowed');
    for (let i = 0; i < 300; i += 1) {
      const c = sampleCombination({ rules, rng });
      assert.ok(allowed.has(`${c.styleId}|${c.difficulty}`), `${c.styleId}|${c.difficulty}`);
      assert.notEqual(c.difficulty, 'hard'); // physics hard has weight 0 and no allowed combination
    }
  });

  function topicFrequencies(rules, n, opts = {}) {
    const rng = createRng('freq');
    const counts = {};
    for (let i = 0; i < n; i += 1) {
      const t = sampleCombination({ rules, rng, ...opts }).topicId;
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }

  it('variety_alpha < 1 flattens toward rarer topics', async () => {
    const rules = await physicsRules();
    const flat = topicFrequencies(rules, 3000).magnetism / 3000;
    rules.sampling.variety_alpha = 1;
    const raw = topicFrequencies(rules, 3000).magnetism / 3000;
    assert.ok(flat > raw, `magnetism share ${flat} with alpha 0.6 vs ${raw} with alpha 1`);
    assert.ok(Math.abs(raw - 1 / 11) < 0.025, `alpha 1 follows the weights (${raw})`);
  });

  it('penalises the student\'s recent topics', async () => {
    const rules = await physicsRules();
    const base = topicFrequencies(rules, 3000).mechanics;
    const penalised = topicFrequencies(rules, 3000, { recentTopics: ['mechanics'] }).mechanics;
    assert.ok(penalised < base * 0.75, `${penalised} vs ${base}`);
  });

  it('pool balance favours under-represented topics', () => {
    assert.ok(poolBalanceFactor('a', 0.5, { a: 1, b: 9 }, 0.3) > 1);
    assert.ok(poolBalanceFactor('b', 0.5, { a: 1, b: 9 }, 0.3) < 1);
    assert.equal(poolBalanceFactor('a', 0.5, {}, 0.3), 1);
  });

  it('gives figure questions only to passages with figures', async () => {
    const rules = await physicsRules();
    const rng = createRng('figs');
    let withFig = 0;
    for (let i = 0; i < 200; i += 1) {
      const c = sampleCombination({ rules, rng });
      if (c.figures.length) withFig += 1;
      else assert.ok(c.questionPlan.every((q) => !q.usesFigure));
      const n = c.questionPlan.length;
      assert.ok(n >= rules.question_set.count.min && n <= rules.question_set.count.max);
    }
    assert.ok(withFig / 200 > 0.75 && withFig / 200 < 0.95, `figure rate ${withFig / 200}`);
  });

  it('never gives English passages figures and puts tone/main idea last', async () => {
    const loaded = await loadRules({ dir: RULES_DIR });
    const rules = loaded.get('english').rules;
    const rng = createRng('en');
    for (let i = 0; i < 100; i += 1) {
      const c = sampleCombination({ rules, rng });
      assert.equal(c.figures.length, 0);
      const firstLast = c.questionPlan.findIndex((q) => /main_idea|tone/.test(q.type));
      if (firstLast !== -1) assert.ok(c.questionPlan.slice(firstLast).every((q) => /main_idea|tone/.test(q.type)));
    }
  });

  it('balances answer positions and allocates types by share', () => {
    const answers = balancedAnswers(8, 4, createRng('a'));
    for (const l of 'ABCD') assert.equal(answers.filter((x) => x === l).length, 2);
    const types = allocateTypes([{ id: 'x', share: 0.5 }, { id: 'y', share: 0.3 }, { id: 'z', share: 0.2 }], 10);
    assert.deepEqual(['x', 'y', 'z'].map((id) => types.filter((t) => t.id === id).length), [5, 3, 2]);
  });
});
