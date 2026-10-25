// The generation agent's output (PLAN.md §6.2).
import { z } from 'zod';
import { DIFFICULTIES, OPTION_LABELS } from './combination.js';
import { Figure } from './figures.js';

export const Option = z.object({
  label: z.enum(OPTION_LABELS),
  text: z.string().min(1),
});

export const DistractorRationale = z.object({
  label: z.enum(OPTION_LABELS),
  pattern: z.string().min(1), // which distractor convention it uses
  whyWrong: z.string().min(1),
});

export const DraftQuestion = z.object({
  orderIndex: z.number().int().min(1),
  questionType: z.string().min(1),
  skill: z.string().min(1),
  difficulty: z.enum(DIFFICULTIES),
  stem: z.string().min(1),
  options: z.array(Option).min(2),
  correctAnswer: z.enum(OPTION_LABELS),
  distractorRationale: z.array(DistractorRationale),
  figureRef: z.string().nullable().optional(),
});

export const PassageDraft = z.object({
  title: z.string().min(1).max(255),
  body: z.array(z.string().min(1)).min(1), // paragraphs, in order
  figures: z.array(Figure).default([]),
  questions: z.array(DraftQuestion).min(1),
  selfCheck: z.string().optional(), // the model's own notes; logged, never stored or shown
});

export const draftText = (draft) => draft.body.join('\n\n');
