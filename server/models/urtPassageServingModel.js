import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance
import { URT_SERVING_SOURCES, URT_SUBJECTS } from './urtConstants.js';

// One passage served to one student. A serving counts as "seen" whether or not it is submitted.
// source: 'generated' = nobody had been served the passage before; 'reused' = someone had.
// userId becomes NULL when the user is deleted (anonymised history).
const UrtPassageServing = sequelize.define('UrtPassageServing', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER, allowNull: true },
  passageId: { type: DataTypes.INTEGER, allowNull: false },
  subject: { type: DataTypes.ENUM(...URT_SUBJECTS), allowNull: false },
  source: { type: DataTypes.ENUM(...URT_SERVING_SOURCES), allowNull: false },
  generationJobId: { type: DataTypes.CHAR(36), allowNull: true },
  servedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  submittedAt: { type: DataTypes.DATE, allowNull: true },
  score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
}, {
  tableName: 'urt_passage_servings',
  timestamps: true,
  indexes: [
    { name: 'urt_passage_servings_user_passage_uq', unique: true, fields: ['userId', 'passageId'] },
    { name: 'urt_passage_servings_user_served_idx', fields: ['userId', 'servedAt'] },
  ],
});

export default UrtPassageServing;
