// The validation agent's report, and the two LLM sub-results it is built from (PLAN.md §6.3).
import { z } from 'zod';
import { DIFFICULTIES, OPTION_LABELS } from './combination.js';

export const CheckResult = z.object({
  code: z.string().min(1),
  passed: z.boolean(),
  severity: z.enum(['hard', 'soft', 'info']), // a failed hard check rejects the draft
  detail: z.string(),
});

export const ValidationReport = z.object({
  passed: z.boolean(),
  checks: z.array(CheckResult),
  reasons: z.array(z.string()), // coded reasons fed back to the generator on a retry
});

// Blind solve: answered without the key.
export const BlindSolveResult = z.object({
  answers: z.array(z.object({
    orderIndex: z.number().int().min(1),
    answer: z.enum(OPTION_LABELS),
    confidence: z.number().min(0).max(1),
    otherDefensible: z.array(z.enum(OPTION_LABELS)).default([]),
    reasoning: z.string(),
  })).min(1),
});

export const REVIEW_ISSUE_CODES = ['factual_error', 'arithmetic_error', 'ambiguity', 'weak_distractor',
  'difficulty_mismatch', 'anti_pattern', 'figure_unanswerable', 'figure_inconsistent', 'style_mismatch',
  'outside_knowledge', 'other'];

export const ReviewResult = z.object({
  issues: z.array(z.object({
    code: z.enum(REVIEW_ISSUE_CODES),
    severity: z.enum(['hard', 'soft']),
    orderIndex: z.number().int().min(1).nullable().default(null),
    detail: z.string().min(1),
  })),
  difficultyAssessed: z.enum(DIFFICULTIES),
  summary: z.string(),
});
