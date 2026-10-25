// What the combination sampler chooses for one passage (PLAN.md §6.1).
import { z } from 'zod';
import { FIGURE_KINDS } from './figures.js';

export const SUBJECTS = ['physics', 'chemistry', 'geology', 'biology', 'english'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];

export const FigurePlan = z.object({
  kind: z.enum(FIGURE_KINDS),
  // tables: rows and columns; charts: series and points per series
  size: z.object({
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
    series: z.number().int().positive().optional(),
    points: z.number().int().positive().optional(),
  }),
});

export const QuestionPlanItem = z.object({
  orderIndex: z.number().int().min(1),
  type: z.string().min(1),
  skill: z.string().min(1),
  usesFigure: z.boolean(),
  answer: z.enum(OPTION_LABELS), // planned correct option, so answer positions stay balanced
});

export const Combination = z.object({
  subject: z.enum(SUBJECTS),
  topicId: z.string().min(1),
  subtopicId: z.string().min(1),
  styleId: z.string().min(1),
  difficulty: z.enum(DIFFICULTIES),
  targetWords: z.number().int().positive(),
  figures: z.array(FigurePlan),
  questionPlan: z.array(QuestionPlanItem).min(1),
  optionsPerQuestion: z.number().int().min(2).max(5),
  rulesVersion: z.string().min(1),
});
