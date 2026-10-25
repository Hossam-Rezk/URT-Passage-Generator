import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createUrtRouter } from '../../routes/urtPassageRoutes.js';
import { buildTestModule, seedPassage } from './moduleHarness.js';

// Stand-in for the platform's userAuth: the tests send "x-test-user: <id>:<role>".
function fakeAuth(req, res, next) {
  const h = req.get('x-test-user');
  if (!h) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'login required' } });
  const [id, role] = h.split(':');
  req.user = { id: Number(id), role };
  return next();
}
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: { code: 'URT_FORBIDDEN' } }));

describe('/api/urt routes', () => {
  let server;
  let base;
  let ctx;

  before(async () => {
    ctx = await buildTestModule({ env: { URT_NEXT_RATE_LIMIT_PER_MIN: '4', URT_JOB_POLL_MS: '1000' } });
    const app = express();
    app.use('/api/urt', createUrtRouter({ urt: ctx.urt, auth: fakeAuth, requireAdmin }));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/urt`;
  });
  after(() => new Promise((resolve) => { server.close(resolve); }));

  const call = async (method, path, user, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json',
      ...(user ? { 'x-test-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  };

  it('requires authentication and the student role', async () => {
    assert.equal((await call('GET', '/subjects')).status, 401);
    assert.equal((await call('GET', '/subjects', '1:teacher')).status, 403);
    const r = await call('GET', '/subjects', '1:student');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.subjects.sort(), ['biology', 'chemistry', 'english', 'geology', 'physics']);
  });

  it('new student: 202 with a job, then polling returns the passage without any answer key', async () => {
    const first = await call('POST', '/passages/next', '41:student', { subject: 'physics' });
    assert.equal(first.status, 202);
    assert.equal(first.json.retryAfterMs, 1000);
    assert.equal(first.headers.get('retry-after'), '1');
    assert.equal(first.json.pollUrl, `/api/urt/jobs/${first.json.jobId}`);
    await ctx.urt.queue.idle();
    const poll = await call('GET', `/jobs/${first.json.jobId}`, '41:student');
    assert.equal(poll.status, 200);
    assert.ok(poll.json.servingId && poll.json.passage.title && poll.json.questions.length);
    for (const leak of ['correctAnswer', 'distractorRationale', 'source', 'validationReport', 'embedding']) {
      assert.ok(!poll.text.includes(leak), `response leaks ${leak}`);
    }
    const again = await call('GET', `/servings/${poll.json.servingId}`, '41:student');
    assert.deepEqual(again.json, poll.json, 'the serving can be recovered after a reload');
  });

  it('a stored fresh passage is served directly with 200', async () => {
    await seedPassage(ctx.repo, { subject: 'geology', topicId: 'soils', n: 'api-fresh' });
    const r = await call('POST', '/passages/next', '42:student', { subject: 'geology' });
    assert.equal(r.status, 200);
    assert.equal(r.json.passage.subject, 'geology');
  });

  it('submission: 200 result, 409 the second time, and the result is kept on the serving', async () => {
    await seedPassage(ctx.repo, { subject: 'biology', topicId: 'genetics', n: 'api-submit' });
    const s = await call('POST', '/passages/next', '43:student', { subject: 'biology' });
    const [q1] = s.json.questions;
    const sub = await call('POST', `/servings/${s.json.servingId}/submission`, '43:student',
      { answers: [{ questionId: q1.id, answer: 'A' }] });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.total, 2);
    assert.equal(sub.json.results[0].correctAnswer, 'B');
    assert.equal(sub.json.explanations.length, 2);
    const twice = await call('POST', `/servings/${s.json.servingId}/submission`, '43:student', { answers: [] });
    assert.equal(twice.status, 409);
    assert.equal(twice.json.error.code, 'URT_ALREADY_SUBMITTED');
    assert.deepEqual(twice.json.error.result, sub.json);
    const view = await call('GET', `/servings/${s.json.servingId}`, '43:student');
    assert.deepEqual(view.json.result, sub.json);
  });

  it('another student cannot read or submit someone else\'s serving or job', async () => {
    await seedPassage(ctx.repo, { subject: 'chemistry', topicId: 'kinetics', n: 'api-own' });
    const s = await call('POST', '/passages/next', '44:student', { subject: 'chemistry' });
    assert.equal((await call('GET', `/servings/${s.json.servingId}`, '45:student')).status, 403);
    assert.equal((await call('POST', `/servings/${s.json.servingId}/submission`, '45:student', { answers: [] })).status, 403);
    const job = await call('POST', '/passages/next', '46:student', { subject: 'english' });
    assert.equal((await call('GET', `/jobs/${job.json.jobId}`, '47:student')).status, 403);
    await ctx.urt.queue.idle();
  });

  it('validates input', async () => {
    const bad = await call('POST', '/passages/next', '48:student', { subject: 'history' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'URT_INVALID_SUBJECT');
    assert.equal((await call('GET', '/servings/abc', '48:student')).status, 404);
    assert.equal((await call('GET', '/jobs/00000000-0000-4000-8000-000000000000', '48:student')).status, 404);
    const raw = await fetch(`${base}/passages/next`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-test-user': '48:student' }, body: '{not json' });
    assert.equal(raw.status, 400);
  });

  it('rate-limits next requests per student', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await call('POST', '/passages/next', '49:student', { subject: 'physics' })).status);
    assert.ok(statuses.slice(0, 4).every((s) => s !== 429), statuses.join(','));
    assert.deepEqual(statuses.slice(4), [429, 429]);
    await ctx.urt.queue.idle();
  });

  it('admin endpoints: stats and retire', async () => {
    assert.equal((await call('GET', '/admin/stats', '1:student')).status, 403);
    const stats = await call('GET', '/admin/stats', '1:admin');
    assert.equal(stats.status, 200);
    assert.ok(stats.json.pool.physics && 'costToday' in stats.json);
    const id = await seedPassage(ctx.repo, { n: 'to-retire' });
    assert.equal((await call('POST', `/admin/passages/${id}/retire`, '1:admin', {})).status, 400);
    const r = await call('POST', `/admin/passages/${id}/retire`, '1:admin', { reason: 'factual error reported' });
    assert.deepEqual(r.json, { id, status: 'retired' });
    assert.equal((await call('POST', '/admin/passages/999999/retire', '1:admin', { reason: 'x' })).status, 404);
  });
});
