import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js'; // MERGE: the platform's Sequelize instance
import { URT_RULE_SET_STATUSES, URT_SUBJECTS } from './urtConstants.js';

// Mirror of an approved rules file (server/urt/rules/<subject>.yaml, the source of truth),
// written by the rules loader at startup. Retiring a version removes its passages from serving.
const UrtRuleSet = sequelize.define('UrtRuleSet', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  subject: { type: DataTypes.ENUM(...URT_SUBJECTS), allowNull: false },
  rulesVersion: { type: DataTypes.STRING(64), allowNull: false },
  schemaVersion: { type: DataTypes.INTEGER, allowNull: false },
  contentHash: { type: DataTypes.CHAR(64), allowNull: false },
  status: { type: DataTypes.ENUM(...URT_RULE_SET_STATUSES), allowNull: false, defaultValue: 'approved' },
  rules: { type: DataTypes.JSON, allowNull: false },
  activatedAt: { type: DataTypes.DATE, allowNull: false },
  retiredAt: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'urt_rule_sets',
  timestamps: true,
  indexes: [{ name: 'urt_rule_sets_subject_version_uq', unique: true, fields: ['subject', 'rulesVersion'] }],
});

export default UrtRuleSet;
