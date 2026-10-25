// MySQL 8 implementation of the URT repository (contract: see memoryRepository.js).
// NOT YET RUN AGAINST MYSQL: the logic above it is tested with the memory repository; this file was
// written against the M5 models and must pass the integration tests in PLAN.md §13 before launch
// (GET_LOCK, FOR UPDATE SKIP LOCKED, unique-key races).
import { Op, QueryTypes } from 'sequelize';
import { DuplicateError, UrtError } from '../errors.js';

const ACTIVE = ['queued', 'generating', 'validating'];
const NOT_RETIRED = `p.rulesVersion NOT IN (SELECT rs.rulesVersion FROM urt_rule_sets rs
  WHERE rs.subject = p.subject AND rs.status = 'retired')`;
const plain = (row) => (row ? row.get({ plain: true }) : null);
const toF32 = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);

/**
 * @param {object} p
 * @param {import('sequelize').Sequelize} p.sequelize
 * @param {object} p.models  the value returned by applyUrtAssociations()
 */
export function createSequelizeRepository({ sequelize, models }) {
  const { UrtPassage, UrtPassageQuestion, UrtPassageServing, UrtServingAnswer, UrtGenerationJob, UrtRuleSet,
    UrtExplanationCache } = models;
  const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

  async function record(t, userId, passageId, source, jobId) {
    const [p] = await select('SELECT id, subject, status FROM urt_passages WHERE id = :id FOR UPDATE', { id: passageId }, t);
    if (!p || p.status !== 'validated') return null;
    let serving;
    try {
      serving = await UrtPassageServing.create({ userId, passageId, subject: p.subject, source,
        generationJobId: jobId ?? null, servedAt: new Date() }, { transaction: t });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') throw new DuplicateError('serving');
      throw err;
    }
    await sequelize.query(`UPDATE urt_passages SET serveCount = serveCount + 1,
      firstServedAt = COALESCE(firstServedAt, NOW()) WHERE id = :id`, { replacements: { id: passageId }, transaction: t });
    return plain(serving);
  }

  const claim = (sql, replacements, source, jobId, userId) => sequelize.transaction(async (t) => {
    const [row] = await select(sql, replacements, t);
    return row ? record(t, userId, row.id, source(row), jobId) : null;
  });

  return {
    async withUserLock(userId, fn) {
      const name = `urt:user:${userId}`;
      const t = await sequelize.transaction(); // pins one connection: GET_LOCK is per session
      try {
        const [{ got }] = await select('SELECT GET_LOCK(:name, 10) AS got', { name }, t);
        if (got !== 1) throw new UrtError(429, 'URT_BUSY', 'Another request for this student is still in progress');
        try {
          return await fn();
        } finally {
          await select('SELECT RELEASE_LOCK(:name) AS released', { name }, t);
        }
      } finally {
        await t.commit();
      }
    },

    async lastServings(userId, n) {
      return (await UrtPassageServing.findAll({ where: { userId }, order: [['servedAt', 'DESC'], ['id', 'DESC']], limit: n }))
        .map(plain);
    },

    async recentTopics(userId, n) {
      const rows = await select(`SELECT p.topicId FROM urt_passage_servings s JOIN urt_passages p ON p.id = s.passageId
        WHERE s.userId = :userId ORDER BY s.servedAt DESC, s.id DESC LIMIT :n`, { userId, n });
      return rows.map((r) => r.topicId);
    },

    serveFresh(userId, subject, { jobId = null } = {}) {
      return claim(`SELECT p.id FROM urt_passages p
        WHERE p.subject = :subject AND p.status = 'validated' AND p.serveCount = 0 AND ${NOT_RETIRED}
          AND NOT EXISTS (SELECT 1 FROM urt_passage_servings s WHERE s.passageId = p.id AND s.userId = :userId)
        ORDER BY p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, { subject, userId }, () => 'generated', jobId, userId);
    },

    serveReused(userId, subject, recentTopics = []) {
      return claim(`SELECT p.id FROM urt_passages p
        WHERE p.subject = :subject AND p.status = 'validated' AND p.serveCount >= 1 AND ${NOT_RETIRED}
          AND NOT EXISTS (SELECT 1 FROM urt_passage_servings s WHERE s.passageId = p.id AND s.userId = :userId)
        ORDER BY (p.topicId IN (:recent)) ASC, p.serveCount ASC, RAND()
        LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, { subject, userId, recent: recentTopics.length ? recentTopics : ['\u0000'] },
      () => 'reused', null, userId);
    },

    serveSpecific(userId, passageId, source, { jobId = null } = {}) {
      return sequelize.transaction((t) => record(t, userId, passageId, source, jobId));
    },

    serveAnyUnseen(userId, subject, { jobId = null } = {}) {
      return claim(`SELECT p.id, p.serveCount FROM urt_passages p
        WHERE p.subject = :subject AND p.status = 'validated' AND ${NOT_RETIRED}
          AND NOT EXISTS (SELECT 1 FROM urt_passage_servings s WHERE s.passageId = p.id AND s.userId = :userId)
        ORDER BY p.serveCount ASC, p.id ASC LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, { subject, userId },
      (row) => (row.serveCount === 0 ? 'generated' : 'reused'), jobId, userId);
    },

    insertPassage({ passage, questions }) {
      return sequelize.transaction(async (t) => {
        try {
          const row = await UrtPassage.create(passage, { transaction: t });
          await UrtPassageQuestion.bulkCreate(questions.map((q) => ({ ...q, passageId: row.id })), { transaction: t });
          return row.id;
        } catch (err) {
          if (err.name === 'SequelizeUniqueConstraintError') throw new DuplicateError('contentHash');
          throw err;
        }
      });
    },

    async countFresh(subject) {
      const [{ n }] = await select(`SELECT COUNT(*) AS n FROM urt_passages p WHERE p.subject = :subject
        AND p.status = 'validated' AND p.serveCount = 0 AND ${NOT_RETIRED}`, { subject });
      return Number(n);
    },

    async poolStats(subject) {
      const rows = await select(`SELECT p.topicId, p.difficulty, COUNT(*) AS n FROM urt_passages p
        WHERE p.subject = :subject AND p.status = 'validated' AND ${NOT_RETIRED} GROUP BY p.topicId, p.difficulty`, { subject });
      const topics = {};
      const difficulties = {};
      for (const r of rows) {
        topics[r.topicId] = (topics[r.topicId] ?? 0) + Number(r.n);
        difficulties[r.difficulty] = (difficulties[r.difficulty] ?? 0) + Number(r.n);
      }
      return { topics, difficulties };
    },

    async poolEmbeddings(subject) {
      const rows = await UrtPassage.findAll({ attributes: ['id', 'embedding'], raw: true,
        where: { subject, embedding: { [Op.ne]: null } } });
      return rows.map((r) => ({ id: r.id, embedding: toF32(r.embedding) }));
    },

    async createJob({ subject, userId = null, purpose }) { return plain(await UrtGenerationJob.create({ subject, userId, purpose })); },
    async getJob(id) { return plain(await UrtGenerationJob.findByPk(id)); },
    async updateJob(id, patch) { await UrtGenerationJob.update(patch, { where: { id } }); },
    async findActiveJobForUser(userId) {
      return plain(await UrtGenerationJob.findOne({ where: { userId, purpose: 'on_demand', status: ACTIVE } }));
    },
    async countPendingJobs(subject, purpose) {
      return UrtGenerationJob.count({ where: { subject, purpose, status: ACTIVE } });
    },
    async costSince(since) {
      return Number(await UrtGenerationJob.sum('costUsd', { where: { createdAt: { [Op.gte]: since } } })) || 0;
    },

    async getServing(id) {
      const s = await UrtPassageServing.findByPk(id, { include: [{ model: UrtPassage, as: 'passage' }] });
      if (!s) return null;
      const { passage, ...serving } = plain(s);
      const questions = await UrtPassageQuestion.findAll({ where: { passageId: serving.passageId }, order: [['orderIndex', 'ASC']] });
      return { serving, passage, questions: questions.map(plain) };
    },
    async getServingForGrading(id) {
      const s = await UrtPassageServing.findByPk(id, { include: [{ model: UrtPassage, as: 'passage' }] });
      if (!s) return null;
      const { passage, ...serving } = plain(s);
      const questions = await UrtPassageQuestion.scope('withKey').findAll({ where: { passageId: serving.passageId },
        order: [['orderIndex', 'ASC']] });
      return { serving, passage, questions: questions.map(plain) };
    },
    saveSubmission(servingId, { answers, score, submittedAt }) {
      return sequelize.transaction(async (t) => {
        const [result] = await sequelize.query(`UPDATE urt_passage_servings SET submittedAt = :submittedAt, score = :score
          WHERE id = :id AND submittedAt IS NULL`, { replacements: { submittedAt, score, id: servingId }, transaction: t });
        if (!result.affectedRows) return false; // already submitted (lost the race); mysql2 returns a ResultSetHeader
        await UrtServingAnswer.bulkCreate(answers.map((a) => ({ ...a, servingId })), { transaction: t });
        return true;
      });
    },
    async getSubmission(servingId) {
      return (await UrtServingAnswer.findAll({ where: { servingId } })).map(plain);
    },

    async getExplanations(keys) {
      if (!keys.length) return [];
      return (await UrtExplanationCache.findAll({ where: { [Op.or]: keys } })).map(plain);
    },
    async putExplanations(rows) {
      if (rows.length) await UrtExplanationCache.bulkCreate(rows, { ignoreDuplicates: true });
    },
    async bumpExplanationHits(keys) {
      if (keys.length) await UrtExplanationCache.increment('hitCount', { where: { [Op.or]: keys } });
    },

    async retirePassage(id, reason) {
      const [n] = await UrtPassage.update({ status: 'retired', retiredAt: new Date(), retiredReason: reason }, { where: { id } });
      return n > 0;
    },
    async retireRulesVersion(rulesVersion) {
      await UrtRuleSet.update({ status: 'retired', retiredAt: new Date() }, { where: { rulesVersion } });
    },

    async stats({ since }) {
      const pool = {};
      for (const r of await select(`SELECT p.subject, p.status, SUM(p.serveCount = 0 AND ${NOT_RETIRED}) AS fresh,
        COUNT(*) AS n FROM urt_passages p GROUP BY p.subject, p.status`, {})) {
        const s = (pool[r.subject] ??= { validated: 0, retired: 0, fresh: 0 });
        s[r.status] += Number(r.n);
        if (r.status === 'validated') s.fresh += Number(r.fresh);
      }
      const jobs = {};
      for (const r of await select('SELECT status, COUNT(*) AS n FROM urt_generation_jobs GROUP BY status', {})) jobs[r.status] = Number(r.n);
      return { pool, jobs, costToday: await this.costSince(since) };
    },
  };
}
