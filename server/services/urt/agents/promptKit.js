// Prompt files and the rules excerpt shared by the agents.
// Prompts live in server/urt/prompts/<name>.v<N>.md; `{{key}}` placeholders are filled by render().
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadPrompt(dir, name) {
  const text = await readFile(path.join(dir, `${name}.md`), 'utf8');
  return {
    version: name,
    render(vars) {
      return text.replace(/\{\{(\w+)\}\}/g, (m, key) => {
        if (!(key in vars)) throw new Error(`prompt ${name}: no value for {{${key}}}`);
        return String(vars[key]);
      });
    },
  };
}

const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');

/**
 * The parts of a subject's rules that apply to one combination, as Markdown. Only rules text goes
 * in; the rules contain descriptions of the source style, never source passages.
 */
export function rulesExcerpt(rules, combination) {
  const topic = rules.topics.find((t) => t.id === combination.topicId);
  const subtopic = topic?.subtopics.find((s) => s.id === combination.subtopicId);
  const style = rules.styles.find((s) => s.id === combination.styleId);
  const level = rules.difficulty_levels[combination.difficulty];
  const typeIds = new Set(combination.questionPlan.map((q) => q.type));
  const types = rules.question_set.types.filter((t) => typeIds.has(t.id));
  const kinds = new Set(combination.figures.map((f) => f.kind));
  const figureRules = rules.figures.kinds.filter((k) => kinds.has(k.kind));
  const parts = [
    `## Subject: ${rules.subject}`,
    `Topic: ${topic?.label ?? combination.topicId} — ${subtopic?.label ?? combination.subtopicId}`,
    `Length: ${rules.length_words.min}–${rules.length_words.max} words; reading level US grade `
      + `${rules.reading_level_grade.min}–${rules.reading_level_grade.max}.`,
    `## Style: ${style.label}`, style.description, `Structure:\n${bullets(style.structure)}`,
    `## Difficulty: ${combination.difficulty}`, level.definition,
    `Passage markers:\n${bullets(level.passage_markers)}`, `Question markers:\n${bullets(level.question_markers)}`,
    '## Question types in this set',
    ...types.map((t) => `- **${t.id}** (${t.label}): ${t.description} Skills: ${t.skills.join('; ')}.`),
  ];
  if (rules.question_set.stem_conventions?.length) parts.push(`Stem conventions:\n${bullets(rules.question_set.stem_conventions)}`);
  if (figureRules.length) {
    parts.push('## Figure conventions', ...figureRules.map((k) => `${k.kind}:\n${bullets(k.conventions ?? [])}`));
  }
  parts.push(`## Distractors\n${bullets(rules.distractor_conventions)}`,
    `## Answer conventions\n${bullets(rules.answer_conventions)}`,
    `## Never do this\n${bullets(rules.anti_patterns)}`);
  return parts.join('\n\n');
}
