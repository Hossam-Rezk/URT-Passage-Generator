# Integrating the URT passage generator into the ElRokh Academy monorepo

This repository mirrors the monorepo's `/server` and `/docs` layout. Copy the paths below into the
monorepo, then work through the merge points. API contract: [`docs/api/urt-passages.md`](docs/api/urt-passages.md).

## What to copy

| From here | Purpose |
|---|---|
| `server/routes/urtPassageRoutes.js`, `server/controllers/urtPassageController.js` | `/api/urt` routes |
| `server/services/urt/**` | config, LLM client, rules loader, sampler, agents, originality, serving, jobs, grading |
| `server/models/urt*Model.js`, `server/models/urtConstants.js`, `server/models/associations.urt.js` | Sequelize models |
| `server/migrations/20261101000001-create-urt-tables.cjs` | creates the seven `urt_*` tables |
| `server/urt/rules/**` | approved rules (`*.yaml`), `rules.schema.json`, fingerprints (no source text) |
| `server/urt/prompts/**` | versioned prompts; keep old versions, stored passages reference them |
| `server/scripts/urt/seedPool.js` (+ `runtime.js`) | pre-seed the fresh buffer before launch |
| `server/tests/urt/**` | `node:test` suite (`node --test tests/urt/`) |
| `docs/api/urt-passages.md`, `docs/architecture/decisions/005-urt-passage-generator.md`, `docs/database_system.urt.md` | docs; merge the last into `docs/database_system.md` |

Not for the monorepo: `tools/corpus_analysis/` (one-time Phase 1 tool), `server/package.json` (add its
dependencies instead), `server/scripts/urt/{samplePassages,evalValidator,renderSamples}.js` (dev aids).

## Dependencies

Add to the platform's `server/package.json`: `zod` ^3, `ajv` ^8, `js-yaml` ^4 (runtime). Express 5 and
Sequelize are already there. Tests use the built-in `node:test` (OPEN-3).

## Merge points

| # | What | Where | Note |
|---|---|---|---|
| 1 | Migrations folder and runner (OPEN-3) | `server/migrations/…cjs` | written for sequelize-cli (CommonJS) |
| 2 | The Sequelize instance | one `import sequelize from '../config/database.js'` per model; `seedPool.js` | point at the platform's instance |
| 3 | The User model | `associations.urt.js` | call `applyUrtAssociations()` from `associations.js` after User is defined |
| 4 | `users.id` signedness | migration `userId` columns | if `users.id` is `INT UNSIGNED`, make `userId` unsigned too, or the FKs fail |
| 5 | Collation | migration `TABLE_OPTIONS` | match the platform (currently `utf8mb4_0900_ai_ci`) |
| 6 | Error shape and rate limits (OPEN-4) | `sendError()` in the controller, `createPerUserRateLimit()` in the routes | swap for platform helpers |
| 7 | Background jobs | `services/urt/jobs/jobQueue.js` | in-process priority queue; adapt to `jobQueueService.js` if it supports priority + concurrency |
| 8 | Admin/teacher check | `requireAdmin` passed to `createUrtRouter` | |

## Startup wiring

```js
import { loadUrtConfig } from './services/urt/config.js';
import { createUrtModule } from './services/urt/index.js';
import { createSequelizeRepository } from './services/urt/repository/sequelizeRepository.js';
import { applyUrtAssociations } from './models/associations.urt.js';
import { createUrtRouter } from './routes/urtPassageRoutes.js';

const config = loadUrtConfig();                       // throws, listing every bad URT_* variable
const repo = createSequelizeRepository({ sequelize, models: applyUrtAssociations() });
const urt = await createUrtModule({ config, repo, logger });   // throws if a rules file is invalid
// optional: mirror the rules into urt_rule_sets
// await syncRuleSets(models.UrtRuleSet, urt.rules);          (services/urt/rules/rulesLoader.js)
app.use('/api/urt', createUrtRouter({ urt, auth: [userAuth, checkAgent], requireAdmin, logger }));
```

If `loadUrtConfig` or `createUrtModule` throws, do not mount the routes; the error lists the problems.
`logger` takes structured objects (`logger.error({ event, ... })`); alerts to watch:
`urt_generation_failed`, `urt_fallback_served`, `urt_buffer_empty`, `urt_daily_cost_cap_reached`,
`urt_rules_invalid`, `urt_feedback_failed`.

## Configuration

All `URT_*` variables are documented in [`.env.example`](.env.example) and validated by
`server/services/urt/config.js`. Required: `URT_OPENAI_BASE_URL`, `URT_OPENAI_API_KEY`. Decide OPEN-1 with
`URT_NEW_STUDENTS_GET_FRESH` (default `true`). Prices for every configured model must be known
(`URT_MODEL_PRICES` to override), or startup fails.

## Client (React / Electron / Capacitor)

1. `POST /api/urt/passages/next {subject}`. On `200`, render the serving. On `202`, wait `retryAfterMs`
   (or `Retry-After`) and poll `pollUrl` until `200` or `503`.
2. Render `passage.body` as paragraphs (split on blank lines) and each `figures[]` item: tables as
   tables, charts from `series[].points` with the axis labels and units (`xAxis.categories` for bar charts
   over named categories). Questions with `figureRef` refer to that figure.
3. Keep `servingId`; `GET /servings/:id` restores the passage (and the result, once submitted) after a reload.
4. `POST /servings/:id/submission`; show `results` and the `explanations` (only for wrong or blank answers).
   A `409` means it was already submitted; its body holds the stored result.

## Before launch (checklist)

- [ ] Run the migration up/down/up on MySQL 8 and the integration tests in PLAN §13 (`GET_LOCK`,
      `SKIP LOCKED`, concurrent double requests). `sequelizeRepository.js` has **not** been run against MySQL yet.
- [ ] Run `scripts/urt/evalValidator.js` with the current prompts; catch rate ≥ 95% and the clean control accepted.
- [ ] Review a batch of samples (`samplePassages.js`, `renderSamples.js`) and measure cost per passage.
- [ ] Decide OPEN-1 and pre-seed: `node scripts/urt/seedPool.js --per-subject N --max-usd X`.
- [ ] Optional: add Flesch–Kincaid-calibrated reading ranges to the rules and make the reading-level check hard.
