// Validation agent (PLAN.md §6.3). Checks run cheapest first; the deterministic ones (1–3) all run
// because they are free, then the run stops at the first check with a hard failure:
//   1 format        option counts, labels, one key among the options, the plan followed
//   2 length        word count and Flesch–Kincaid grade within the rules (with a small tolerance)
//   3 figures       rectangular tables, enough chart points, every figureRef exists
//   4 originality   exact hash, MinHash Jaccard and cosine against the corpus, cosine against the pool
//   5 blind solve   a separate call without the key must reach the key, with no other defensible option
//   6 review        factual accuracy, ambiguity, distractors, difficulty, anti-patterns, figure use
// Only a draft with no failed hard check passes. `reasons` go back to the generator on a retry.
import { OPTION_LABELS } from '../contracts/combination.js';
import { draftText } from '../contracts/passageDraft.js';
import { BlindSolveResult, ReviewResult } from '../contracts/validationReport.js';
import { checkOriginality } from '../dedup/originalityService.js';
import { loadPrompt, rulesExcerpt } from './promptKit.js';
import { fleschKincaid } from './readability.js';

export const BLIND_SOLVE_PROMPT = 'validation_blind_solve.v1';
export const REVIEW_PROMPT = 'validation_review.v2';
const LENGTH_TOLERANCE = 0.1; // ±10% beyond the rules' range is a hard failure; inside the margin, soft
const GRADE_TOLERANCE = 1.5;  // the grade formula is approximate

class Checks {
  constructor() { this.list = []; }

  add(code, passed, severity, detail = '') { this.list.push({ code, passed, severity, detail }); }

  hardFailed() { return this.list.some((c) => !c.passed && c.severity === 'hard'); }

  report() {
    const failed = this.list.filter((c) => !c.passed && c.severity !== 'info');
    return { passed: !this.hardFailed(), checks: this.list,
      reasons: failed.map((c) => `${c.code}${c.severity === 'soft' ? ' (minor)' : ''}: ${c.detail}`) };
  }
}

// ---------------------------------------------------------------------------- 1. format
export function checkFormat(draft, combination, checks) {
  const plan = combination.questionPlan;
  const n = combination.optionsPerQuestion;
  const expected = OPTION_LABELS.slice(0, n);
  const qs = draft.questions;
  checks.add('format_question_count', qs.length === plan.length, 'hard',
    `${qs.length} questions, plan has ${plan.length}`);
  const order = qs.map((q) => q.orderIndex);
  checks.add('format_order', order.every((o, i) => o === i + 1), 'hard', `orderIndex ${order.join(',')}`);
  for (const q of qs) {
    const labels = q.options.map((o) => o.label);
    const id = `Q${q.orderIndex}`;
    if (labels.join() !== expected.join()) {
      checks.add('format_options', false, 'hard', `${id} options ${labels.join(',')}; expected ${expected.join(',')}`);
    }
    if (!labels.includes(q.correctAnswer)) checks.add('format_key', false, 'hard', `${id} key ${q.correctAnswer} is not an option`);
    const texts = q.options.map((o) => o.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) checks.add('format_duplicate_options', false, 'hard', `${id} has identical options`);
    const planned = plan[q.orderIndex - 1];
    if (planned && planned.answer !== q.correctAnswer) {
      checks.add('format_planned_key', false, 'soft', `${id} keyed ${q.correctAnswer}, plan says ${planned.answer}`);
    }
    if (planned && planned.type !== q.questionType) {
      checks.add('format_planned_type', false, 'soft', `${id} type ${q.questionType}, plan says ${planned.type}`);
    }
    const wrong = labels.filter((l) => l !== q.correctAnswer);
    const explained = new Set(q.distractorRationale.map((d) => d.label));
    if (!wrong.every((l) => explained.has(l))) {
      checks.add('format_rationale', false, 'soft', `${id} lacks a rationale for ${wrong.filter((l) => !explained.has(l)).join(',')}`);
    }
  }
  checkMarkup(draft, checks);
  if (!checks.list.some((c) => c.code.startsWith('format_') && !c.passed)) checks.add('format', true, 'info', 'ok');
}

