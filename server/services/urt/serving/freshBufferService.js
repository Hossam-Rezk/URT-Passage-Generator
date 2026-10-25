// Keeps a buffer of fresh (never served) passages per subject (PLAN.md §7.3): when it falls below
// `low`, refill jobs bring it back to `target`. Refills stop once today's generation spend reaches the
// daily cap (on-demand generation still runs); urt_buffer_empty and urt_daily_cost_cap_reached are
// raised as alerts.
export function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function createFreshBufferService({ repo, jobs, subjects, low, target, dailyCostCapUsd, logger = null, now = () => new Date() }) {
  const refilling = new Set(); // subjects with a refill decision in progress (avoids double enqueueing)

  async function refill(subject) {
    if (refilling.has(subject)) return 0;
    refilling.add(subject);
    try {
      const fresh = await repo.countFresh(subject);
      if (fresh === 0) logger?.error?.({ event: 'urt_buffer_empty', subject });
      if (fresh >= low) return 0;
      const pending = await repo.countPendingJobs(subject, 'buffer_refill');
      const need = target - fresh - pending;
      if (need <= 0) return 0;
      const spent = await repo.costSince(startOfUtcDay(now()));
      if (spent >= dailyCostCapUsd) {
        logger?.error?.({ event: 'urt_daily_cost_cap_reached', subject, spentUsd: spent, capUsd: dailyCostCapUsd });
        return 0;
      }
      for (let i = 0; i < need; i += 1) await jobs.enqueue({ subject, purpose: 'buffer_refill' });
      logger?.info?.({ event: 'urt_buffer_refill', subject, fresh, pending, enqueued: need });
      return need;
    } finally {
      refilling.delete(subject);
    }
  }

  return {
    refill,
    /** Fire-and-forget refill after a fresh passage was claimed. */
    refillAsync(subject) {
      refill(subject).catch((err) => logger?.error?.({ event: 'urt_buffer_refill_failed', subject, error: err.message }));
    },
    async refillAll() {
      let n = 0;
      for (const s of subjects) n += await refill(s);
      return n;
    },
  };
}
