// Feedback agent (PLAN.md §6.4): explains incorrect or unanswered questions, cache first.
// Cache key: (questionId, chosenAnswer, promptVersion); chosenAnswer is '' for unanswered. On a full
// cache hit no LLM call is made. If the LLM call fails, the explanations that are missing are left
// out (null) and the failure is logged; grading never fails because of feedback.
import { URT_UNANSWERED } from '../../../models/urtConstants.js';
import { FeedbackResult, MAX_EXPLANATION_WORDS } from '../contracts/feedback.js';
import { loadPrompt } from './promptKit.js';

export const FEEDBACK_PROMPT = 'feedback.v1';

export async function createFeedbackAgent({ llm, model, promptsDir, repo, logger = null }) {
  const prompt = await loadPrompt(promptsDir, FEEDBACK_PROMPT);
  const promptVersion = prompt.version;

  return {
    promptVersion,
    /**
     * @param {object} p
     * @param {object} p.passage   {title, body, figures}
     * @param {Array<{question: object, chosen: string|null}>} p.items  questions with their key
     * @returns {Promise<Map<number, string>>} questionId → explanation (missing on failure)
     */
    async explain({ passage, items, ref }) {
      const out = new Map();
      if (!items.length) return out;
      const keyOf = (it) => ({ questionId: it.question.id, chosenAnswer: it.chosen ?? URT_UNANSWERED, promptVersion });
      const keys = items.map(keyOf);
      const cached = await repo.getExplanations(keys);
      const hit = (it) => cached.find((c) => c.questionId === it.question.id && c.chosenAnswer === (it.chosen ?? URT_UNANSWERED));
      for (const it of items) {
        const c = hit(it);
        if (c) out.set(it.question.id, c.explanation);
      }
      const hits = items.filter(hit);
      if (hits.length) await repo.bumpExplanationHits(hits.map(keyOf));

      const misses = items.filter((it) => !hit(it));
      if (!misses.length) return out;
      try {
        const input = JSON.stringify({
          passage: { title: passage.title, paragraphs: passage.body.split(/\n{2,}/), figures: passage.figures ?? [] },
          questions: misses.map(({ question: q, chosen }) => ({
            questionId: q.id, orderIndex: q.orderIndex, question: q.question, options: q.options,
            correctAnswer: q.correctAnswer, studentAnswer: chosen ?? '(left blank)',
            distractorNote: chosen ? (q.distractorRationale ?? []).find((d) => d.label === chosen)?.whyWrong ?? null : null,
          })),
        });
        const result = await llm.generateStructured({ role: 'feedback', model, prompt: prompt.render({ max_words: MAX_EXPLANATION_WORDS }),
          input, schema: FeedbackResult, temperature: 0.3, maxTokens: 3000, ref });
        const wanted = new Map(misses.map((it) => [it.question.id, it]));
        const rows = [];
        for (const e of result.explanations) {
          const it = wanted.get(e.questionId);
          if (!it) continue; // ignore explanations for questions we did not ask about
          out.set(e.questionId, e.explanation.trim());
          rows.push({ ...keyOf(it), model, explanation: e.explanation.trim() });
        }
        await repo.putExplanations(rows);
      } catch (err) {
        logger?.error?.({ event: 'urt_feedback_failed', ref, error: err.message, missing: misses.length });
      }
      return out;
    },
  };
}
