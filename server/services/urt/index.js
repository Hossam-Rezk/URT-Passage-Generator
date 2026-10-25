// Wires the URT module together. The platform calls createUrtModule() once at startup (after the
// database is ready) and mounts the router from routes/urtPassageRoutes.js with the returned module.
import { createFeedbackAgent } from './agents/feedbackAgent.js';
import { createGenerationAgent } from './agents/generationAgent.js';
import { createValidationAgent } from './agents/validationAgent.js';
import { loadFingerprints } from './dedup/embeddingIndex.js';
import { createPassageProducer } from './generation/passageProducer.js';
import { createGradingService } from './grading/gradingService.js';
import { createGenerationJobs } from './jobs/generationJob.js';
import { createJobQueue } from './jobs/jobQueue.js';
import { createLlm } from './llm/llmClient.js';
import { createOpenAiCompatibleClient } from './llm/openaiCompatibleClient.js';
import { assertPriced, createCostLedger } from './observability/costLedger.js';
import { loadRules } from './rules/rulesLoader.js';
import { createFreshBufferService, startOfUtcDay } from './serving/freshBufferService.js';
import { createServingService } from './serving/servingService.js';

/**
 * @param {object} p
 * @param {object} p.config    loadUrtConfig()
 * @param {object} p.repo      createSequelizeRepository(...) (or the memory repository in tests/dev)
 * @param {object} [p.client]  LLM provider client; defaults to the OpenAI-compatible gateway
 * @param {object} [p.logger]  {info, warn, error} taking structured objects
 */
export async function createUrtModule({ config, repo, client = null, logger = null }) {
  const m = config.models;
  assertPriced(config.prices, [m.generation, m.validation, m.feedback, m.embedding]);
  const rules = await loadRules({ dir: config.rules.dir, allowDraft: config.rules.allowDraft, logger });
  const subjects = [...rules.keys()];
  const llmClient = client ?? createOpenAiCompatibleClient(config.llm);

  const fpCache = new Map();
  const fingerprints = (subject) => {
    if (!fpCache.has(subject)) {
      fpCache.set(subject, loadFingerprints({ dir: `${config.rules.dir}/fingerprints`, subject,
        embeddingModel: m.embedding, embeddingDims: m.embeddingDims }));
    }
    return fpCache.get(subject);
  };

  // Prompts are read once; each job gets agents bound to its own cost ledger.
  const llmFor = (ledger) => createLlm({ client: llmClient, ledger, maxRetries: config.llm.maxRetries, logger });
  const probe = llmFor(createCostLedger(config.prices));
  const promptVersions = {
    generation: (await createGenerationAgent({ llm: probe, model: m.generation, promptsDir: config.promptsDir })).promptVersion,
  };
  const makeProducer = (ledger) => {
    const llm = llmFor(ledger);
    const pending = Promise.all([
      createGenerationAgent({ llm, model: m.generation, promptsDir: config.promptsDir }),
      createValidationAgent({ llm, model: m.validation, embeddingModel: m.embedding, promptsDir: config.promptsDir,
        thresholds: config.originality }),
    ]);
    return {
      generationModel: m.generation,
      promptVersion: promptVersions.generation,
      embeddingModel: m.embedding,
      producer: {
        async produce(args) {
          const [generationAgent, validationAgent] = await pending;
          return createPassageProducer({ generationAgent, validationAgent, maxAttempts: config.generation.maxAttempts, logger })
            .produce(args);
        },
      },
    };
  };

  const jobs = createGenerationJobs({ repo, rules, fingerprints, makeProducer, prices: config.prices,
    recentTopicWindow: config.serving.recentTopicWindow, seed: config.samplerSeed, logger });
  const queue = createJobQueue({ maxConcurrent: config.generation.maxConcurrent, handler: jobs.run, logger });
  jobs.attachQueue(queue);

  const buffer = createFreshBufferService({ repo, jobs, subjects, low: config.generation.bufferLow,
    target: config.generation.bufferTarget, dailyCostCapUsd: config.generation.dailyCostCapUsd, logger });
  const serving = createServingService({ repo, jobs, buffer, subjects, recentTopicWindow: config.serving.recentTopicWindow,
    newStudentsGetFresh: config.serving.newStudentsGetFresh });

  // Feedback runs per request with a request-scoped ledger (cost is logged, not stored on a job).
  const feedbackAgent = (ledger) => createFeedbackAgent({ llm: llmFor(ledger), model: m.feedback, promptsDir: config.promptsDir,
    repo, logger });
  const feedback = {
    async explain(args) {
      const ledger = createCostLedger(config.prices);
      const out = await (await feedbackAgent(ledger)).explain(args);
      if (ledger.entries.length) logger?.info?.({ event: 'urt_feedback_cost', ref: args.ref, ...ledger.totals() });
      return out;
    },
  };
  const grading = createGradingService({ repo, feedback, logger });

  return {
    config, repo, rules, subjects, serving, grading, jobs, queue, buffer,
    stats: () => repo.stats({ since: startOfUtcDay() }),
  };
}
