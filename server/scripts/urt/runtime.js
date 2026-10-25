// Builds the URT generation runtime from the environment, for the scripts in this folder.
// Same wiring the generation job will use (M7), minus the database.
import { createGenerationAgent } from '../../services/urt/agents/generationAgent.js';
import { createValidationAgent } from '../../services/urt/agents/validationAgent.js';
import { loadUrtConfig } from '../../services/urt/config.js';
import { loadFingerprints } from '../../services/urt/dedup/embeddingIndex.js';
import { createPassageProducer } from '../../services/urt/generation/passageProducer.js';
import { createLlm } from '../../services/urt/llm/llmClient.js';
import { createOpenAiCompatibleClient } from '../../services/urt/llm/openaiCompatibleClient.js';
import { assertPriced, createCostLedger } from '../../services/urt/observability/costLedger.js';
import { loadRules } from '../../services/urt/rules/rulesLoader.js';

export class BudgetReachedError extends Error {}

const quietLogger = { info() {}, warn: (e) => console.warn(JSON.stringify(e)), error: (e) => console.error(JSON.stringify(e)) };

/** A ledger that refuses further calls once `maxUsd` is spent (checked before each call is recorded). */
function cappedLedger(prices, maxUsd) {
  const ledger = createCostLedger(prices);
  const record = ledger.record.bind(ledger);
  ledger.record = (entry) => {
    const cost = record(entry);
    if (ledger.totals().costUsd >= maxUsd) {
      throw new BudgetReachedError(`budget of $${maxUsd} reached ($${ledger.totals().costUsd.toFixed(4)} spent)`);
    }
    return cost;
  };
  return ledger;
}

export async function buildRuntime({ maxUsd, env = process.env, client = null }) {
  const config = loadUrtConfig(env);
  assertPriced(config.prices, [config.models.generation, config.models.validation, config.models.embedding]);
  const ledger = cappedLedger(config.prices, maxUsd);
  const llm = createLlm({ client: client ?? createOpenAiCompatibleClient(config.llm), ledger,
    maxRetries: config.llm.maxRetries, logger: quietLogger });
  const rules = await loadRules({ dir: config.rules.dir, allowDraft: config.rules.allowDraft });
  const generationAgent = await createGenerationAgent({ llm, model: config.models.generation, promptsDir: config.promptsDir });
  const validationAgent = await createValidationAgent({ llm, model: config.models.validation,
    embeddingModel: config.models.embedding, promptsDir: config.promptsDir, thresholds: config.originality });
  const producer = createPassageProducer({ generationAgent, validationAgent, maxAttempts: config.generation.maxAttempts,
    logger: quietLogger });
  const fingerprints = (subject) => loadFingerprints({ dir: `${config.rules.dir}/fingerprints`, subject,
    embeddingModel: config.models.embedding, embeddingDims: config.models.embeddingDims });
  return { config, ledger, llm, rules, generationAgent, validationAgent, producer, fingerprints };
}

/** Minimal `--flag value` / `--flag` parser. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  return out;
}
