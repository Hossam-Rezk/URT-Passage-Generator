// In-memory implementation of the URT repository, with the same contract as sequelizeRepository.js.
// Used by the tests and the local dev server. Methods are async to match the database version;
// JavaScript's single thread makes each one atomic, which stands in for the MySQL transactions.
//
// Repository contract (both implementations):
//   withUserLock(userId, fn)                     one in-flight "next passage" per student
//   lastServings(userId, n) / recentTopics(userId, n)
//   serveFresh(userId, subject, {jobId})         claim a validated passage nobody has seen → serving | null
//   serveReused(userId, subject, recentTopics)   unseen-by-user, already-served passage → serving | null
//   serveSpecific(userId, passageId, source, {jobId}) / serveAnyUnseen(userId, subject, {jobId})
//   insertPassage({passage, questions}) → id     (DuplicateError on contentHash)
//   createJob / getJob / updateJob / findActiveJobForUser / countPendingJobs / costSince
//   countFresh / poolStats / poolEmbeddings / retirePassage / retireRulesVersion / stats
//   getServing(id) / getServingForGrading(id) / saveSubmission(...) / getSubmission(id)
//   getExplanations(keys) / putExplanations(rows) / bumpExplanationHits(keys)
import { randomUUID } from 'node:crypto';
import { DuplicateError } from '../errors.js';

const ACTIVE = new Set(['queued', 'generating', 'validating']);
const clone = (x) => structuredClone(x);

