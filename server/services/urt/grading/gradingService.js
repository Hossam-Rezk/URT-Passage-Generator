// Grades a submission and attaches explanations for incorrect or unanswered questions (PLAN.md §6.4, §9).
// - Ownership is checked on every read and write; the answer key is used only here, server-side.
// - Unanswered questions count as incorrect and get an explanation.
// - A second submission returns 409 URT_ALREADY_SUBMITTED with the stored result.
import { z } from 'zod';
import { OPTION_LABELS } from '../contracts/combination.js';
import { UrtError, badRequest, forbidden, notFound } from '../errors.js';

export const SubmissionBody = z.object({
  answers: z.array(z.object({
    questionId: z.number().int().positive(),
    answer: z.enum(OPTION_LABELS).nullable(),
  })).max(50),
});

function resultFrom(questions, answerRows) {
  const byQ = new Map(answerRows.map((a) => [a.questionId, a]));
  const results = questions.map((q) => {
    const a = byQ.get(q.id);
    return { questionId: q.id, isCorrect: Boolean(a?.isCorrect), chosen: a?.answer ?? null, correctAnswer: q.correctAnswer };
  });
  return {
    score: results.filter((r) => r.isCorrect).length,
    total: results.length,
    results,
    explanations: answerRows.filter((a) => !a.isCorrect && a.explanation).map((a) => ({ questionId: a.questionId, explanation: a.explanation })),
  };
}

export function createGradingService({ repo, feedback, logger = null, now = () => new Date() }) {
  async function load(servingId, userId) {
    const s = await repo.getServingForGrading(servingId);
    if (!s) throw notFound('Serving');
    if (s.serving.userId !== userId) throw forbidden();
    return s;
  }

  return {
    /** The stored result, or null if not submitted yet. */
    async storedResult(servingId, userId) {
      const s = await load(servingId, userId);
      if (!s.serving.submittedAt) return null;
      return resultFrom(s.questions, await repo.getSubmission(servingId));
    },

    async submit({ servingId, userId, body }) {
      const parsed = SubmissionBody.safeParse(body);
      if (!parsed.success) throw badRequest('URT_INVALID_SUBMISSION', 'Invalid submission body', parsed.error.issues);
      const s = await load(servingId, userId);
      if (s.serving.submittedAt) {
        throw new UrtError(409, 'URT_ALREADY_SUBMITTED', 'This passage was already submitted',
          { result: resultFrom(s.questions, await repo.getSubmission(servingId)) });
      }
      const questionIds = new Set(s.questions.map((q) => q.id));
      const given = new Map();
      for (const a of parsed.data.answers) {
        if (!questionIds.has(a.questionId)) throw badRequest('URT_INVALID_SUBMISSION', `Question ${a.questionId} is not part of this passage`);
        if (given.has(a.questionId)) throw badRequest('URT_INVALID_SUBMISSION', `Question ${a.questionId} is answered twice`);
        given.set(a.questionId, a.answer);
      }
      for (const q of s.questions) {
        const ans = given.get(q.id);
        if (ans && !q.options.some((o) => o.label === ans)) throw badRequest('URT_INVALID_SUBMISSION', `Question ${q.id} has no option ${ans}`);
      }

      const graded = s.questions.map((q) => {
        const chosen = given.get(q.id) ?? null;
        return { question: q, chosen, isCorrect: chosen === q.correctAnswer };
      });
      const wrong = graded.filter((g) => !g.isCorrect);
      const explanations = await feedback.explain({ passage: s.passage, items: wrong, ref: `serving:${servingId}` });
      const answers = graded.map((g) => ({ questionId: g.question.id, answer: g.chosen, isCorrect: g.isCorrect,
        explanation: g.isCorrect ? null : explanations.get(g.question.id) ?? null }));
      const score = Number(((100 * (graded.length - wrong.length)) / Math.max(1, graded.length)).toFixed(2));
      const saved = await repo.saveSubmission(servingId, { answers, score, submittedAt: now() });
      if (!saved) {
        throw new UrtError(409, 'URT_ALREADY_SUBMITTED', 'This passage was already submitted',
          { result: resultFrom(s.questions, await repo.getSubmission(servingId)) });
      }
      logger?.info?.({ event: 'urt_submission_graded', servingId, score, wrong: wrong.length });
      return resultFrom(s.questions, answers);
    },
  };
}
