import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance
import { URT_DIFFICULTIES } from './urtConstants.js';

// One multiple-choice question of a passage. Field shape follows quiz_questions.
// correctAnswer and distractorRationale must never be sent to a client before submission.
const UrtPassageQuestion = sequelize.define('UrtPassageQuestion', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  passageId: { type: DataTypes.INTEGER, allowNull: false },
  orderIndex: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  type: { type: DataTypes.ENUM('multiple_choice'), allowNull: false, defaultValue: 'multiple_choice' },
  questionType: { type: DataTypes.STRING(64), allowNull: false },
  skill: { type: DataTypes.STRING(255), allowNull: false },
  difficulty: { type: DataTypes.ENUM(...URT_DIFFICULTIES), allowNull: false },
  question: { type: DataTypes.TEXT, allowNull: false },
  options: { type: DataTypes.JSON, allowNull: false }, // [{label, text}]
  correctAnswer: { type: DataTypes.JSON, allowNull: false }, // "B"
  distractorRationale: { type: DataTypes.JSON, allowNull: true }, // [{label, pattern, whyWrong}]
  figureRef: { type: DataTypes.STRING(32), allowNull: true },
}, {
  tableName: 'urt_passage_questions',
  timestamps: true,
  indexes: [{ name: 'urt_passage_questions_passage_order_uq', unique: true, fields: ['passageId', 'orderIndex'] }],
  defaultScope: { attributes: { exclude: ['correctAnswer', 'distractorRationale'] } },
  scopes: { withKey: { attributes: { include: ['correctAnswer', 'distractorRationale'] } } },
});

export default UrtPassageQuestion;
