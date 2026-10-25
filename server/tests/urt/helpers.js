// Shared fixtures for the URT tests. The passage text is original test content written for these
// tests; it is not from any exam or book.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../../services/urt/rules/rulesLoader.js';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RULES_DIR = path.join(SERVER_DIR, 'urt', 'rules');
export const PROMPTS_DIR = path.join(SERVER_DIR, 'urt', 'prompts');
export const FINGERPRINTS_DIR = path.join(RULES_DIR, 'fingerprints');

// The fixture passage is about pendulums, which the approved physics rules do not list, so the test
// rules add it as a mechanics subtopic (otherwise the reviewer rightly reports a topic mismatch).
export const PENDULUM_SUBTOPIC = { id: 'pendulum_motion', label: 'Pendulum motion and its period', weight: 1 };

let cache;
export async function physicsRules() {
  cache ??= await loadRules({ dir: RULES_DIR });
  const rules = structuredClone(cache.get('physics').rules);
  rules.topics.find((t) => t.id === 'mechanics').subtopics.push({ ...PENDULUM_SUBTOPIC });
  return rules;
}

export const PARAGRAPHS = [
  'A simple pendulum is a small heavy ball hanging from a light string. When the ball is pulled to one side '
    + 'and released, it swings back and forth. The time for one complete swing, there and back, is called the '
    + 'period. Students in a school laboratory wanted to find out which properties of a pendulum change its period.',
  'In Experiment 1, the students kept the mass of the ball at 50 g and released it from a small angle. They '
    + 'changed the length of the string from 0.25 m to 1.00 m and timed ten swings for each length with a stopwatch. '
    + 'They divided each total by ten to find the period. Their results are shown in Table 1.',
  'In Experiment 2, the length stayed at 0.50 m while the mass of the ball was changed from 20 g to 80 g. The '
    + 'period did not change by more than the error of the stopwatch. In Experiment 3, the students used the 0.50 m '
    + 'pendulum again and released it from larger angles. For angles below about 15 degrees the period stayed '
    + 'almost the same, but at 60 degrees it was a little longer.',
  'A teacher explained that for small angles the period depends only on the length of the string and on the '
    + 'strength of gravity. A longer string gives a longer period, but the period does not grow in proportion to '
    + 'the length. When the length is made four times larger, the period becomes only two times larger. The '
    + 'students then plotted the period against the length to see the shape of this relationship for themselves.',
];

export function combination(overrides = {}) {
  return {
    subject: 'physics', topicId: 'mechanics', subtopicId: PENDULUM_SUBTOPIC.id, styleId: 'experiment_report',
    difficulty: 'medium', targetWords: 300,
    figures: [{ kind: 'table', size: { rows: 4, columns: 2 } }],
    questionPlan: [
      { orderIndex: 1, type: 'data_interpretation', skill: 'read a value', usesFigure: true, answer: 'B' },
      { orderIndex: 2, type: 'experimental_design', skill: 'identify the variable', usesFigure: false, answer: 'C' },
      { orderIndex: 3, type: 'calculation', skill: 'proportional scaling', usesFigure: true, answer: 'A' },
      { orderIndex: 4, type: 'inference', skill: 'predict', usesFigure: false, answer: 'D' },
    ],
    optionsPerQuestion: 4,
    rulesVersion: 'physics-2026.10.0',
    ...overrides,
  };
}

const opts = (texts) => texts.map((text, i) => ({ label: 'ABCD'[i], text }));
const rationale = (key) => 'ABCD'.split('').filter((l) => l !== key)
  .map((label) => ({ label, pattern: 'reversed trend', whyWrong: 'contradicts Table 1' }));

export function draft(overrides = {}) {
  return {
    title: 'Passage I: The period of a pendulum',
    body: [...PARAGRAPHS],
    figures: [{ id: 'fig1', kind: 'table', title: 'Table 1', columns: ['Length (m)', 'Period (s)'],
      rows: [[0.25, 1.0], [0.5, 1.42], [0.75, 1.74], [1.0, 2.01]] }],
    questions: [
      { orderIndex: 1, questionType: 'data_interpretation', skill: 'read a value', difficulty: 'easy',
        stem: 'According to Table 1, what was the period for a length of 0.50 m?',
        options: opts(['1.00 s', '1.42 s', '1.74 s', '2.01 s']), correctAnswer: 'B', figureRef: 'fig1',
        distractorRationale: rationale('B') },
      { orderIndex: 2, questionType: 'experimental_design', skill: 'identify the variable', difficulty: 'easy',
        stem: 'Which quantity was changed in Experiment 2?',
        options: opts(['The length', 'The angle', 'The mass', 'The stopwatch']), correctAnswer: 'C', figureRef: null,
        distractorRationale: rationale('C') },
      { orderIndex: 3, questionType: 'calculation', skill: 'proportional scaling', difficulty: 'medium',
        stem: 'Based on Table 1 and the teacher, what period would a 4.00 m pendulum most likely have?',
        options: opts(['About 4.0 s', 'About 8.0 s', 'About 2.0 s', 'About 16.0 s']), correctAnswer: 'A', figureRef: 'fig1',
        distractorRationale: rationale('A') },
      { orderIndex: 4, questionType: 'inference', skill: 'predict', difficulty: 'medium',
        stem: 'If a 100 g ball replaced the 50 g ball in Experiment 1, the periods would most likely:',
        options: opts(['double', 'halve', 'decrease slightly', 'stay about the same']), correctAnswer: 'D', figureRef: null,
        distractorRationale: rationale('D') },
    ],
    selfCheck: 'checked',
    ...overrides,
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
