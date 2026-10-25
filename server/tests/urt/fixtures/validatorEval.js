// Validator evaluation set (PLAN.md §13): deliberately flawed passages the validator must reject,
// plus a clean control it must accept. Built from the original pendulum test passage in helpers.js.
// A near-copy case needs a real source passage, so scripts/urt/evalValidator.js adds it at run time
// from the local, gitignored corpus data; no source text is stored here.
import { combination, draft } from '../helpers.js';

function variant(id, flaw, expected, mutate) {
  const d = draft();
  mutate?.(d);
  return { id, flaw, expected, combination: combination(), draft: d };
}

export const validatorEvalCases = [
  variant('control', 'none (clean passage)', 'accept'),

  variant('two_correct', 'two options are both correct', 'reject', (d) => {
    d.questions[1].options[0].text = 'The mass of the ball'; // C is "The mass" too
  }),

  variant('wrong_key', 'the keyed answer contradicts Table 1', 'reject', (d) => {
    d.questions[0].correctAnswer = 'C'; // 1.74 s is the 0.75 m value
    d.questions[0].distractorRationale = d.questions[0].distractorRationale.map((r) => (r.label === 'C' ? { ...r, label: 'B' } : r));
  }),

  variant('factual_error', 'states that the period grows in proportion to the length (physically wrong), consistently',
    'reject', (d) => {
      d.body[3] = d.body[3].replace('but the period does not grow in proportion to the length. When the length is made four '
        + 'times larger, the period becomes only two times larger.', 'and the period grows in direct proportion to the '
        + 'length. When the length is made four times larger, the period also becomes four times larger.');
      d.figures[0].rows = [[0.25, 0.5], [0.5, 1.0], [0.75, 1.5], [1.0, 2.0]];
      d.questions[0].options[1].text = '1.00 s';
      d.questions[0].options[0].text = '0.50 s';
      d.questions[2].options = [{ label: 'A', text: 'About 8.0 s' }, { label: 'B', text: 'About 4.0 s' },
        { label: 'C', text: 'About 2.0 s' }, { label: 'D', text: 'About 16.0 s' }];
    }),

  variant('figure_contradiction', 'Table 1 shows the period falling as the string gets longer, contradicting the text',
    'reject', (d) => {
      d.figures[0].rows = [[0.25, 2.01], [0.5, 1.42], [0.75, 1.16], [1.0, 1.0]];
    }),

  variant('arithmetic_error', 'the keyed calculation is wrong (no option is correct)', 'reject', (d) => {
    d.questions[2].options[0].text = 'About 3.0 s'; // doubling 2.01 s gives about 4.0 s
  }),

  variant('anti_pattern', 'uses a "none of the above" option, which the rules forbid', 'reject', (d) => {
    d.questions[3].options[3].text = 'None of the above';
    d.questions[3].correctAnswer = 'D';
  }),

  variant('figure_unanswerable', 'a figure question asks for a value the table does not contain', 'reject', (d) => {
    d.questions[0].stem = 'According to Table 1, what was the period for a length of 0.60 m?';
  }),
];