// LaTeX, Markdown or HTML that the client would show raw. "$…$" only counts when it holds a LaTeX
// character, so prices such as "$5 and $10" pass.
const MARKUP = [
  [/\$[^$\n]*[\\_^{}][^$\n]*\$/, 'LaTeX math ($…$)'],
  [/\\(?:frac|times|cdot|mathrm|text|rightarrow|leftrightarrow|Delta|alpha|beta|mu|lambda|theta|pi|sqrt|circ|approx|le|ge)\b/, 'LaTeX command'],
  [/\\\(|\\\[/, 'LaTeX delimiter'],
  [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 'Markdown bold'],
  [/^#{1,6}\s/m, 'Markdown heading'],
  [/<\/?(?:b|i|em|strong|sub|sup|br|p|span|div)\b[^>]*>/i, 'HTML tag'],
];

export function checkMarkup(draft, checks) {
  const fields = [['title', draft.title], ...draft.body.map((p, i) => [`paragraph ${i + 1}`, p]),
    ...draft.figures.flatMap((f) => [[`${f.id} title`, f.title], [`${f.id} caption`, f.caption ?? '']]),
    ...draft.questions.flatMap((q) => [[`Q${q.orderIndex} stem`, q.stem],
      ...q.options.map((o) => [`Q${q.orderIndex} option ${o.label}`, o.text])])];
  for (const [where, text] of fields) {
    for (const [re, what] of MARKUP) {
      const m = re.exec(text);
      if (m) {
        checks.add('format_markup', false, 'hard', `${what} in ${where}: "${m[0].slice(0, 40)}" (write plain text with Unicode symbols)`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------- 2. length and reading level
export function checkLength(draft, rules, checks) {
  const { words, grade } = fleschKincaid(draftText(draft));
  const lw = rules.length_words;
  const inRange = words >= lw.min && words <= lw.max;
  const nearRange = words >= lw.min * (1 - LENGTH_TOLERANCE) && words <= lw.max * (1 + LENGTH_TOLERANCE);
  checks.add('length_words', inRange, inRange ? 'info' : nearRange ? 'soft' : 'hard',
    `${words} words; rules ${lw.min}–${lw.max}`);
  // Soft only: the rules' grade ranges were judged by the analysis model, while this is computed
  // Flesch–Kincaid, which ran 2–3 grades higher on the science corpus (and is noisy on extracted text).
  // Make it hard once the rules carry an FK-calibrated range.
  const rg = rules.reading_level_grade;
  const gradeOk = grade >= rg.min - GRADE_TOLERANCE && grade <= rg.max + GRADE_TOLERANCE;
  checks.add('reading_level', gradeOk, gradeOk ? 'info' : 'soft', `Flesch–Kincaid grade ${grade}; rules ${rg.min}–${rg.max}`);
}

// ---------------------------------------------------------------------------- 3. figures
const isNumeric = (v) => typeof v === 'number' || /^-?\d+(?:[.,]\d+)?(?:\s*%)?$/.test(String(v).trim());

export function checkFigures(draft, combination, rules, checks) {
  const figs = draft.figures;
  const ids = new Set(figs.map((f) => f.id));
  const problems = [];
  if (rules.figures.probability === 0 && figs.length) problems.push(['hard', `this subject has no figures, draft has ${figs.length}`]);
  if (figs.length !== combination.figures.length) {
    problems.push(['soft', `${figs.length} figures, plan has ${combination.figures.length}`]);
  }
  if (ids.size !== figs.length) problems.push(['hard', 'duplicate figure ids']);
  for (const f of figs) {
    if (f.kind === 'table') {
      const bad = f.rows.findIndex((r) => r.length !== f.columns.length);
      if (bad !== -1) problems.push(['hard', `${f.id}: row ${bad + 1} has ${f.rows[bad].length} cells for ${f.columns.length} columns`]);
      const numericCols = f.columns.filter((_, ci) => f.rows.every((r) => r[ci] !== undefined && isNumeric(r[ci])));
      if (!numericCols.length) problems.push(['soft', `${f.id}: no fully numeric column`]);
      const rule = rules.figures.kinds.find((k) => k.kind === 'table');
      if (rule && (f.rows.length < rule.rows.min || f.rows.length > rule.rows.max)) {
        problems.push(['soft', `${f.id}: ${f.rows.length} rows; rules ${rule.rows.min}–${rule.rows.max}`]);
      }
    } else {
      for (const s of f.series) {
        if (f.kind !== 'bar_chart' && s.points.length < 3) problems.push(['hard', `${f.id}: series "${s.name}" has ${s.points.length} points`]);
        const xs = s.points.map((p) => p[0]);
        if (f.kind === 'line_chart' && xs.some((x, i) => i > 0 && x <= xs[i - 1])) {
          problems.push(['soft', `${f.id}: series "${s.name}" x values are not increasing`]);
        }
        const cats = f.xAxis.categories;
        if (cats && xs.some((x) => !Number.isInteger(x) || x < 0 || x >= cats.length)) {
          problems.push(['hard', `${f.id}: series "${s.name}" uses x values outside its ${cats.length} categories`]);
        }
      }
    }
  }
  const text = draftText(draft).toLowerCase();
  for (const q of draft.questions) {
    if (q.figureRef && !ids.has(q.figureRef)) problems.push(['hard', `Q${q.orderIndex} refers to missing figure ${q.figureRef}`]);
    const planned = combination.questionPlan[q.orderIndex - 1];
    if (planned?.usesFigure && !q.figureRef) problems.push(['soft', `Q${q.orderIndex} should use a figure but has no figureRef`]);
  }
  for (const f of figs) {
    const n = f.id.replace('fig', '');
    const named = new RegExp(`\\b(table|figure|fig\\.?)\\s*\\(?${n}\\)?\\b`).test(text);
    if (!named && !draft.questions.some((q) => q.figureRef === f.id)) problems.push(['soft', `${f.id} is never referred to`]);
  }
  for (const [severity, detail] of problems) checks.add('figures', false, severity, detail);
  if (!problems.length) checks.add('figures', true, 'info', `${figs.length} figure(s) ok`);
}

// ---------------------------------------------------------------------------- 4–6
function studentView(draft) {
  return JSON.stringify({ title: draft.title, body: draft.body, figures: draft.figures,
    questions: draft.questions.map((q) => ({ orderIndex: q.orderIndex, stem: q.stem, options: q.options })) });
}

export async function createValidationAgent({ llm, model, embeddingModel, promptsDir, thresholds }) {
  const blind = await loadPrompt(promptsDir, BLIND_SOLVE_PROMPT);
  const review = await loadPrompt(promptsDir, REVIEW_PROMPT);
  return {
    promptVersions: [blind.version, review.version],
    model,
    /**
     * @returns {Promise<{report: object, embedding: number[] | null, contentHash: string | null,
     *   originality: object | null, blindSolve: object | null, review: object | null}>}
     */
    async validate({ draft, combination, rules, fingerprints, pool = [], ref }) {
      const checks = new Checks();
      const out = { embedding: null, contentHash: null, originality: null, blindSolve: null, review: null };
      checkFormat(draft, combination, checks);
      checkLength(draft, rules, checks);
      checkFigures(draft, combination, rules, checks);
      if (checks.hardFailed()) return { ...out, report: checks.report() };

      // 4. originality
      const text = draftText(draft);
      [out.embedding] = await llm.embed({ model: embeddingModel, texts: [text], ref });
      out.originality = checkOriginality({ text, embedding: out.embedding, fingerprints, pool, thresholds });
      out.contentHash = out.originality.contentHash;
      if (out.originality.passed) checks.add('originality', true, 'info', JSON.stringify(out.originality.scores));
      for (const r of out.originality.reasons) {
        const [code, ...detail] = r.split(': ');
        checks.add(code, false, 'hard', detail.join(': '));
      }
      if (checks.hardFailed()) return { ...out, report: checks.report() };

      // 5. blind solve (no key). A solver that skips questions is asked once more, so a solver
      // omission is not mistaken for a flaw in the passage.
      const solve = () => llm.generateStructured({ role: 'validation_blind_solve', model, prompt: blind.render({}),
        input: studentView(draft), schema: BlindSolveResult, temperature: 0, maxTokens: 4000, ref });
      const answered = (r) => new Set(r.answers.map((a) => a.orderIndex));
      out.blindSolve = await solve();
      if (draft.questions.some((q) => !answered(out.blindSolve).has(q.orderIndex))) out.blindSolve = await solve();
      const byIndex = new Map(out.blindSolve.answers.map((a) => [a.orderIndex, a]));
      for (const q of draft.questions) {
        const a = byIndex.get(q.orderIndex);
        if (!a) checks.add('blind_solve', false, 'hard', `Q${q.orderIndex}: not answered by the solver`);
        else if (a.answer !== q.correctAnswer) {
          checks.add('blind_solve', false, 'hard', `Q${q.orderIndex}: solver chose ${a.answer}, key is ${q.correctAnswer} (${a.reasoning})`);
        } else if (a.otherDefensible.filter((l) => l !== q.correctAnswer).length) {
          checks.add('blind_solve', false, 'hard', `Q${q.orderIndex}: ${a.otherDefensible.join(',')} also defensible (${a.reasoning})`);
        }
      }
      if (!checks.list.some((c) => c.code === 'blind_solve')) checks.add('blind_solve', true, 'info', 'all questions solved to the key');
      if (checks.hardFailed()) return { ...out, report: checks.report() };

      // 6. review (with key)
      out.review = await llm.generateStructured({ role: 'validation_review', model,
        prompt: review.render({ rules_excerpt: rulesExcerpt(rules, combination) }),
        input: JSON.stringify({ combination: { difficulty: combination.difficulty, styleId: combination.styleId },
          title: draft.title, body: draft.body, figures: draft.figures, questions: draft.questions }),
        schema: ReviewResult, temperature: 0, maxTokens: 4000, ref });
      for (const i of out.review.issues) {
        checks.add(`review_${i.code}`, false, i.severity, `${i.orderIndex ? `Q${i.orderIndex}: ` : ''}${i.detail}`);
      }
      if (!out.review.issues.length) checks.add('review', true, 'info', out.review.summary);
      return { ...out, report: checks.report() };
    },
  };
}
