// Chooses the next passage for a student (PLAN.md §7.1).
//
//   needFresh = (fewer than 2 servings and newStudentsGetFresh) or (the last 2 servings were both 'reused')
//   needFresh → claim a fresh passage ('generated'); none left → enqueue an on-demand job (202)
//   otherwise → an already-served passage the student has not seen, preferring topics outside their
//               recent topics, then the least-served ('reused'); none → fresh; none → job (202)
//
// One request per student at a time (repository lock); an active on-demand job is returned again
// instead of starting a second one. A duplicate-key race on the serving (same student, same
// passage, two requests) retries once with another candidate.
import { DuplicateError, badRequest } from '../errors.js';

export function createServingService({ repo, jobs, buffer, subjects, recentTopicWindow, newStudentsGetFresh = true }) {
  async function retryOnDuplicate(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof DuplicateError)) throw err;
      return fn();
    }
  }

  async function serveFresh(userId, subject) {
    const s = await retryOnDuplicate(() => repo.serveFresh(userId, subject));
    if (s) buffer.refillAsync(subject);
    return s;
  }

  return {
    /** @returns {Promise<{servingId: number} | {job: object}>} */
    async next({ userId, subject }) {
      if (!subjects.includes(subject)) throw badRequest('URT_INVALID_SUBJECT', `Unknown subject '${subject}'`);
      return repo.withUserLock(userId, async () => {
        const active = await repo.findActiveJobForUser(userId);
        if (active) return { job: active };

        const last2 = await repo.lastServings(userId, 2);
        const needFresh = (last2.length < 2 && newStudentsGetFresh)
          || (last2.length === 2 && last2.every((s) => s.source === 'reused'));
        let serving = null;
        if (needFresh) {
          serving = await serveFresh(userId, subject);
        } else {
          const recent = await repo.recentTopics(userId, recentTopicWindow);
          serving = await retryOnDuplicate(() => repo.serveReused(userId, subject, recent))
            ?? await serveFresh(userId, subject);
        }
        if (serving) return { servingId: serving.id };
        return { job: await jobs.enqueue({ subject, userId, purpose: 'on_demand' }) };
      });
    },
  };
}
