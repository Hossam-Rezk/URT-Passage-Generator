// Token and cost accounting for one unit of work (a generation job, a feedback request).
// Prices are US$ per 1M tokens; an unpriced model is an error so spend can never go unrecorded.
export class UnknownModelPriceError extends Error {}

export function assertPriced(prices, models) {
  const missing = [...new Set(models)].filter((m) => !prices[m]);
  if (missing.length) throw new UnknownModelPriceError(`No price configured for: ${missing.join(', ')}`);
}

export function createCostLedger(prices) {
  const entries = [];
  return {
    entries,
    record({ role, model, inputTokens = 0, outputTokens = 0, ref = null }) {
      const price = prices[model];
      if (!price) throw new UnknownModelPriceError(`No price configured for model '${model}'`);
      const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
      entries.push({ role, model, inputTokens, outputTokens, costUsd, ref, at: new Date().toISOString() });
      return costUsd;
    },
    totals() {
      const sum = (k) => entries.reduce((s, e) => s + e[k], 0);
      const byRole = {};
      for (const e of entries) {
        const r = (byRole[e.role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
        r.calls += 1;
        r.inputTokens += e.inputTokens;
        r.outputTokens += e.outputTokens;
        r.costUsd += e.costUsd;
      }
      return { calls: entries.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        costUsd: sum('costUsd'), byRole };
    },
  };
}
