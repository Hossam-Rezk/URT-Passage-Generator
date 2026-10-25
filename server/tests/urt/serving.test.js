import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryRepository } from '../../services/urt/repository/memoryRepository.js';
import { createRng } from '../../services/urt/selection/combinationSampler.js';
import { buildTestModule, createScriptedClient, seedPassage } from './moduleHarness.js';

// Give a student a history: serve passages directly with the given sources.
async function history(repo, userId, sources) {
  for (const source of sources) {
    const id = await seedPassage(repo, { n: `${userId}-${source}-${Math.random()}` });
    await repo.serveSpecific(userId, id, source);
  }
}
const sourceOf = async (repo, servingId) => (await repo.getServing(servingId)).serving.source;

describe('serving rule (PLAN §7.1)', () => {
  const states = [
    // [history (oldest → newest), expected source of the next serving]
    [[], 'generated'], [['generated'], 'generated'], [['reused'], 'generated'],
    [['reused', 'reused'], 'generated'],
    [['reused', 'generated'], 'reused'], [['generated', 'reused'], 'reused'], [['generated', 'generated'], 'reused'],
  ];
  for (const [past, expected] of states) {
    it(`history [${past.join(', ') || 'none'}] → ${expected}`, async () => {
      const { urt, repo } = await buildTestModule();
      await history(repo, 7, past);
      const other = 99;
      const reusable = await seedPassage(repo, { n: `reusable-${past}` });
      await repo.serveSpecific(other, reusable, 'generated'); // now served once: a reuse candidate
      await seedPassage(repo, { n: `fresh-${past}` }); // a fresh candidate
      const out = await urt.serving.next({ userId: 7, subject: 'physics' });
      assert.ok(out.servingId, JSON.stringify(out));
      assert.equal(await sourceOf(repo, out.servingId), expected);
    });
  }

  it('OPEN-1 switch: with newStudentsGetFresh=false a new student gets a stored passage', async () => {
    const { urt, repo } = await buildTestModule({ env: { URT_NEW_STUDENTS_GET_FRESH: 'false' } });
    const reusable = await seedPassage(repo, { n: 'r' });
    await repo.serveSpecific(99, reusable, 'generated');
    await seedPassage(repo, { n: 'f' });
    const out = await urt.serving.next({ userId: 1, subject: 'physics' });
    assert.equal(await sourceOf(repo, out.servingId), 'reused');
  });

  it('reuse prefers topics outside the student\'s recent topics, then the least-served passage', async () => {
    const { urt, repo } = await buildTestModule();
    await history(repo, 5, ['generated', 'generated']); // recent topic: mechanics
    const sameTopic = await seedPassage(repo, { topicId: 'mechanics', n: 'same' });
    const otherBusy = await seedPassage(repo, { topicId: 'optics', n: 'busy' });
    const otherQuiet = await seedPassage(repo, { topicId: 'optics', n: 'quiet' });
    for (const u of [90, 91]) await repo.serveSpecific(u, otherBusy, 'generated');
    for (const [u, p] of [[92, sameTopic], [93, otherQuiet]]) await repo.serveSpecific(u, p, 'generated');
    const out = await urt.serving.next({ userId: 5, subject: 'physics' });
    assert.equal((await repo.getServing(out.servingId)).passage.id, otherQuiet);
  });

  it('falls back to fresh when nothing reusable is left, then to an on-demand job', async () => {
    const { urt, repo } = await buildTestModule({ env: { URT_MAX_CONCURRENT_GENERATIONS: '1' } });
    await history(repo, 3, ['generated', 'generated']);
    const fresh = await seedPassage(repo, { n: 'only-fresh' });
    const a = await urt.serving.next({ userId: 3, subject: 'physics' });
    assert.equal((await repo.getServing(a.servingId)).passage.id, fresh);
    const b = await urt.serving.next({ userId: 3, subject: 'physics' });
    assert.ok(b.job && b.job.purpose === 'on_demand');
    await urt.queue.idle();
  });

  it('returns the same active job instead of starting a second one', async () => {
    const { urt } = await buildTestModule();
    const a = await urt.serving.next({ userId: 8, subject: 'physics' });
    const b = await urt.serving.next({ userId: 8, subject: 'physics' });
    assert.equal(a.job.id, b.job.id);
    await urt.queue.idle();
  });

  it('never serves retired passages or passages of a retired rules version', async () => {
    const { urt, repo } = await buildTestModule();
    const retired = await seedPassage(repo, { n: 'retired' });
    await repo.retirePassage(retired, 'test');
    await seedPassage(repo, { n: 'old-version', rulesVersion: 'physics-2025.01.0' });
    await repo.retireRulesVersion('physics-2025.01.0');
    const out = await urt.serving.next({ userId: 4, subject: 'physics' });
    assert.ok(out.job, 'nothing servable, so a job is started');
    await urt.queue.idle();
  });

  it('rejects an unknown subject', async () => {
    const { urt } = await buildTestModule();
    await assert.rejects(urt.serving.next({ userId: 1, subject: 'history' }), (e) => e.code === 'URT_INVALID_SUBJECT');
  });
});

