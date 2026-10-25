// HTTP handlers for /api/urt (docs/api/urt-passages.md). The student id always comes from
// req.user (set by the platform's userAuth), never from the request body.
import { UrtError, notFound, forbidden } from '../services/urt/errors.js';

// MERGE / OPEN-4: replace with the platform's error-response helper once its shape is confirmed.
export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

const parseId = (raw) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** A serving as the client sees it: never includes correctAnswer or distractor rationale. */
export function servingView({ serving, passage, questions }, result = null) {
  return {
    servingId: serving.id,
    passage: { id: passage.id, subject: passage.subject, title: passage.title, body: passage.body, figures: passage.figures ?? [] },
    questions: questions.map((q) => ({ id: q.id, orderIndex: q.orderIndex, question: q.question, options: q.options,
      figureRef: q.figureRef ?? null })),
    ...(result ? { result } : {}),
  };
}

export function createUrtPassageController(urt) {
  const pollMs = urt.config.serving.jobPollMs;

  async function servingResponse(servingId, userId) {
    const s = await urt.repo.getServing(servingId);
    if (!s) throw notFound('Serving');
    if (s.serving.userId !== userId) throw forbidden();
    return servingView(s, await urt.grading.storedResult(servingId, userId));
  }

  const jobPending = (job) => ({ jobId: job.id, status: job.status, retryAfterMs: pollMs, pollUrl: `/api/urt/jobs/${job.id}` });

  return {
    subjects(req, res) {
      res.json({ subjects: urt.subjects });
    },

    async next(req, res) {
      const out = await urt.serving.next({ userId: req.user.id, subject: req.body?.subject });
      if (out.job) return res.status(202).set('Retry-After', String(Math.ceil(pollMs / 1000))).json(jobPending(out.job));
      return res.json(await servingResponse(out.servingId, req.user.id));
    },

    async job(req, res) {
      const job = await urt.repo.getJob(req.params.jobId);
      if (!job) throw notFound('Job');
      if (job.userId !== req.user.id) throw forbidden();
      if (['queued', 'generating', 'validating'].includes(job.status)) {
        return res.status(202).set('Retry-After', String(Math.ceil(pollMs / 1000))).json(jobPending(job));
      }
      if (job.status === 'completed' && job.servingId) return res.json(await servingResponse(job.servingId, req.user.id));
      return sendError(res, 503, 'URT_GENERATION_UNAVAILABLE', 'No passage could be generated right now; please try again later');
    },

    async serving(req, res) {
      const id = parseId(req.params.servingId);
      if (!id) throw notFound('Serving');
      res.json(await servingResponse(id, req.user.id));
    },

    async submit(req, res) {
      const id = parseId(req.params.servingId);
      if (!id) throw notFound('Serving');
      res.json(await urt.grading.submit({ servingId: id, userId: req.user.id, body: req.body }));
    },

    async retire(req, res) {
      const id = parseId(req.params.id);
      const reason = String(req.body?.reason ?? '').trim();
      if (!id) throw notFound('Passage');
      if (!reason) throw new UrtError(400, 'URT_REASON_REQUIRED', 'A retirement reason is required');
      if (!(await urt.repo.retirePassage(id, reason.slice(0, 255)))) throw notFound('Passage');
      res.json({ id, status: 'retired' });
    },

    async stats(req, res) {
      res.json(await urt.stats());
    },
  };
}
