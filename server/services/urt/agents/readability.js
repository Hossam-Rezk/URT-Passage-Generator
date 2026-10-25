// Word count and Flesch–Kincaid grade level, used by validation check 2.
// The syllable count is a standard heuristic (vowel groups, silent final e), good to about ±1 grade.

export function words(text) {
  return text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g) ?? [];
}

export function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1; // numbers read as one unit
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function sentenceCount(text) {
  const n = (text.match(/[.!?]+(?=\s|$)/g) ?? []).length;
  return Math.max(1, n);
}

/** @returns {{words: number, sentences: number, syllables: number, grade: number}} */
export function fleschKincaid(text) {
  const ws = words(text);
  const sentences = sentenceCount(text);
  const syllables = ws.reduce((s, w) => s + countSyllables(w), 0);
  const n = Math.max(1, ws.length);
  const grade = 0.39 * (n / sentences) + 11.8 * (syllables / n) - 15.59;
  return { words: ws.length, sentences, syllables, grade: Math.round(grade * 10) / 10 };
}
