import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance

// A student's answer to one question of a serving. answer NULL = unanswered (counts as incorrect).
// explanation is filled for incorrect or unanswered questions only.
const UrtServingAnswer = sequelize.define('UrtServingAnswer', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  servingId: { type: DataTypes.INTEGER, allowNull: false },
  questionId: { type: DataTypes.INTEGER, allowNull: false },
  answer: { type: DataTypes.JSON, allowNull: true },
  isCorrect: { type: DataTypes.BOOLEAN, allowNull: false },
  explanation: { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName: 'urt_serving_answers',
  timestamps: true,
  indexes: [{ name: 'urt_serving_answers_serving_question_uq', unique: true, fields: ['servingId', 'questionId'] }],
});

export default UrtServingAnswer;
