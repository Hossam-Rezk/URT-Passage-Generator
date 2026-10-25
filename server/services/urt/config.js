// URT module configuration, parsed and validated from the environment (PLAN.md §10).
// loadUrtConfig() throws with every problem listed, so a bad deployment fails loudly at startup.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const num = (def, check = (s) => s) => z.coerce.number().pipe(check(z.number())).default(def);
const prob = (def) => num(def, (s) => s.min(0).max(1));

const schema = z.object({
  // Credentials and provider. Only the OpenAI-compatible gateway is implemented; see llm/llmClient.js.
  URT_LLM_PROVIDER: z.enum(['openai']).default('openai'),
  URT_OPENAI_BASE_URL: z.string().url(),
  URT_OPENAI_API_KEY: z.string().min(1),

  // Models, one per role
  URT_MODEL_GENERATION: z.string().min(1).default('gemini-3.8-flash'),
  URT_MODEL_VALIDATION: z.string().min(1).default('gemini-2.5-flash'),
  URT_MODEL_FEEDBACK: z.string().min(1).default('gemini-2.5-flash-lite'),
  URT_MODEL_EMBEDDING: z.string().min(1).default('text-embedding-3-small'),
  URT_EMBEDDING_DIMS: num(1536, (s) => s.int().positive()),

  // Generation
  URT_MAX_GENERATION_ATTEMPTS: num(3, (s) => s.int().min(1).max(10)),
  URT_MAX_CONCURRENT_GENERATIONS: num(2, (s) => s.int().min(1)),
  URT_FRESH_BUFFER_TARGET: num(15, (s) => s.int().min(0)),
  URT_FRESH_BUFFER_LOW: num(5, (s) => s.int().min(0)),
  URT_DAILY_COST_CAP_USD: num(5, (s) => s.positive()),
  URT_LLM_TIMEOUT_MS: num(180000, (s) => s.int().positive()),
  URT_LLM_MAX_RETRIES: num(3, (s) => s.int().min(0).max(10)),

  // Originality thresholds (Phase 1 calibration: server/urt/rules/fingerprints/calibration.json)
  URT_MAX_CORPUS_JACCARD: prob(0.2),
  URT_MAX_CORPUS_COSINE: prob(0.85),
  URT_MAX_POOL_COSINE: prob(0.85),

  // Rules
  URT_RULES_DIR: z.string().default(path.join(SERVER_DIR, 'urt', 'rules')),
  URT_PROMPTS_DIR: z.string().default(path.join(SERVER_DIR, 'urt', 'prompts')),
  URT_ALLOW_DRAFT_RULES: bool.default('false'),

  // Serving
  URT_RECENT_TOPIC_WINDOW: num(5, (s) => s.int().min(0)),
  URT_JOB_POLL_MS: num(3000, (s) => s.int().positive()),
  URT_NEXT_RATE_LIMIT_PER_MIN: num(10, (s) => s.int().positive()),
  URT_SAMPLER_SEED: z.string().optional(),
  // OPEN-1: true = a student with fewer than 2 servings always gets fresh passages (PLAN's reading);
  // false = only rule 2 applies, so stored passages are reused for new students too (cheaper launch).
  URT_NEW_STUDENTS_GET_FRESH: bool.default('true'),

  // Prices in US$ per 1M tokens, as JSON {"model": {"input": n, "output": n}}; used by the cost ledger.
  URT_MODEL_PRICES: z.string().optional(),
}).superRefine((c, ctx) => {
  if (c.URT_FRESH_BUFFER_LOW > c.URT_FRESH_BUFFER_TARGET) {
    ctx.addIssue({ code: 'custom', path: ['URT_FRESH_BUFFER_LOW'], message: 'must be <= URT_FRESH_BUFFER_TARGET' });
  }
  if (c.URT_MODEL_GENERATION === c.URT_MODEL_VALIDATION) {
    ctx.addIssue({ code: 'custom', path: ['URT_MODEL_VALIDATION'],
      message: 'must differ from URT_MODEL_GENERATION (the generator must not grade its own work)' });
  }
});

// Default prices (US$ per 1M tokens). Verify before relying on them; override with URT_MODEL_PRICES.
export const DEFAULT_PRICES = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 }, // introductory rate until 2026-12-31
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

export class UrtConfigError extends Error {}

export function loadUrtConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new UrtConfigError(`Invalid URT configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  let prices = DEFAULT_PRICES;
  if (c.URT_MODEL_PRICES) {
    try {
      prices = { ...DEFAULT_PRICES, ...JSON.parse(c.URT_MODEL_PRICES) };
    } catch {
      throw new UrtConfigError('Invalid URT configuration:\n  URT_MODEL_PRICES: not valid JSON');
    }
  }
  return Object.freeze({
    llm: { provider: c.URT_LLM_PROVIDER, baseUrl: c.URT_OPENAI_BASE_URL, apiKey: c.URT_OPENAI_API_KEY,
      timeoutMs: c.URT_LLM_TIMEOUT_MS, maxRetries: c.URT_LLM_MAX_RETRIES },
    models: { generation: c.URT_MODEL_GENERATION, validation: c.URT_MODEL_VALIDATION, feedback: c.URT_MODEL_FEEDBACK,
      embedding: c.URT_MODEL_EMBEDDING, embeddingDims: c.URT_EMBEDDING_DIMS },
    generation: { maxAttempts: c.URT_MAX_GENERATION_ATTEMPTS, maxConcurrent: c.URT_MAX_CONCURRENT_GENERATIONS,
      bufferTarget: c.URT_FRESH_BUFFER_TARGET, bufferLow: c.URT_FRESH_BUFFER_LOW, dailyCostCapUsd: c.URT_DAILY_COST_CAP_USD },
    originality: { maxCorpusJaccard: c.URT_MAX_CORPUS_JACCARD, maxCorpusCosine: c.URT_MAX_CORPUS_COSINE,
      maxPoolCosine: c.URT_MAX_POOL_COSINE },
    rules: { dir: c.URT_RULES_DIR, allowDraft: c.URT_ALLOW_DRAFT_RULES },
    promptsDir: c.URT_PROMPTS_DIR,
    serving: { recentTopicWindow: c.URT_RECENT_TOPIC_WINDOW, jobPollMs: c.URT_JOB_POLL_MS,
      nextRateLimitPerMin: c.URT_NEXT_RATE_LIMIT_PER_MIN, newStudentsGetFresh: c.URT_NEW_STUDENTS_GET_FRESH },
    samplerSeed: c.URT_SAMPLER_SEED,
    prices,
  });
}
