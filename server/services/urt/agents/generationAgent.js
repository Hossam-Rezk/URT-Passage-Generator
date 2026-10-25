// Generation agent (PLAN.md §6.2): writes one passage for a sampled combination.
// It sees the combination and the matching rules excerpt, never a source passage.
import { PassageDraft } from '../contracts/passageDraft.js';
import { loadPrompt, rulesExcerpt } from './promptKit.js';

export const GENERATION_PROMPT = 'generation.v2';

export async function createGenerationAgent({ llm, model, promptsDir }) {
  const prompt = await loadPrompt(promptsDir, GENERATION_PROMPT);
  return {
    promptVersion: prompt.version,
    model,
    /**
     * @param {object} p
     * @param {object} p.combination      sampled Combination
     * @param {object} p.rules            the subject's rules
     * @param {{draft: object, reasons: string[]}} [p.retry]  the previous attempt and why it failed
     */
    async generate({ combination, rules, retry = null, ref }) {
      const system = prompt.render({
        rules_excerpt: rulesExcerpt(rules, combination),
        target_words: combination.targetWords,
        options_per_question: combination.optionsPerQuestion,
      });
      const { rulesVersion, ...plan } = combination;
      let input = `Combination to follow:\n${JSON.stringify(plan, null, 2)}`;
      if (retry) {
        const { selfCheck, ...previous } = retry.draft;
        input += `\n\nYour previous attempt was rejected. Fix every problem below and return a complete new JSON object.\n`
          + `Problems:\n${retry.reasons.map((r) => `- ${r}`).join('\n')}\n\nPrevious attempt:\n${JSON.stringify(previous)}`;
      }
      return llm.generateStructured({ role: 'generation', model, prompt: system, input, schema: PassageDraft,
        temperature: 0.8, maxTokens: 12000, ref });
    },
  };
}
