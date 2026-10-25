// Builds the whole URT module on the memory repository with a scripted LLM, for service and API tests.
import { createHash } from 'node:crypto';
import { loadUrtConfig } from '../../services/urt/config.js';
import { createUrtModule } from '../../services/urt/index.js';
import { createFakeLlmClient } from '../../services/urt/llm/fakeLlmClient.js';
import { createMemoryRepository } from '../../services/urt/repository/memoryRepository.js';
import { PARAGRAPHS, PROMPTS_DIR, RULES_DIR, silentLogger } from './helpers.js';

const EXTRA = 'The students repeated every measurement three times and used the average value, because a single '
  + 'stopwatch reading can easily be off by a tenth of a second. They also checked that the string did not stretch '
  + 'during the experiment, since a longer string would change the period they were trying to measure.';

/** Deterministic unit vector of 1536 dims from the text, so different texts are nearly orthogonal. */
export function textVector(text) {
  const out = new Array(1536);
  let seed = createHash('sha256').update(text).digest();
  for (let i = 0; i < 1536; i += 32) {
    seed = createHash('sha256').update(seed).digest();
    for (let j = 0; j < 32 && i + j < 1536; j += 1) out[i + j] = seed[j] / 255 - 0.5;
  }
  const n = Math.hypot(...out);
  return out.map((v) => v / n);
}

function figureFor(plan, i) {
  const id = `fig${i + 1}`;
  if (plan.kind === 'table') {
    const cols = plan.size.columns;
    return { id, kind: 'table', title: `Table ${i + 1}`, columns: ['Trial', ...Array.from({ length: cols - 1 }, (_, c) => `Value ${c + 1} (s)`)],
      rows: Array.from({ length: plan.size.rows }, (_, r) => [r + 1, ...Array.from({ length: cols - 1 }, (_, c) => +(1 + r * 0.3 + c).toFixed(2))]) };
  }
  const series = Array.from({ length: plan.size.series }, (_, s) => ({ name: `Series ${s + 1}`,
    points: Array.from({ length: plan.size.points }, (_, p) => [p, +(1 + p * (s + 1) * 0.5).toFixed(2)]) }));
  const xAxis = plan.kind === 'bar_chart'
    ? { label: 'Site', categories: Array.from({ length: plan.size.points }, (_, p) => `Site ${p + 1}`) }
    : { label: 'Time', unit: 's' };
  return { id, kind: plan.kind, title: `Figure ${i + 1}`, xAxis, yAxis: { label: 'Reading', unit: 'cm' }, series };
}

/** A valid draft that follows the plan in the generation request. */
export function draftForPlan(plan, n, { broken = false } = {}) {
  const figures = plan.figures.map(figureFor);
  const labels = 'ABCDE'.slice(0, plan.optionsPerQuestion).split('');
  return {
    title: `Test passage ${n}: the period of a pendulum`,
    body: [...PARAGRAPHS, `${EXTRA} This is test passage number ${n}.`],
    figures,
    questions: plan.questionPlan.map((q) => ({
      orderIndex: q.orderIndex, questionType: q.type, skill: q.skill, difficulty: plan.difficulty,
      stem: `Question ${q.orderIndex} of passage ${n}: which statement is supported?`,
      options: labels.map((label) => ({ label, text: `Option ${label} for question ${q.orderIndex}` })),
      correctAnswer: q.answer,
      figureRef: q.usesFigure && figures.length ? figures[0].id : null,
      distractorRationale: labels.filter((l) => l !== q.answer).map((label) => ({ label, pattern: 'adjacent value', whyWrong: 'not supported' })),
    })).map((q) => (broken ? { ...q, options: q.options.slice(0, 2) } : q)),
    selfCheck: 'ok',
  };
}

/**
 * @param {object} [o]
 * @param {(n: number) => boolean} [o.brokenAttempt]  make the n-th generation invalid
 * @param {boolean} [o.feedbackFails]
 */
export function createScriptedClient({ brokenAttempt = () => false, feedbackFails = false } = {}) {
  const drafts = new Map(); // title → draft (so the fake solver knows the key)
  let generated = 0;
  const counts = { generation: 0, blind: 0, review: 0, feedback: 0 };
  const client = createFakeLlmClient({
    embedFn: (t) => textVector(t),
    respond(call) {
      const system = call.messages[0].content;
      const user = call.messages.at(-1).content;
      if (system.startsWith('You write original reading passages')) {
        counts.generation += 1;
        generated += 1;
        const plan = JSON.parse(call.messages[1].content.match(/Combination to follow:\n([\s\S]*?)(?:\n\nYour previous attempt|$)/)[1]);
        const d = draftForPlan(plan, generated, { broken: brokenAttempt(generated) });
        drafts.set(d.title, d);
        return d;
      }
      if (system.includes('careful, strong student')) {
        counts.blind += 1;
        const d = drafts.get(JSON.parse(user).title);
        return { answers: d.questions.map((q) => ({ orderIndex: q.orderIndex, answer: q.correctAnswer, confidence: 0.9,
          otherDefensible: [], reasoning: 'from the passage' })) };
      }
      if (system.includes('You review a generated exam passage')) {
        counts.review += 1;
        return { issues: [], difficultyAssessed: 'medium', summary: 'ok' };
      }
      if (system.includes('You are a patient tutor')) {
        counts.feedback += 1;
        if (feedbackFails) return new Error('feedback model down');
        return { explanations: JSON.parse(user).questions.map((q) => ({ questionId: q.questionId,
          explanation: `The answer is ${q.correctAnswer}; see paragraph 2.` })) };
      }
      throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
    },
  });
  return { client, counts };
}

export async function buildTestModule({ env = {}, client = createScriptedClient(), repo = createMemoryRepository() } = {}) {
  const config = loadUrtConfig({
    URT_OPENAI_BASE_URL: 'https://gateway.test/v1', URT_OPENAI_API_KEY: 'test', URT_RULES_DIR: RULES_DIR,
    URT_PROMPTS_DIR: PROMPTS_DIR, URT_FRESH_BUFFER_LOW: '0', URT_FRESH_BUFFER_TARGET: '0', URT_SAMPLER_SEED: 'tests',
    URT_LLM_MAX_RETRIES: '1', ...env,
  });
  const urt = await createUrtModule({ config, repo, client: client.client, logger: silentLogger });
  return { urt, repo, ...client };
}

/** Insert a ready passage directly (bypassing generation) for serving tests. */
export async function seedPassage(repo, { subject = 'physics', topicId = 'mechanics', rulesVersion = `${subject}-2026.10.0`,
  n = Math.random() } = {}) {
  return repo.insertPassage({
    passage: { subject, title: `Seeded ${n}`, body: `Seeded passage body ${n}.`, figures: null, wordCount: 300,
      difficulty: 'medium', topicId, subtopicId: 'x', styleId: 'experiment_report', combination: {}, rulesVersion,
      promptVersion: 'generation.v2', generationModel: 'gen', status: 'validated', validationReport: { passed: true },
      contentHash: createHash('sha256').update(String(n)).digest('hex'), embedding: null, embeddingModel: null },
    questions: [1, 2].map((i) => ({ orderIndex: i, type: 'multiple_choice', questionType: 'detail', skill: 's',
      difficulty: 'easy', question: `Seeded question ${i}?`, options: ['A', 'B', 'C', 'D'].map((l) => ({ label: l, text: `opt ${l}` })),
      correctAnswer: i === 1 ? 'B' : 'D', distractorRationale: [{ label: 'A', pattern: 'p', whyWrong: 'wrong because A' }],
      figureRef: null })),
  });
}
