// Local dev server for the URT API: the real /api/urt router and services on an in-memory database.
//   npm start            offline: no model calls (placeholder generation, feedback from distractor notes)
//   npm run live         real gateway (needs URT_OPENAI_BASE_URL / URT_OPENAI_API_KEY and credit)
// Seeds the pool with the generated samples in ../data/urt_samples/ when present.
// Dev login: the page sends "x-dev-user: <id>:<role>"; there is no real authentication here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createUrtRouter } from '../server/routes/urtPassageRoutes.js';
import { loadUrtConfig } from '../server/services/urt/config.js';
import { toPassageRows } from '../server/services/urt/generation/passageProducer.js';
import { createUrtModule } from '../server/services/urt/index.js';
import { createMemoryRepository } from '../server/services/urt/repository/memoryRepository.js';
import { createScriptedClient } from '../server/tests/urt/moduleHarness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const live = process.argv.includes('--live');
const port = Number(process.env.PORT ?? 4310);

function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=./.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
}

/** Offline client: scripted generation, and feedback written from each question's distractor note. */
function offlineClient() {
  const scripted = createScriptedClient();
  const respond = scripted.client;
  return {
    async chat(call) {
      if (call.messages[0].content.includes('You are a patient tutor')) {
        const { questions } = JSON.parse(call.messages.at(-1).content);
        const explanations = questions.map((q) => {
          const right = q.options.find((o) => o.label === q.correctAnswer)?.text ?? q.correctAnswer;
          const why = q.studentAnswer === '(left blank)' ? 'You left this question blank.'
            : `You chose ${q.studentAnswer}. ${q.distractorNote ?? 'That option is not supported by the passage.'}`;
          return { questionId: q.questionId, explanation: `${why} The correct answer is ${q.correctAnswer}: ${right} [offline dev explanation]` };
        });
        return { text: JSON.stringify({ explanations }), inputTokens: 0, outputTokens: 0 };
      }
      return respond.chat(call);
    },
    embed: (args) => respond.embed(args),
  };
}

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
env.URT_OPENAI_BASE_URL ||= env.URT_CA_OPENAI_BASE_URL || 'https://offline.invalid/v1';
env.URT_OPENAI_API_KEY ||= env.URT_CA_OPENAI_API_KEY || 'offline';
const config = loadUrtConfig({
  URT_FRESH_BUFFER_LOW: '0', URT_FRESH_BUFFER_TARGET: '0', // no background spending from the dev server
  URT_NEXT_RATE_LIMIT_PER_MIN: '60', URT_JOB_POLL_MS: '1500', ...env,
  URT_RULES_DIR: path.join(ROOT, 'server', 'urt', 'rules'), URT_PROMPTS_DIR: path.join(ROOT, 'server', 'urt', 'prompts'),
});

const repo = createMemoryRepository();
const logger = { info: () => {}, warn: (e) => console.warn(JSON.stringify(e)), error: (e) => console.error(JSON.stringify(e)) };
const urt = await createUrtModule({ config, repo, client: live ? null : offlineClient(), logger });

// Seed the pool with the reviewed samples (fresh: nobody has seen them yet).
const samplesDir = path.join(ROOT, 'data', 'urt_samples');
let seeded = 0;
if (existsSync(samplesDir)) {
  for (const f of readdirSync(samplesDir).filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(path.join(samplesDir, f), 'utf8'));
    if (!r.ok) continue;
    await repo.insertPassage(toPassageRows(r, { generationModel: 'sample', promptVersion: 'generation.v1', embeddingModel: config.models.embedding }));
    seeded += 1;
  }
}

function devAuth(req, res, next) {
  const [id, role] = String(req.get('x-dev-user') ?? '').split(':');
  if (!/^\d+$/.test(id ?? '')) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Pick a student id first' } });
  req.user = { id: Number(id), role: role || 'student' };
  return next();
}
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next()
  : res.status(403).json({ error: { code: 'URT_FORBIDDEN', message: 'Admin only' } }));

const app = express();
app.use('/api/urt', createUrtRouter({ urt, auth: devAuth, requireAdmin, studentRoles: ['student', 'admin'], logger }));
app.get('/api/dev/info', (req, res) => res.json({ mode: live ? 'live' : 'offline', seeded, subjects: urt.subjects }));
app.use(express.static(path.join(HERE, 'public')));
app.listen(port, () => {
  console.log(`URT dev frontend: http://localhost:${port}  (${live ? 'LIVE models, costs money' : 'offline, no model calls'}; ${seeded} sample passage(s) seeded)`);
});
