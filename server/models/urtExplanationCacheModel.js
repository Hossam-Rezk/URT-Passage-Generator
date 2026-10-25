import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance

// Cached feedback per (question, chosen answer, prompt version); a hit means no LLM call.
// chosenAnswer is URT_UNANSWERED ('') for unanswered questions.
const UrtExplanationCache = sequelize.define('UrtExplanationCache', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  questionId: { type: DataTypes.INTEGER, allowNull: false },
  chosenAnswer: { type: DataTypes.STRING(8), allowNull: false },
  promptVersion: { type: DataTypes.STRING(64), allowNull: false },
  model: { type: DataTypes.STRING(64), allowNull: false },
  explanation: { type: DataTypes.TEXT, allowNull: false },
  hitCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'urt_explanation_cache',
  timestamps: true,
  indexes: [{
    name: 'urt_explanation_cache_key_uq', unique: true, fields: ['questionId', 'chosenAnswer', 'promptVersion'],
  }],
});

export default UrtExplanationCache;
