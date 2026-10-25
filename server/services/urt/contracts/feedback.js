// The feedback agent's output (PLAN.md §6.4): one explanation per incorrect or unanswered question.
import { z } from 'zod';

export const MAX_EXPLANATION_WORDS = 120;

export const FeedbackResult = z.object({
  explanations: z.array(z.object({
    questionId: z.number().int().positive(),
    explanation: z.string().min(1).refine((s) => s.trim().split(/\s+/).length <= MAX_EXPLANATION_WORDS + 30,
      `explanations must be at most about ${MAX_EXPLANATION_WORDS} words`),
  })),
});
