// Loads and validates server/urt/rules/<subject>.yaml at startup (PLAN.md §5.3).
// Structural rules come from rules.schema.json (exported from the Python contract,
// tools/corpus_analysis/corpus_analysis/rules_schema.py); the cross-field checks below repeat that
// contract's validators, which JSON Schema cannot express. Any problem throws RulesInvalidError,
// and the URT routes must not start.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

export const SUPPORTED_SCHEMA_VERSIONS = [1];

export class RulesInvalidError extends Error {
  constructor(file, problems) {
    super(`Invalid URT rules file ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.file = file;
    this.problems = problems;
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const dupes = (ids) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

// Mirrors the model validators in rules_schema.py.
export function crossFieldProblems(r) {
  const problems = [];
  const levels = Object.keys(r.difficulty_levels ?? {});
  if (['easy', 'medium', 'hard'].some((d) => !levels.includes(d))) {
    problems.push('difficulty_levels must define easy, medium and hard');
  }
  if (!r.rules_version.startsWith(`${r.subject}-`)) problems.push(`rules_version must start with '${r.subject}-'`);
  const groups = {
    topics: r.topics.map((t) => t.weight),
    styles: r.styles.map((s) => s.weight),
    difficulty_levels: Object.values(r.difficulty_levels).map((d) => d.weight),
    allowed_combinations: r.allowed_combinations.map((c) => c.weight),
    'question_set.types': r.question_set.types.map((q) => q.share),
  };
  if (r.figures.probability > 0) groups['figures.kinds'] = r.figures.kinds.map((k) => k.weight);
  for (const [name, ws] of Object.entries(groups)) if (sum(ws) <= 0) problems.push(`${name}: weights must sum to > 0`);
  for (const t of r.topics) {
    if (sum(t.subtopics.map((s) => s.weight)) <= 0) problems.push(`topic ${t.id}: subtopic weights must sum to > 0`);
  }
  for (const [kind, ids] of [['topic', r.topics.map((t) => t.id)], ['style', r.styles.map((s) => s.id)],
    ['question type', r.question_set.types.map((q) => q.id)]]) {
    const d = dupes(ids);
    if (d.length) problems.push(`duplicate ${kind} ids: ${d.join(', ')}`);
  }
  const styleIds = new Set(r.styles.map((s) => s.id));
  for (const c of r.allowed_combinations) {
    if (!styleIds.has(c.style)) problems.push(`allowed_combinations references unknown style '${c.style}'`);
  }
  if (r.figures.probability > 0 && r.figures.kinds.length === 0) {
    problems.push('figures.probability > 0 but no figure kinds are listed');
  }
  for (const k of r.figures.kinds) {
    if (k.kind === 'table' && (!k.rows || !k.columns)) problems.push('table figures need rows and columns ranges');
    if (k.kind !== 'table' && (!k.series || !k.points)) problems.push(`${k.kind} figures need series and points ranges`);
    for (const key of ['rows', 'columns', 'series', 'points']) {
      if (k[key] && k[key].min > k[key].max) problems.push(`figures.${k.kind}.${key}: min > max`);
    }
  }
  for (const key of ['length_words', 'reading_level_grade']) {
    if (r[key].min > r[key].max) problems.push(`${key}: min > max`);
  }
  const qc = r.question_set.count;
  if (!(qc.min <= qc.typical && qc.typical <= qc.max)) problems.push('question count must satisfy min <= typical <= max');
  return problems;
}

/**
 * @returns {Promise<Map<string, {rules: object, rulesVersion: string, contentHash: string, file: string}>>}
 */
export async function loadRules({ dir, allowDraft = false, logger = null }) {
  const schema = JSON.parse(await readFile(path.join(dir, 'rules.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  if (!files.length) throw new RulesInvalidError(dir, ['no rules files (*.yaml) found']);

  const loaded = new Map();
  for (const file of files) {
    const raw = await readFile(path.join(dir, file));
    let rules;
    try {
      rules = yaml.load(raw.toString('utf8'));
    } catch (err) {
      throw new RulesInvalidError(file, [`YAML parse error: ${err.message}`]);
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(rules?.schema_version)) {
      throw new RulesInvalidError(file, [`unsupported schema_version ${rules?.schema_version}`]);
    }
    if (!validate(rules)) {
      throw new RulesInvalidError(file, validate.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`));
    }
    const problems = crossFieldProblems(rules);
    if (rules.subject !== path.basename(file, '.yaml')) problems.push(`subject '${rules.subject}' does not match the file name`);
    if (rules.status !== 'approved' && !allowDraft) {
      problems.push(`status is '${rules.status}'; only approved rules are loaded (URT_ALLOW_DRAFT_RULES=true is dev-only)`);
    }
    if (problems.length) throw new RulesInvalidError(file, problems);
    loaded.set(rules.subject, { rules, rulesVersion: rules.rules_version,
      contentHash: createHash('sha256').update(raw).digest('hex'), file });
    logger?.info?.({ event: 'urt_rules_loaded', subject: rules.subject, rulesVersion: rules.rules_version,
      status: rules.status });
  }
  return loaded;
}

/**
 * Mirror the loaded rules into urt_rule_sets (one row per subject + version). Existing rows are left
 * as they are; a changed file under an unchanged version is an error, because versions must be bumped.
 */
export async function syncRuleSets(UrtRuleSet, loaded) {
  for (const { rules, rulesVersion, contentHash, file } of loaded.values()) {
    const [row, created] = await UrtRuleSet.findOrCreate({
      where: { subject: rules.subject, rulesVersion },
      defaults: { schemaVersion: rules.schema_version, contentHash, status: 'approved', rules, activatedAt: new Date() },
    });
    if (!created && row.contentHash !== contentHash) {
      throw new RulesInvalidError(file, [`content changed but rules_version ${rulesVersion} was not bumped`]);
    }
    if (!created && row.status === 'retired') {
      throw new RulesInvalidError(file, [`rules_version ${rulesVersion} is retired; bump the version to reactivate`]);
    }
  }
}
