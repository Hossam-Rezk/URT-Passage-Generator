import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance
import { URT_DIFFICULTIES, URT_PASSAGE_STATUSES, URT_SUBJECTS } from './urtConstants.js';

// A validated, generated passage in the shared pool. serveCount = 0 means "fresh".
const UrtPassage = sequelize.define('UrtPassage', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  subject: { type: DataTypes.ENUM(...URT_SUBJECTS), allowNull: false },
  title: { type: DataTypes.STRING(255), allowNull: false },
  body: { type: DataTypes.TEXT('medium'), allowNull: false }, // paragraphs separated by blank lines
  figures: { type: DataTypes.JSON, allowNull: true },
  wordCount: { type: DataTypes.INTEGER, allowNull: false },
  difficulty: { type: DataTypes.ENUM(...URT_DIFFICULTIES), allowNull: false },
  topicId: { type: DataTypes.STRING(128), allowNull: false },
  subtopicId: { type: DataTypes.STRING(128), allowNull: false },
  styleId: { type: DataTypes.STRING(128), allowNull: false },
  combination: { type: DataTypes.JSON, allowNull: false },
  rulesVersion: { type: DataTypes.STRING(64), allowNull: false },
  promptVersion: { type: DataTypes.STRING(64), allowNull: false },
  generationModel: { type: DataTypes.STRING(64), allowNull: false },
  status: { type: DataTypes.ENUM(...URT_PASSAGE_STATUSES), allowNull: false, defaultValue: 'validated' },
  validationReport: { type: DataTypes.JSON, allowNull: false },
  contentHash: { type: DataTypes.CHAR(64), allowNull: false, unique: 'urt_passages_content_hash_uq' },
  embedding: { type: DataTypes.BLOB, allowNull: true }, // float32 little-endian
  embeddingModel: { type: DataTypes.STRING(64), allowNull: true },
  serveCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  firstServedAt: { type: DataTypes.DATE, allowNull: true },
  retiredAt: { type: DataTypes.DATE, allowNull: true },
  retiredReason: { type: DataTypes.STRING(255), allowNull: true },
}, {
  tableName: 'urt_passages',
  timestamps: true,
  indexes: [
    { name: 'urt_passages_subject_status_serve_idx', fields: ['subject', 'status', 'serveCount'] },
    { name: 'urt_passages_subject_topic_idx', fields: ['subject', 'topicId'] },
    { name: 'urt_passages_rules_version_idx', fields: ['rulesVersion'] },
  ],
});

export default UrtPassage;
