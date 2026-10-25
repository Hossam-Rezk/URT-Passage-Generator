// URT passage generator associations. MERGE: call applyUrtAssociations() from the platform's
// associations.js (after the User model is defined), or paste the body there.
// onDelete values mirror the foreign keys in migrations/20261101000001-create-urt-tables.cjs.
import User from './userModel.js'; // MERGE: the platform's User model
import UrtExplanationCache from './urtExplanationCacheModel.js';
import UrtGenerationJob from './urtGenerationJobModel.js';
import UrtPassage from './urtPassageModel.js';
import UrtPassageQuestion from './urtPassageQuestionModel.js';
import UrtPassageServing from './urtPassageServingModel.js';
import UrtRuleSet from './urtRuleSetModel.js';
import UrtServingAnswer from './urtServingAnswerModel.js';

export function applyUrtAssociations() {
  // Passage -> questions (deleting a never-served passage removes its questions)
  UrtPassage.hasMany(UrtPassageQuestion, { foreignKey: 'passageId', as: 'questions', onDelete: 'CASCADE' });
  UrtPassageQuestion.belongsTo(UrtPassage, { foreignKey: 'passageId', as: 'passage' });

  // Passage -> servings (a served passage cannot be deleted; retire it instead)
  UrtPassage.hasMany(UrtPassageServing, { foreignKey: 'passageId', as: 'servings', onDelete: 'RESTRICT' });
  UrtPassageServing.belongsTo(UrtPassage, { foreignKey: 'passageId', as: 'passage' });

  // User -> servings and jobs (deleting a user anonymises them)
  User.hasMany(UrtPassageServing, { foreignKey: 'userId', as: 'urtServings', onDelete: 'SET NULL' });
  UrtPassageServing.belongsTo(User, { foreignKey: 'userId', as: 'user' });
  User.hasMany(UrtGenerationJob, { foreignKey: 'userId', as: 'urtGenerationJobs', onDelete: 'SET NULL' });
  UrtGenerationJob.belongsTo(User, { foreignKey: 'userId', as: 'user' });

  // Serving -> answers
  UrtPassageServing.hasMany(UrtServingAnswer, { foreignKey: 'servingId', as: 'answers', onDelete: 'CASCADE' });
  UrtServingAnswer.belongsTo(UrtPassageServing, { foreignKey: 'servingId', as: 'serving' });
  UrtPassageQuestion.hasMany(UrtServingAnswer, { foreignKey: 'questionId', as: 'answers', onDelete: 'RESTRICT' });
  UrtServingAnswer.belongsTo(UrtPassageQuestion, { foreignKey: 'questionId', as: 'question' });

  // Jobs <-> passages and servings
  UrtGenerationJob.belongsTo(UrtPassage, { foreignKey: 'passageId', as: 'passage', onDelete: 'SET NULL' });
  UrtGenerationJob.belongsTo(UrtPassageServing, { foreignKey: 'servingId', as: 'serving', onDelete: 'SET NULL',
    constraints: false }); // FK exists in the migration; constraints: false avoids a sync() cycle
  UrtPassageServing.belongsTo(UrtGenerationJob, { foreignKey: 'generationJobId', as: 'generationJob',
    onDelete: 'SET NULL' });

  // Question -> cached explanations
  UrtPassageQuestion.hasMany(UrtExplanationCache, { foreignKey: 'questionId', as: 'explanations',
    onDelete: 'CASCADE' });
  UrtExplanationCache.belongsTo(UrtPassageQuestion, { foreignKey: 'questionId', as: 'question' });

  return {
    UrtExplanationCache, UrtGenerationJob, UrtPassage, UrtPassageQuestion, UrtPassageServing, UrtRuleSet,
    UrtServingAnswer,
  };
}
