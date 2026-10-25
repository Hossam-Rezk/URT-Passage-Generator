// Shared enum values for the urt_* models. Keep in sync with
// migrations/20261101000001-create-urt-tables.cjs (a migration cannot import ESM).

export const URT_SUBJECTS = ['physics', 'chemistry', 'geology', 'biology', 'english'];
export const URT_DIFFICULTIES = ['easy', 'medium', 'hard'];
export const URT_PASSAGE_STATUSES = ['validated', 'retired'];
export const URT_SERVING_SOURCES = ['reused', 'generated'];
export const URT_JOB_PURPOSES = ['on_demand', 'buffer_refill', 'seed'];
export const URT_JOB_STATUSES = ['queued', 'generating', 'validating', 'completed', 'failed'];
export const URT_ACTIVE_JOB_STATUSES = ['queued', 'generating', 'validating'];
export const URT_RULE_SET_STATUSES = ['approved', 'retired'];
export const URT_UNANSWERED = ''; // chosenAnswer key in urt_explanation_cache for unanswered questions