export function createMemoryRepository({ random = Math.random, now = () => new Date() } = {}) {
  const db = { passages: [], questions: [], servings: [], answers: [], jobs: new Map(), cache: [], retiredVersions: new Set() };
  const ids = { passage: 0, question: 0, serving: 0, answer: 0, cache: 0 };
  const locks = new Map();

  const servable = (p) => p.status === 'validated' && !db.retiredVersions.has(p.rulesVersion);
  const seenBy = (userId) => new Set(db.servings.filter((s) => s.userId === userId).map((s) => s.passageId));
  const passageById = (id) => db.passages.find((p) => p.id === id);

  function record(userId, passage, source, jobId = null) {
    if (!servable(passage)) return null; // re-check inside the "transaction"
    if (db.servings.some((s) => s.userId === userId && s.passageId === passage.id)) throw new DuplicateError('serving');
    const serving = { id: (ids.serving += 1), userId, passageId: passage.id, subject: passage.subject, source,
      generationJobId: jobId, servedAt: now(), submittedAt: null, score: null };
    db.servings.push(serving);
    passage.serveCount += 1;
    passage.firstServedAt ??= serving.servedAt;
    return clone(serving);
  }

  const questionsOf = (passageId) => db.questions.filter((q) => q.passageId === passageId).sort((a, b) => a.orderIndex - b.orderIndex);

  return {
    db, // exposed for tests and the dev server's seeding

    async withUserLock(userId, fn) {
      const prev = locks.get(userId) ?? Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      locks.set(userId, prev.then(() => mine));
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(userId) === mine) locks.delete(userId);
      }
    },

    async lastServings(userId, n) {
      return db.servings.filter((s) => s.userId === userId).sort((a, b) => b.servedAt - a.servedAt || b.id - a.id)
        .slice(0, n).map(clone);
    },

    async recentTopics(userId, n) {
      const last = await this.lastServings(userId, n);
      return last.map((s) => passageById(s.passageId)?.topicId).filter(Boolean);
    },

    async serveFresh(userId, subject, { jobId = null } = {}) {
      const seen = seenBy(userId);
      const p = db.passages.filter((x) => x.subject === subject && x.serveCount === 0 && servable(x) && !seen.has(x.id))
        .sort((a, b) => a.id - b.id)[0];
      return p ? record(userId, p, 'generated', jobId) : null;
    },

    async serveReused(userId, subject, recentTopics = []) {
      const seen = seenBy(userId);
      const recent = new Set(recentTopics);
      const candidates = db.passages.filter((x) => x.subject === subject && x.serveCount >= 1 && servable(x) && !seen.has(x.id))
        .map((p) => ({ p, key: [recent.has(p.topicId) ? 1 : 0, p.serveCount, random()] }))
        .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
      return candidates.length ? record(userId, candidates[0].p, 'reused') : null;
    },

    async serveSpecific(userId, passageId, source, { jobId = null } = {}) {
      const p = passageById(passageId);
      return p ? record(userId, p, source, jobId) : null;
    },

    async serveAnyUnseen(userId, subject, { jobId = null } = {}) {
      const seen = seenBy(userId);
      const p = db.passages.filter((x) => x.subject === subject && servable(x) && !seen.has(x.id))
        .sort((a, b) => a.serveCount - b.serveCount || a.id - b.id)[0];
      return p ? record(userId, p, p.serveCount === 0 ? 'generated' : 'reused', jobId) : null;
    },

    async insertPassage({ passage, questions }) {
      if (db.passages.some((p) => p.contentHash === passage.contentHash)) throw new DuplicateError('contentHash');
      const row = { ...clone(passage), id: (ids.passage += 1), status: passage.status ?? 'validated', serveCount: 0,
        firstServedAt: null, retiredAt: null, retiredReason: null, createdAt: now() };
      db.passages.push(row);
      for (const q of questions) db.questions.push({ ...clone(q), id: (ids.question += 1), passageId: row.id });
      return row.id;
    },

    async countFresh(subject) {
      return db.passages.filter((p) => p.subject === subject && p.serveCount === 0 && servable(p)).length;
    },

    async poolStats(subject) {
      const topics = {};
      const difficulties = {};
      for (const p of db.passages.filter((x) => x.subject === subject && servable(x))) {
        topics[p.topicId] = (topics[p.topicId] ?? 0) + 1;
        difficulties[p.difficulty] = (difficulties[p.difficulty] ?? 0) + 1;
      }
      return { topics, difficulties };
    },

    async poolEmbeddings(subject) {
      return db.passages.filter((p) => p.subject === subject && p.embedding)
        .map((p) => ({ id: p.id, embedding: new Float32Array(p.embedding.buffer, p.embedding.byteOffset, p.embedding.length / 4) }));
    },

    async createJob({ subject, userId = null, purpose }) {
      const job = { id: randomUUID(), subject, userId, purpose, status: 'queued', attempts: 0, combination: null,
        failureReasons: null, passageId: null, servingId: null, inputTokens: 0, outputTokens: 0, costUsd: 0,
        errorMessage: null, startedAt: null, finishedAt: null, createdAt: now() };
      db.jobs.set(job.id, job);
      return clone(job);
    },
    async getJob(id) { return db.jobs.has(id) ? clone(db.jobs.get(id)) : null; },
    async updateJob(id, patch) { Object.assign(db.jobs.get(id), clone(patch)); },
    async findActiveJobForUser(userId) {
      const j = [...db.jobs.values()].find((x) => x.userId === userId && x.purpose === 'on_demand' && ACTIVE.has(x.status));
      return j ? clone(j) : null;
    },
    async countPendingJobs(subject, purpose) {
      return [...db.jobs.values()].filter((j) => j.subject === subject && j.purpose === purpose && ACTIVE.has(j.status)).length;
    },
    async costSince(since) {
      return [...db.jobs.values()].filter((j) => j.createdAt >= since).reduce((s, j) => s + Number(j.costUsd), 0);
    },

    async getServing(id) {
      const s = db.servings.find((x) => x.id === id);
      if (!s) return null;
      const p = passageById(s.passageId);
      return { serving: clone(s), passage: clone(p), questions: questionsOf(p.id).map(({ correctAnswer, distractorRationale, ...q }) => clone(q)) };
    },
    async getServingForGrading(id) {
      const s = db.servings.find((x) => x.id === id);
      if (!s) return null;
      const p = passageById(s.passageId);
      return { serving: clone(s), passage: clone(p), questions: questionsOf(p.id).map(clone) };
    },
    async saveSubmission(servingId, { answers, score, submittedAt }) {
      const s = db.servings.find((x) => x.id === servingId);
      if (s.submittedAt) return false; // lost the race; the caller returns the stored result
      s.submittedAt = submittedAt;
      s.score = score;
      for (const a of answers) db.answers.push({ ...clone(a), id: (ids.answer += 1), servingId });
      return true;
    },
    async getSubmission(servingId) {
      return db.answers.filter((a) => a.servingId === servingId).map(clone);
    },

    async getExplanations(keys) {
      return db.cache.filter((c) => keys.some((k) => k.questionId === c.questionId && k.chosenAnswer === c.chosenAnswer
        && k.promptVersion === c.promptVersion)).map(clone);
    },
    async putExplanations(rows) {
      for (const r of rows) {
        if (!db.cache.some((c) => c.questionId === r.questionId && c.chosenAnswer === r.chosenAnswer && c.promptVersion === r.promptVersion)) {
          db.cache.push({ ...clone(r), id: (ids.cache += 1), hitCount: 0 });
        }
      }
    },
    async bumpExplanationHits(keys) {
      for (const c of db.cache) {
        if (keys.some((k) => k.questionId === c.questionId && k.chosenAnswer === c.chosenAnswer && k.promptVersion === c.promptVersion)) c.hitCount += 1;
      }
    },

    async retirePassage(id, reason) {
      const p = passageById(id);
      if (!p) return false;
      Object.assign(p, { status: 'retired', retiredAt: now(), retiredReason: reason });
      return true;
    },
    async retireRulesVersion(rulesVersion) { db.retiredVersions.add(rulesVersion); },

    async stats({ since }) {
      const pool = {};
      for (const p of db.passages) {
        const s = (pool[p.subject] ??= { validated: 0, retired: 0, fresh: 0 });
        s[p.status] += 1;
        if (p.serveCount === 0 && servable(p)) s.fresh += 1;
      }
      const jobs = {};
      for (const j of db.jobs.values()) jobs[j.status] = (jobs[j.status] ?? 0) + 1;
      return { pool, jobs, costToday: await this.costSince(since) };
    },
  };
}
