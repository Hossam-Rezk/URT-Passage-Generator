// A small in-process priority queue with a concurrency cap (PLAN.md §7.2: on-demand jobs before refills).
// MERGE: the platform has server/services/jobQueueService.js. Replace this with a thin adapter onto it
// (enqueue(jobId, priority) -> jobQueueService job; run handler) if it supports priorities and a
// concurrency limit; the rest of the URT code only uses enqueue() and idle().
export const PRIORITY = { on_demand: 0, seed: 1, buffer_refill: 2 };

export function createJobQueue({ maxConcurrent, handler, logger = null }) {
  const waiting = []; // [{jobId, priority, seq}]
  let running = 0;
  let seq = 0;
  let idleWaiters = [];

  function settleIdle() {
    if (running === 0 && waiting.length === 0) {
      idleWaiters.forEach((r) => r());
      idleWaiters = [];
    }
  }

  function pump() {
    while (running < maxConcurrent && waiting.length) {
      waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const { jobId } = waiting.shift();
      running += 1;
      Promise.resolve()
        .then(() => handler(jobId))
        .catch((err) => logger?.error?.({ event: 'urt_job_crashed', jobId, error: err.message }))
        .finally(() => {
          running -= 1;
          pump();
          settleIdle();
        });
    }
  }

  return {
    enqueue(jobId, priority = PRIORITY.buffer_refill) {
      waiting.push({ jobId, priority, seq: (seq += 1) });
      pump();
    },
    /** Resolves when nothing is running or waiting (tests, graceful shutdown). */
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
    get size() { return { running, waiting: waiting.length }; },
  };
}
