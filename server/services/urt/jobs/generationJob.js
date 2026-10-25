// Generation job lifecycle (PLAN.md §7.2): queued → generating → validating → completed | failed.
// - On-demand jobs record the student's serving themselves (source 'generated'), so a late poll still
//   gets the passage.
// - When every attempt fails (or the run throws), an on-demand job falls back to any unseen validated
//   passage in the subject and raises urt_generation_failed / urt_fallback_served; if there is none,
//   the job fails with URT_GENERATION_UNAVAILABLE.
// - Each job has its own cost ledger; tokens and cost are stored on the job row.
import { DuplicateError } from '../errors.js';
import { toPassageRows } from '../generation/passageProducer.js';
import { createCostLedger } from '../observability/costLedger.js';
import { createRng } from '../selection/combinationSampler.js';
import { PRIORITY } from './jobQueue.js';

export const GENERATION_UNAVAILABLE = 'URT_GENERATION_UNAVAILABLE';

/**
 * @param {object} d
 * @param {object} d.repo
 * @param {Map} d.rules                  loadRules(...) result
 * @param {(subject) => Promise<object>} d.fingerprints
 * @param {(ledger) => {producer, generationModel, promptVersion, embeddingModel}} d.makeProducer
 * @param {object} d.prices
 * @param {object} d.queue               createJobQueue(...) or an adapter with enqueue(jobId, priority)
 * @param {number} d.recentTopicWindow
 * @param {string} [d.seed]              URT_SAMPLER_SEED (tests)
 */
export function createGenerationJobs({ repo, rules, fingerprints, makeProducer, prices, recentTopicWindow,
  seed = null, logger = null }) {
  let queue = null;
  let runs = 0;

  async function finish(job, patch, ledger) {
    const t = ledger.totals();
    await repo.updateJob(job.id, { ...patch, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      costUsd: Number(t.costUsd.toFixed(6)), finishedAt: new Date() });
  }

  async function fallback(job, ledger, failureReasons, errorMessage) {
    logger?.error?.({ event: 'urt_generation_failed', jobId: job.id, subject: job.subject, purpose: job.purpose,
      error: errorMessage });
    if (job.purpose === 'on_demand' && job.userId != null) {
      const serving = await repo.serveAnyUnseen(job.userId, job.subject, { jobId: job.id }).catch(() => null);
      if (serving) {
        logger?.error?.({ event: 'urt_fallback_served', jobId: job.id, servingId: serving.id, passageId: serving.passageId });
        return finish(job, { status: 'completed', servingId: serving.id, failureReasons, errorMessage }, ledger);
      }
    }
    return finish(job, { status: 'failed', failureReasons, errorMessage: errorMessage ?? GENERATION_UNAVAILABLE }, ledger);
  }

  async function run(jobId) {
    const job = await repo.getJob(jobId);
    if (!job || job.status !== 'queued') return;
    const ledger = createCostLedger(prices);
    await repo.updateJob(jobId, { status: 'generating', startedAt: new Date() });
    try {
      const subjectRules = rules.get(job.subject)?.rules;
      if (!subjectRules) throw new Error(`no rules loaded for ${job.subject}`);
      const { producer, generationModel, promptVersion, embeddingModel } = makeProducer(ledger);
      const result = await producer.produce({
        rules: subjectRules,
        fingerprints: await fingerprints(job.subject),
        rng: createRng(seed ? `${seed}:${(runs += 1)}` : `${jobId}:${Date.now()}`),
        recentTopics: job.userId != null ? await repo.recentTopics(job.userId, recentTopicWindow) : [],
        poolStats: await repo.poolStats(job.subject),
        pool: await repo.poolEmbeddings(job.subject),
        onStage: (status, attempt) => repo.updateJob(jobId, { status, attempts: attempt }),
        ref: jobId,
      });
      const failureReasons = result.attempts.filter((a) => !a.passed).map((a) => ({ attempt: a.attempt, reasons: a.reasons }));
      await repo.updateJob(jobId, { combination: result.combination, attempts: result.attempts.length });
      if (!result.ok) return await fallback(job, ledger, failureReasons, 'all generation attempts failed validation');

      let passageId;
      try {
        passageId = await repo.insertPassage(toPassageRows(result, { generationModel, promptVersion, embeddingModel }));
      } catch (err) {
        if (err instanceof DuplicateError) return await fallback(job, ledger, failureReasons, 'duplicate passage content');
        throw err;
      }
      let servingId = null;
      if (job.purpose === 'on_demand' && job.userId != null) {
        const serving = await repo.serveSpecific(job.userId, passageId, 'generated', { jobId }).catch((err) => {
          if (err instanceof DuplicateError) return null;
          throw err;
        });
        servingId = serving?.id ?? null;
      }
      logger?.info?.({ event: 'urt_generation_completed', jobId, passageId, attempts: result.attempts.length,
        costUsd: ledger.totals().costUsd });
      return await finish(job, { status: 'completed', passageId, servingId, failureReasons: failureReasons.length ? failureReasons : null }, ledger);
    } catch (err) {
      return fallback(job, ledger, null, `${err.name}: ${err.message}`);
    }
  }

  return {
    run,
    attachQueue(q) { queue = q; },
    async enqueue({ subject, userId = null, purpose }) {
      const job = await repo.createJob({ subject, userId, purpose });
      queue.enqueue(job.id, PRIORITY[purpose]);
      return job;
    },
  };
}
