'use strict';

/**
 * URT passage generator: creates the seven urt_* tables (PLAN.md §8).
 * Adds new tables only; no existing table is altered. The only references to platform
 * tables are users.id (servings and jobs), with ON DELETE SET NULL so deleted users are
 * anonymised while their servings and the shared passage pool remain.
 *
 * Creation order resolves the jobs <-> servings cycle: urt_generation_jobs is created first,
 * urt_passage_servings references it, and the jobs.servingId foreign key is added last.
 * MySQL cannot roll back DDL, so this migration does not use a transaction; `down` drops
 * everything in reverse order.
 */

const SUBJECTS = ['physics', 'chemistry', 'geology', 'biology', 'english'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const TABLE_OPTIONS = { engine: 'InnoDB', charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci' };

function timestamps(Sequelize) {
  return {
    createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  };
}

function userFk(Sequelize) {
  return {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  };
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // ------------------------------------------------------------------ urt_rule_sets
    await queryInterface.createTable('urt_rule_sets', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      subject: { type: Sequelize.ENUM(...SUBJECTS), allowNull: false },
      rulesVersion: { type: Sequelize.STRING(64), allowNull: false },
      schemaVersion: { type: Sequelize.INTEGER, allowNull: false },
      contentHash: { type: Sequelize.CHAR(64), allowNull: false },
      status: { type: Sequelize.ENUM('approved', 'retired'), allowNull: false, defaultValue: 'approved' },
      rules: { type: Sequelize.JSON, allowNull: false },
      activatedAt: { type: Sequelize.DATE, allowNull: false },
      retiredAt: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_rule_sets', ['subject', 'rulesVersion'], {
      unique: true, name: 'urt_rule_sets_subject_version_uq',
    });

    // ------------------------------------------------------------------ urt_passages
    await queryInterface.createTable('urt_passages', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      subject: { type: Sequelize.ENUM(...SUBJECTS), allowNull: false },
      title: { type: Sequelize.STRING(255), allowNull: false },
      body: { type: Sequelize.TEXT('medium'), allowNull: false },
      figures: { type: Sequelize.JSON, allowNull: true },
      wordCount: { type: Sequelize.INTEGER, allowNull: false },
      difficulty: { type: Sequelize.ENUM(...DIFFICULTIES), allowNull: false },
      topicId: { type: Sequelize.STRING(128), allowNull: false },
      subtopicId: { type: Sequelize.STRING(128), allowNull: false },
      styleId: { type: Sequelize.STRING(128), allowNull: false },
      combination: { type: Sequelize.JSON, allowNull: false },
      rulesVersion: { type: Sequelize.STRING(64), allowNull: false },
      promptVersion: { type: Sequelize.STRING(64), allowNull: false },
      generationModel: { type: Sequelize.STRING(64), allowNull: false },
      status: { type: Sequelize.ENUM('validated', 'retired'), allowNull: false, defaultValue: 'validated' },
      validationReport: { type: Sequelize.JSON, allowNull: false },
      contentHash: { type: Sequelize.CHAR(64), allowNull: false }, // sha256 of the normalised text
      embedding: { type: Sequelize.BLOB, allowNull: true },
      embeddingModel: { type: Sequelize.STRING(64), allowNull: true },
      serveCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      firstServedAt: { type: Sequelize.DATE, allowNull: true },
      retiredAt: { type: Sequelize.DATE, allowNull: true },
      retiredReason: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_passages', ['contentHash'], { unique: true, name: 'urt_passages_content_hash_uq' });
    await queryInterface.addIndex('urt_passages', ['subject', 'status', 'serveCount'], {
      name: 'urt_passages_subject_status_serve_idx',
    });
    await queryInterface.addIndex('urt_passages', ['subject', 'topicId'], { name: 'urt_passages_subject_topic_idx' });
    await queryInterface.addIndex('urt_passages', ['rulesVersion'], { name: 'urt_passages_rules_version_idx' });

    // ------------------------------------------------------------------ urt_passage_questions
    await queryInterface.createTable('urt_passage_questions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      passageId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'urt_passages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      orderIndex: { type: Sequelize.INTEGER, allowNull: false },
      type: { type: Sequelize.ENUM('multiple_choice'), allowNull: false, defaultValue: 'multiple_choice' },
      questionType: { type: Sequelize.STRING(64), allowNull: false },
      skill: { type: Sequelize.STRING(255), allowNull: false },
      difficulty: { type: Sequelize.ENUM(...DIFFICULTIES), allowNull: false },
      question: { type: Sequelize.TEXT, allowNull: false },
      options: { type: Sequelize.JSON, allowNull: false },
      correctAnswer: { type: Sequelize.JSON, allowNull: false },
      distractorRationale: { type: Sequelize.JSON, allowNull: true },
      figureRef: { type: Sequelize.STRING(32), allowNull: true },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_passage_questions', ['passageId', 'orderIndex'], {
      unique: true, name: 'urt_passage_questions_passage_order_uq',
    });

    // ------------------------------------------------------------------ urt_generation_jobs
    await queryInterface.createTable('urt_generation_jobs', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      subject: { type: Sequelize.ENUM(...SUBJECTS), allowNull: false },
      userId: userFk(Sequelize),
      purpose: { type: Sequelize.ENUM('on_demand', 'buffer_refill', 'seed'), allowNull: false },
      status: {
        type: Sequelize.ENUM('queued', 'generating', 'validating', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      combination: { type: Sequelize.JSON, allowNull: true },
      failureReasons: { type: Sequelize.JSON, allowNull: true },
      passageId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'urt_passages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      servingId: { type: Sequelize.INTEGER, allowNull: true }, // FK added below, after urt_passage_servings
      inputTokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      outputTokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      costUsd: { type: Sequelize.DECIMAL(10, 6), allowNull: false, defaultValue: 0 },
      errorMessage: { type: Sequelize.TEXT, allowNull: true },
      startedAt: { type: Sequelize.DATE, allowNull: true },
      finishedAt: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_generation_jobs', ['status'], { name: 'urt_generation_jobs_status_idx' });
    await queryInterface.addIndex('urt_generation_jobs', ['userId', 'status'], {
      name: 'urt_generation_jobs_user_status_idx',
    });

    // ------------------------------------------------------------------ urt_passage_servings
    await queryInterface.createTable('urt_passage_servings', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      userId: userFk(Sequelize),
      passageId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'urt_passages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT', // a served passage is history; retire it instead of deleting
      },
      subject: { type: Sequelize.ENUM(...SUBJECTS), allowNull: false },
      source: { type: Sequelize.ENUM('reused', 'generated'), allowNull: false },
      generationJobId: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'urt_generation_jobs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      servedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      submittedAt: { type: Sequelize.DATE, allowNull: true },
      score: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    // Invariant 1: a student is never served the same passage twice. NULL userIds (deleted,
    // anonymised users) do not collide, as MySQL unique indexes allow repeated NULLs.
    await queryInterface.addIndex('urt_passage_servings', ['userId', 'passageId'], {
      unique: true, name: 'urt_passage_servings_user_passage_uq',
    });
    await queryInterface.addIndex('urt_passage_servings', ['userId', 'servedAt'], {
      name: 'urt_passage_servings_user_served_idx',
    });

    await queryInterface.addConstraint('urt_generation_jobs', {
      fields: ['servingId'],
      type: 'foreign key',
      name: 'urt_generation_jobs_serving_fk',
      references: { table: 'urt_passage_servings', field: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    // ------------------------------------------------------------------ urt_serving_answers
    await queryInterface.createTable('urt_serving_answers', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      servingId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'urt_passage_servings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      questionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'urt_passage_questions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      answer: { type: Sequelize.JSON, allowNull: true }, // NULL = unanswered (counts as incorrect)
      isCorrect: { type: Sequelize.BOOLEAN, allowNull: false },
      explanation: { type: Sequelize.TEXT, allowNull: true }, // incorrect/unanswered only
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_serving_answers', ['servingId', 'questionId'], {
      unique: true, name: 'urt_serving_answers_serving_question_uq',
    });

    // ------------------------------------------------------------------ urt_explanation_cache
    await queryInterface.createTable('urt_explanation_cache', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      questionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'urt_passage_questions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      chosenAnswer: { type: Sequelize.STRING(8), allowNull: false }, // '' = unanswered
      promptVersion: { type: Sequelize.STRING(64), allowNull: false },
      model: { type: Sequelize.STRING(64), allowNull: false },
      explanation: { type: Sequelize.TEXT, allowNull: false },
      hitCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(Sequelize),
    }, TABLE_OPTIONS);
    await queryInterface.addIndex('urt_explanation_cache', ['questionId', 'chosenAnswer', 'promptVersion'], {
      unique: true, name: 'urt_explanation_cache_key_uq',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('urt_explanation_cache');
    await queryInterface.dropTable('urt_serving_answers');
    await queryInterface.removeConstraint('urt_generation_jobs', 'urt_generation_jobs_serving_fk');
    await queryInterface.dropTable('urt_passage_servings');
    await queryInterface.dropTable('urt_generation_jobs');
    await queryInterface.dropTable('urt_passage_questions');
    await queryInterface.dropTable('urt_passages');
    await queryInterface.dropTable('urt_rule_sets');
  },
};
