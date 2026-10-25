// Produces one validated passage: sample → generate → validate → retry with the reasons, up to
// maxAttempts (PLAN.md §6.3). Every attempt is returned for the job log. Storage is the caller's
// job (generationJob, M7); toPassageRows() maps a result onto the urt_passages / questions models.
import { draftText } from '../contracts/passageDraft.js';
import { packF32 } from '../dedup/embeddingIndex.js';
import { words } from '../agents/readability.js';
import { sampleCombination } from '../selection/combinationSampler.js';

export function createPassageProducer({ generationAgent, validationAgent, maxAttempts, logger = null }) {
  return {
    /**
     * @param {object} p
     * @param {object} p.rules          the subject's rules
     * @param {object} p.fingerprints   loadFingerprints(...) for the subject
     * @param {() => number} p.rng
     * @param {string[]} [p.recentTopics]
     * @param {object} [p.poolStats]    {topics: {id: n}, difficulties: {d: n}}
     * @param {Array} [p.pool]          [{id, embedding}] stored passages of the subject
     * @param {object} [p.combination]  use this combination instead of sampling one (evaluation, re-runs)
     */
    async produce({ rules, fingerprints, rng, recentTopics = [], poolStats = null, pool = [], combination: fixed = null,
      onStage = null, ref }) {
      const combination = fixed ?? sampleCombination({ rules, rng, recentTopics, pool: poolStats });
      const attempts = [];
      let retry = null;
      for (let n = 1; n <= maxAttempts; n += 1) {
        await onStage?.('generating', n);
        const draft = await generationAgent.generate({ combination, rules, retry, ref: `${ref}:a${n}` });
        await onStage?.('validating', n);
        const v = await validationAgent.validate({ draft, combination, rules, fingerprints, pool, ref: `${ref}:a${n}` });
        attempts.push({ attempt: n, passed: v.report.passed, reasons: v.report.reasons });
        logger?.info?.({ event: 'urt_generation_attempt', ref, attempt: n, passed: v.report.passed,
          reasons: v.report.reasons.slice(0, 5) });
        if (v.report.passed) return { ok: true, combination, draft, validation: v, attempts };
        retry = { draft, reasons: v.report.reasons };
      }
      logger?.error?.({ event: 'urt_generation_failed', ref, attempts: attempts.length,
        lastReasons: attempts.at(-1)?.reasons.slice(0, 5) });
      return { ok: false, combination, attempts };
    },
  };
}

/** Row values for UrtPassage and its UrtPassageQuestion rows. */
export function toPassageRows(result, { generationModel, promptVersion, embeddingModel }) {
  const { combination, draft, validation } = result;
  const body = draftText(draft);
  return {
    passage: {
      subject: combination.subject, title: draft.title, body, figures: draft.figures.length ? draft.figures : null,
      wordCount: words(body).length, difficulty: combination.difficulty, topicId: combination.topicId,
      subtopicId: combination.subtopicId, styleId: combination.styleId, combination,
      rulesVersion: combination.rulesVersion, promptVersion, generationModel, status: 'validated',
      validationReport: validation.report, contentHash: validation.contentHash,
      embedding: validation.embedding ? packF32(validation.embedding) : null, embeddingModel,
    },
    questions: draft.questions.map((q) => ({
      orderIndex: q.orderIndex, type: 'multiple_choice', questionType: q.questionType, skill: q.skill,
      difficulty: q.difficulty, question: q.stem, options: q.options, correctAnswer: q.correctAnswer,
      distractorRationale: q.distractorRationale, figureRef: q.figureRef ?? null,
    })),
  };
}
