// /api/urt routes (PLAN.md §9, docs/api/urt-passages.md).
// MERGE: mount with the platform's middleware, e.g.
//   app.use('/api/urt', createUrtRouter({ urt, auth: [userAuth, checkAgent], requireAdmin: <admin/teacher check> }));
// `auth` must set req.user = { id, role }. Electron/Capacitor requests keep the platform's HMAC middleware.
import { json, Router } from 'express';
import { createUrtPassageController, sendError } from '../controllers/urtPassageController.js';
import { UrtError } from '../services/urt/errors.js';

/** Per-student fixed-window limiter for POST /passages/next. MERGE / OPEN-4: swap for the platform's limiter. */
export function createPerUserRateLimit({ perMinute, now = () => Date.now() }) {
  const windows = new Map();
  return (req, res, next) => {
    const key = req.user.id;
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60000) {
      windows.set(key, { start: t, count: 1 });
      return next();
    }
    if (w.count >= perMinute) {
      res.set('Retry-After', String(Math.ceil((w.start + 60000 - t) / 1000)));
      return sendError(res, 429, 'URT_RATE_LIMITED', `At most ${perMinute} new passages per minute`);
    }
    w.count += 1;
    return next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createUrtRouter({ urt, auth, requireAdmin, studentRoles = ['student'], rateLimit = null, logger = null }) {
  const c = createUrtPassageController(urt);
  const router = Router();
  const authChain = Array.isArray(auth) ? auth : [auth];
  const students = (req, res, next) => (studentRoles.includes(req.user?.role) ? next()
    : sendError(res, 403, 'URT_FORBIDDEN', 'Only students can use this endpoint'));
  const limiter = rateLimit ?? createPerUserRateLimit({ perMinute: urt.config.serving.nextRateLimitPerMin });

  router.use(json({ limit: '64kb' })); // no-op if the platform already parsed the body
  router.use(...authChain);
  router.get('/subjects', students, wrap(c.subjects));
  router.post('/passages/next', students, limiter, wrap(c.next));
  router.get('/jobs/:jobId', students, wrap(c.job));
  router.get('/servings/:servingId', students, wrap(c.serving));
  router.post('/servings/:servingId/submission', students, wrap(c.submit));
  router.post('/admin/passages/:id/retire', requireAdmin, wrap(c.retire));
  router.get('/admin/stats', requireAdmin, wrap(c.stats));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof UrtError) {
      const { status, code, message, ...extra } = err;
      delete extra.stack;
      return sendError(res, status, code, message, extra);
    }
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'URT_INVALID_JSON', 'Request body is not valid JSON');
    logger?.error?.({ event: 'urt_route_error', path: req.path, error: err.message });
    return sendError(res, 500, 'URT_INTERNAL', 'Something went wrong');
  });
  return router;
}
