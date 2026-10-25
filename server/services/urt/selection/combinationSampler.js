// Chooses topic, style, difficulty, length, figures and the question plan for one passage (PLAN.md §6.1).
import { Combination, OPTION_LABELS } from '../contracts/combination.js';

// ---------------------------------------------------------------------------- seeded randomness
function hashSeed(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** mulberry32: small, fast, reproducible. Returns a function giving floats in [0, 1). */
export function createRng(seed = Date.now()) {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick(items, weightOf, rng) {
  const weights = items.map((it) => Math.max(0, weightOf(it)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('weightedPick: all weights are zero');
  let r = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

const randInt = (min, max, rng) => min + Math.floor(rng() * (max - min + 1));

function triangular(min, mode, max, rng) {
  const u = rng();
  const c = (mode - min) / (max - min || 1);
  return u < c ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function shuffle(xs, rng) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------- weighting terms
/**
 * Pool balance: boosts values the stored pool has too few of compared with their target share,
 * damps over-represented ones. `counts` is {value: storedPassages}; returns a multiplier in [0.5, 2].
 */
export function poolBalanceFactor(value, targetShare, counts, weight) {
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  if (!total || !weight || !(targetShare > 0)) return 1;
  const actual = (counts[value] ?? 0) / total;
  return Math.min(2, Math.max(0.5, 1 + weight * ((targetShare - actual) / targetShare)));
}

function shares(items, weightOf) {
  const total = items.reduce((s, it) => s + weightOf(it), 0);
  return new Map(items.map((it) => [it, total ? weightOf(it) / total : 0]));
}

// ---------------------------------------------------------------------------- question plan
/** Largest-remainder allocation of `n` questions over types by share. */
export function allocateTypes(types, n) {
  const total = types.reduce((s, t) => s + t.share, 0);
  const raw = types.map((t) => ({ t, exact: (t.share / total) * n }));
  const counts = raw.map((r) => ({ t: r.t, n: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let left = n - counts.reduce((s, c) => s + c.n, 0);
  for (const c of [...counts].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break;
    c.n += 1;
    left -= 1;
  }
  return counts.filter((c) => c.n > 0).flatMap((c) => Array(c.n).fill(c.t));
}

/** Correct-answer letters spread as evenly as possible over the options, in random order. */
export function balancedAnswers(n, optionsPerQuestion, rng) {
  const labels = OPTION_LABELS.slice(0, optionsPerQuestion);
  const out = [];
  while (out.length < n) out.push(...shuffle(labels, rng));
  return shuffle(out.slice(0, n), rng);
}

const LAST_TYPES = /main_idea|tone/; // whole-passage questions come last (English stem conventions)

function questionPlan(rules, hasFigure, rng) {
  const qs = rules.question_set;
  const n = Math.round(triangular(qs.count.min, qs.count.typical, qs.count.max, rng));
  // Without a figure, figure-based types are replaced by the other types in proportion to their share.
  const usable = hasFigure ? qs.types : qs.types.filter((t) => !t.uses_figure);
  const types = allocateTypes(usable.length ? usable : qs.types, n);
  const ordered = [...shuffle(types.filter((t) => !LAST_TYPES.test(t.id)), rng), ...types.filter((t) => LAST_TYPES.test(t.id))];
  const answers = balancedAnswers(ordered.length, qs.options_per_question, rng);
  return ordered.map((t, i) => ({
    orderIndex: i + 1,
    type: t.id,
    skill: t.skills[Math.floor(rng() * t.skills.length)],
    usesFigure: Boolean(hasFigure && t.uses_figure),
    answer: answers[i],
  }));
}

function figurePlan(rules, rng) {
  const f = rules.figures;
  if (!(f.probability > 0) || rng() >= f.probability || !f.kinds.length) return [];
  const counts = Array.from({ length: f.max_per_passage }, (_, i) => i + 1);
  const count = weightedPick(counts, (k) => 1 / k, rng); // one figure is most common
  return Array.from({ length: count }, () => {
    const k = weightedPick(f.kinds, (x) => x.weight, rng);
    const size = k.kind === 'table'
      ? { rows: randInt(k.rows.min, k.rows.max, rng), columns: randInt(k.columns.min, k.columns.max, rng) }
      : { series: randInt(k.series.min, k.series.max, rng), points: randInt(k.points.min, k.points.max, rng) };
    return { kind: k.kind, size };
  });
}

// ---------------------------------------------------------------------------- entry point
/**
 * @param {object} p
 * @param {object} p.rules           a loaded rules object (one subject)
 * @param {() => number} p.rng       createRng(seed)
 * @param {string[]} [p.recentTopics] the requesting student's last N topic ids, any subject
 * @param {{topics?: object, difficulties?: object}} [p.pool] stored passage counts per topicId / difficulty
 */
export function sampleCombination({ rules, rng, recentTopics = [], pool = null }) {
  const s = rules.sampling;
  const alpha = s.variety_alpha;
  const recent = new Set(recentTopics);

  const topicShare = shares(rules.topics, (t) => t.weight);
  const topic = weightedPick(rules.topics, (t) => t.weight ** alpha
    * (recent.has(t.id) ? 1 - s.recent_topic_penalty : 1)
    * poolBalanceFactor(t.id, topicShare.get(t), pool?.topics, s.pool_balance_weight), rng);
  const subtopic = weightedPick(topic.subtopics, (st) => st.weight ** alpha, rng);

  const diffShare = Object.fromEntries(Object.entries(rules.difficulty_levels).map(([d, v]) => [d, v.weight]));
  const diffTotal = Object.values(diffShare).reduce((a, b) => a + b, 0);
  const combo = weightedPick(rules.allowed_combinations, (c) => c.weight ** alpha
    * poolBalanceFactor(c.difficulty, diffTotal ? diffShare[c.difficulty] / diffTotal : 0, pool?.difficulties,
      s.pool_balance_weight), rng);

  const lw = rules.length_words;
  const targetWords = Math.round(triangular(lw.min, lw.p50 ?? (lw.min + lw.max) / 2, lw.max, rng) / 10) * 10;
  const figures = figurePlan(rules, rng);

  return Combination.parse({
    subject: rules.subject,
    topicId: topic.id,
    subtopicId: subtopic.id,
    styleId: combo.style,
    difficulty: combo.difficulty,
    targetWords,
    figures,
    questionPlan: questionPlan(rules, figures.length > 0, rng),
    optionsPerQuestion: rules.question_set.options_per_question,
    rulesVersion: rules.rules_version,
  });
}