describe('generation jobs (PLAN §7.2)', () => {
  it('an on-demand job generates, stores and serves the passage to the student', async () => {
    const { urt, repo, counts } = await buildTestModule();
    const { job } = await urt.serving.next({ userId: 11, subject: 'physics' });
    await urt.queue.idle();
    const done = await repo.getJob(job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.ok(done.passageId && done.servingId);
    assert.ok(done.costUsd > 0 && done.inputTokens > 0);
    const s = await repo.getServing(done.servingId);
    assert.equal(s.serving.userId, 11);
    assert.equal(s.serving.source, 'generated');
    assert.equal(s.serving.generationJobId, job.id);
    assert.equal(s.passage.promptVersion, 'generation.v2');
    assert.equal(counts.generation, 1);
    assert.equal(s.questions.length, done.combination.questionPlan.length);
  });

  it('retries a rejected draft and logs the failed attempt', async () => {
    const { urt, repo, counts } = await buildTestModule({ client: createScriptedClient({ brokenAttempt: (n) => n === 1 }) });
    const { job } = await urt.serving.next({ userId: 12, subject: 'english' });
    await urt.queue.idle();
    const done = await repo.getJob(job.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.attempts, 2);
    assert.match(JSON.stringify(done.failureReasons), /format_options/);
    assert.equal(counts.generation, 2);
  });

  it('falls back to an unseen stored passage when every attempt fails', async () => {
    const { urt, repo } = await buildTestModule({ client: createScriptedClient({ brokenAttempt: () => true }) });
    await history(repo, 13, ['reused', 'reused']); // needs fresh, none left → job
    const stored = await seedPassage(repo, { n: 'fallback' });
    await repo.serveSpecific(77, stored, 'generated');
    const { job } = await urt.serving.next({ userId: 13, subject: 'physics' });
    await urt.queue.idle();
    const done = await repo.getJob(job.id);
    assert.equal(done.status, 'completed');
    assert.equal((await repo.getServing(done.servingId)).passage.id, stored);
    assert.equal(done.attempts, 3);
    assert.ok(done.errorMessage);
  });

  it('fails with URT_GENERATION_UNAVAILABLE when there is nothing to fall back to', async () => {
    const { urt, repo } = await buildTestModule({ client: createScriptedClient({ brokenAttempt: () => true }) });
    const { job } = await urt.serving.next({ userId: 14, subject: 'physics' });
    await urt.queue.idle();
    const done = await repo.getJob(job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.servingId, null);
  });
});

describe('fresh buffer (PLAN §7.3)', () => {
  it('refills to the target when below the low mark, counting pending jobs', async () => {
    const { urt, repo } = await buildTestModule({ env: { URT_FRESH_BUFFER_LOW: '3', URT_FRESH_BUFFER_TARGET: '5' } });
    await seedPassage(repo, { n: 'f1' });
    assert.equal(await urt.buffer.refill('physics'), 4);
    assert.equal(await urt.buffer.refill('physics'), 0, 'pending refills count towards the target');
    await urt.queue.idle();
    assert.equal(await repo.countFresh('physics'), 5);
    assert.equal(await urt.buffer.refill('physics'), 0, 'at or above the low mark: nothing to do');
  });

  it('stops refilling once today\'s spend reaches the daily cap', async () => {
    const { urt, repo } = await buildTestModule({ env: { URT_FRESH_BUFFER_LOW: '2', URT_FRESH_BUFFER_TARGET: '2',
      URT_DAILY_COST_CAP_USD: '0.000001' } });
    const j = await repo.createJob({ subject: 'physics', purpose: 'seed' });
    await repo.updateJob(j.id, { status: 'completed', costUsd: 0.01 });
    assert.equal(await urt.buffer.refill('physics'), 0);
  });
});

describe('serving invariants (PLAN §7.4), random request sequences', () => {
  it('never serves a student the same passage twice, nor anything not validated', async () => {
    const repo = createMemoryRepository({ random: createRng('inv') });
    const { urt } = await buildTestModule({ repo });
    const rng = createRng('sequence');
    const users = [1, 2, 3, 4, 5];
    for (let i = 0; i < 12; i += 1) await seedPassage(repo, { n: `pool-${i}`, topicId: i % 2 ? 'optics' : 'mechanics' });
    for (let step = 0; step < 120; step += 1) {
      const r = rng();
      if (r < 0.08) {
        const p = repo.db.passages[Math.floor(rng() * repo.db.passages.length)];
        await repo.retirePassage(p.id, 'random retire');
      } else if (r < 0.12) {
        await urt.queue.idle();
      } else {
        await urt.serving.next({ userId: users[Math.floor(rng() * users.length)], subject: 'physics' });
      }
    }
    await urt.queue.idle();
    const pairs = repo.db.servings.map((s) => `${s.userId}:${s.passageId}`);
    assert.equal(new Set(pairs).size, pairs.length, 'a (student, passage) pair was served twice');
    for (const s of repo.db.servings) {
      const p = repo.db.passages.find((x) => x.id === s.passageId);
      const retiredBefore = p.retiredAt && p.retiredAt < s.servedAt;
      assert.ok(!retiredBefore, `passage ${p.id} served after it was retired`);
      assert.ok(['generated', 'reused'].includes(s.source));
      const firstServing = repo.db.servings.filter((x) => x.passageId === s.passageId).sort((a, b) => a.id - b.id)[0];
      assert.equal(s.source, firstServing.id === s.id ? 'generated' : 'reused', `serving ${s.id} has the wrong source`);
    }
  });
});
