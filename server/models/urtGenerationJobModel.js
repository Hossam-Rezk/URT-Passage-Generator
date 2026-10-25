import { randomUUID } from 'node:crypto';
import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance
import { URT_JOB_PURPOSES, URT_JOB_STATUSES, URT_SUBJECTS } from './urtConstants.js';

// A generation job (queued -> generating -> validating -> completed | failed), run on jobQueueService.
// On-demand jobs record the student's serving themselves (servingId) so a late poll still gets it.
const UrtGenerationJob = sequelize.define('UrtGenerationJob', {
  id: { type: DataTypes.CHAR(36), primaryKey: true, defaultValue: () => randomUUID() },
  subject: { type: DataTypes.ENUM(...URT_SUBJECTS), allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: true },
  purpose: { type: DataTypes.ENUM(...URT_JOB_PURPOSES), allowNull: false },
  status: { type: DataTypes.ENUM(...URT_JOB_STATUSES), allowNull: false, defaultValue: 'queued' },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  combination: { type: DataTypes.JSON, allowNull: true },
  failureReasons: { type: DataTypes.JSON, allowNull: true },
  passageId: { type: DataTypes.INTEGER, allowNull: true },
  servingId: { type: DataTypes.INTEGER, allowNull: true },
  inputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  outputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  costUsd: { type: DataTypes.DECIMAL(10, 6), allowNull: false, defaultValue: 0 },
  errorMessage: { type: DataTypes.TEXT, allowNull: true },
  startedAt: { type: DataTypes.DATE, allowNull: true },
  finishedAt: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'urt_generation_jobs',
  timestamps: true,
  indexes: [
    { name: 'urt_generation_jobs_status_idx', fields: ['status'] },
    { name: 'urt_generation_jobs_user_status_idx', fields: ['userId', 'status'] },
  ],
});

export default UrtGenerationJob;
