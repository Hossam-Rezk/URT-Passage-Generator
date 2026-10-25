// Pre-seeds the fresh buffer before launch (PLAN.md §7.3, milestone M10).
//   node scripts/urt/seedPool.js --per-subject 20 --max-usd 10 [--subjects physics,english] [--dry-run]
// Runs inside the platform (it needs the database): it creates 'seed' generation jobs and runs them
// through the normal job pipeline, stopping when the cost cap is reached. --dry-run prints the plan and
// an estimate without calling any model.
// MERGE: the two imports marked below must point at the platform's Sequelize instance and models.
import { loadUrtConfig } from '../../services/urt/config.js';
import { createUrtModule } from '../../services/urt/index.js';
import { parseArgs } from './runtime.js';

const args = parseArgs(process.argv.slice(2));
const perSubject = Number(args['per-subject'] ?? 0);
const maxUsd = Number(args['max-usd'] ?? 0);
const ESTIMATE_PER_PASSAGE_USD = 0.1; // measured ~$0.065 in M6; padded by 1.5x because list prices undercounted

if (!(perSubject > 0) || !(maxUsd > 0)) {
  console.error('usage: node scripts/urt/seedPool.js --per-subject N --max-usd X [--subjects a,b] [--dry-run]');
  process.exit(1);
}

const config = loadUrtConfig();
// Loaded lazily: these need the platform's sequelize package and database config.
const { createSequelizeRepository } = await import('../../services/urt/repository/sequelizeRepository.js');
const { default: sequelize } = await import('../../config/database.js'); // MERGE: platform Sequelize instance
const { applyUrtAssociations } = await import('../../models/associations.urt.js'); // MERGE: platform models
const repo = createSequelizeRepository({ sequelize, models: applyUrtAssociations() });
const urt = await createUrtModule({ config, repo, logger: { info: (e) => console.log(JSON.stringify(e)), warn: console.warn, error: (e) => console.error(JSON.stringify(e)) } });
const subjects = args.subjects ? String(args.subjects).split(',') : urt.subjects;

const plan = [];
for (const s of subjects) {
  const fresh = await repo.countFresh(s);
  plan.push({ subject: s, fresh, toGenerate: Math.max(0, perSubject - fresh) });
}
const total = plan.reduce((n, p) => n + p.toGenerate, 0);
console.table(plan);
console.log(`${total} passages to generate; estimated ~$${(total * ESTIMATE_PER_PASSAGE_USD).toFixed(2)}; cap $${maxUsd}`);
if (args['dry-run'] || total === 0) process.exit(0);

const started = new Date();
let stopped = false;
for (const p of plan) {
  for (let i = 0; i < p.toGenerate && !stopped; i += 1) {
    await urt.jobs.enqueue({ subject: p.subject, purpose: 'seed' });
    // Keep at most maxConcurrent jobs in flight so the cap is checked between passages.
    if (urt.queue.size.waiting > 0) await urt.queue.idle();
    const spent = await repo.costSince(started);
    if (spent + ESTIMATE_PER_PASSAGE_USD > maxUsd) {
      console.error(`stopping: $${spent.toFixed(4)} spent, the next passage could exceed the $${maxUsd} cap`);
      stopped = true;
    }
  }
}
await urt.queue.idle();
const after = [];
for (const s of subjects) after.push({ subject: s, fresh: await repo.countFresh(s) });
console.table(after);
console.log(`spent $${(await repo.costSince(started)).toFixed(4)}`);
await sequelize.close();
