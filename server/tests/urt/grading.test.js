import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestModule, createScriptedClient, seedPassage } from './moduleHarness.js';

async function served(urt, repo, userId, n = 'g') {
  const id = await seedPassage(repo, { n: `${n}-${userId}-${Math.random()}` });
  const s = await repo.serveSpecific(userId, id, 'generated');
  const { questions } = await repo.getServingForGrading(s.id);
  return { servingId: s.id, passageId: id, questions };
}

describe('grading and feedback (PLAN §6.4, §9)', () => {
  it('scores answers, treats unanswered as wrong, and explains only the wrong ones', async () => {
    const { urt, repo, counts } = await buildTestModule();
    const { servingId, questions: [q1, q2] } = await served(urt, repo, 21);
    const result = await urt.grading.submit({ servingId, userId: 21,
      body: { answers: [{ questionId: q1.id, answer: q1.correctAnswer }] } }); // q2 left blank
    assert.equal(result.score, 1);
    assert.equal(result.total, 2);
    assert.deepEqual(result.results.map((r) => r.isCorrect), [true, false]);
    assert.equal(result.results[1].chosen, null);
    assert.deepEqual(result.explanations.map((e) => e.questionId), [q2.id]);
    assert.equal(counts.feedback, 1);
    const row = repo.db.servings.find((s) => s.id === servingId);
    assert.equal(row.score, 50);
    assert.ok(row.submittedAt);
  });

  it('a second submission returns 409 with the stored result', async () => {
    const { urt, repo } = await buildTestModule();
    const { servingId, questions: [q1] } = await served(urt, repo, 22);
    const first = await urt.grading.submit({ servingId, userId: 22, body: { answers: [{ questionId: q1.id, answer: 'A' }] } });
    await assert.rejects(urt.grading.submit({ servingId, userId: 22, body: { answers: [] } }), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'URT_ALREADY_SUBMITTED');
      assert.deepEqual(e.result, first);
      return true;
    });
  });

  it('only the owner can submit', async () => {
    const { urt, repo } = await buildTestModule();
    const { servingId } = await served(urt, repo, 23);
    await assert.rejects(urt.grading.submit({ servingId, userId: 24, body: { answers: [] } }), (e) => e.status === 403);
  });

  for (const [name, body] of [
    ['an unknown question', (q) => ({ answers: [{ questionId: 999999, answer: 'A' }] })],
    ['a question answered twice', (q) => ({ answers: [{ questionId: q.id, answer: 'A' }, { questionId: q.id, answer: 'B' }] })],
    ['a label that is not an option', (q) => ({ answers: [{ questionId: q.id, answer: 'E' }] })],
    ['a malformed body', () => ({ answers: 'all of them' })],
  ]) {
    it(`rejects ${name} with 400`, async () => {
      const { urt, repo } = await buildTestModule();
      const { servingId, questions: [q1] } = await served(urt, repo, 25);
      await assert.rejects(urt.grading.submit({ servingId, userId: 25, body: body(q1) }), (e) => e.status === 400);
      assert.equal(repo.db.servings.find((s) => s.id === servingId).submittedAt, null, 'nothing stored on a bad request');
    });
  }

  it('serves explanations from the cache: the same wrong answer costs no second LLM call', async () => {
    const { urt, repo, counts } = await buildTestModule();
    const id = await seedPassage(repo, { n: 'shared' });
    const ids = [];
    for (const u of [31, 32]) ids.push((await repo.serveSpecific(u, id, u === 31 ? 'generated' : 'reused')).id);
    const { questions: [q1, q2] } = await repo.getServingForGrading(ids[0]);
    const body = { answers: [{ questionId: q1.id, answer: 'A' }, { questionId: q2.id, answer: q2.correctAnswer }] };
    const a = await urt.grading.submit({ servingId: ids[0], userId: 31, body });
    const b = await urt.grading.submit({ servingId: ids[1], userId: 32, body });
    assert.equal(counts.feedback, 1);
    assert.deepEqual(a.explanations, b.explanations);
    assert.equal(repo.db.cache[0].hitCount, 1);
    assert.equal(repo.db.cache[0].chosenAnswer, 'A');
  });

  it('an unanswered question uses its own cache key', async () => {
    const { urt, repo } = await buildTestModule();
    const { servingId } = await served(urt, repo, 33);
    await urt.grading.submit({ servingId, userId: 33, body: { answers: [] } });
    assert.ok(repo.db.cache.every((c) => c.chosenAnswer === ''));
    assert.equal(repo.db.cache.length, 2);
  });

  it('still grades when the feedback model fails, without explanations', async () => {
    const { urt, repo } = await buildTestModule({ client: createScriptedClient({ feedbackFails: true }) });
    const { servingId, questions: [q1] } = await served(urt, repo, 34);
    const result = await urt.grading.submit({ servingId, userId: 34, body: { answers: [{ questionId: q1.id, answer: 'A' }] } });
    assert.equal(result.total, 2);
    assert.deepEqual(result.explanations, []);
    assert.equal(repo.db.cache.length, 0);
  });

  it('correct answers never get an explanation', async () => {
    const { urt, repo, counts } = await buildTestModule();
    const { servingId, questions } = await served(urt, repo, 35);
    const result = await urt.grading.submit({ servingId, userId: 35,
      body: { answers: questions.map((q) => ({ questionId: q.id, answer: q.correctAnswer })) } });
    assert.equal(result.score, 2);
    assert.deepEqual(result.explanations, []);
    assert.equal(counts.feedback, 0);
  });
});
