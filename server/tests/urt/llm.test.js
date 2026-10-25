import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadUrtConfig, UrtConfigError } from '../../services/urt/config.js';
import { createFakeLlmClient } from '../../services/urt/llm/fakeLlmClient.js';
import { createLlm, StructuredOutputError, TransientLlmError } from '../../services/urt/llm/llmClient.js';
import { createOpenAiCompatibleClient } from '../../services/urt/llm/openaiCompatibleClient.js';
import { assertPriced, createCostLedger, UnknownModelPriceError } from '../../services/urt/observability/costLedger.js';

const PRICES = { m: { input: 1, output: 2 }, e: { input: 0.5, output: 0 } };
const noSleep = async () => {};

describe('config', () => {
  const env = { URT_OPENAI_BASE_URL: 'https://gw.example/v1', URT_OPENAI_API_KEY: 'k' };

  it('applies defaults', () => {
    const c = loadUrtConfig(env);
    assert.equal(c.generation.maxAttempts, 3);
    assert.equal(c.originality.maxCorpusJaccard, 0.2);
    assert.equal(c.models.embedding, 'text-embedding-3-small');
    assert.equal(c.rules.allowDraft, false);
  });

  it('lists every problem at once', () => {
    assert.throws(() => loadUrtConfig({ URT_MAX_CORPUS_COSINE: '2', URT_ALLOW_DRAFT_RULES: 'yes' }), (err) => {
      assert.ok(err instanceof UrtConfigError);
      for (const key of ['URT_OPENAI_BASE_URL', 'URT_OPENAI_API_KEY', 'URT_MAX_CORPUS_COSINE', 'URT_ALLOW_DRAFT_RULES']) {
        assert.match(err.message, new RegExp(key));
      }
      return true;
    });
  });

  it('refuses the same model for generation and validation', () => {
    assert.throws(() => loadUrtConfig({ ...env, URT_MODEL_GENERATION: 'x', URT_MODEL_VALIDATION: 'x' }), /must differ/);
  });

  it('merges URT_MODEL_PRICES', () => {
    const c = loadUrtConfig({ ...env, URT_MODEL_PRICES: '{"new-model": {"input": 1, "output": 1}}' });
    assert.ok(c.prices['new-model'] && c.prices['gemini-3.8-flash']);
  });
});

describe('cost ledger', () => {
  it('records cost and totals by role', () => {
    const l = createCostLedger(PRICES);
    assert.equal(l.record({ role: 'generation', model: 'm', inputTokens: 1e6, outputTokens: 5e5 }), 2);
    l.record({ role: 'embedding', model: 'e', inputTokens: 2e6 });
    const t = l.totals();
    assert.equal(t.costUsd, 3);
    assert.equal(t.byRole.generation.calls, 1);
  });

  it('refuses unpriced models', () => {
    assert.throws(() => createCostLedger(PRICES).record({ role: 'x', model: 'nope' }), UnknownModelPriceError);
    assert.throws(() => assertPriced(PRICES, ['m', 'nope']), /nope/);
  });
});

describe('llm layer', () => {
  const schema = z.object({ value: z.number() });

  it('retries a schema-invalid reply with the validation errors', async () => {
    const client = createFakeLlmClient({ respond: (_, n) => (n === 1 ? { value: 'three' } : '```json\n{"value": 3}\n```') });
    const ledger = createCostLedger(PRICES);
    const llm = createLlm({ client, ledger, sleep: noSleep });
    const out = await llm.generateStructured({ role: 'generation', model: 'm', prompt: 'p', input: 'i', schema });
    assert.deepEqual(out, { value: 3 });
    assert.equal(client.calls.length, 2);
    const retryMsg = client.calls[1].messages.at(-1).content;
    assert.match(retryMsg, /value/);
    assert.equal(client.calls[1].json, true);
    assert.equal(ledger.totals().calls, 2);
  });

  it('parses the first JSON object and ignores trailing text', async () => {
    const { parseJson } = await import('../../services/urt/llm/llmClient.js');
    assert.deepEqual(parseJson('Sure:\n{"a": {"b": "x}y"}} and then {"c": 2}'), { a: { b: 'x}y' } });
    assert.deepEqual(parseJson('```json\n{"q": "say \\"hi\\""}\n```'), { q: 'say "hi"' });
    assert.throws(() => parseJson('no json here'));
  });

  it('gives up after maxRetries schema failures', async () => {
    const client = createFakeLlmClient({ respond: () => 'not json' });
    const llm = createLlm({ client, ledger: createCostLedger(PRICES), maxRetries: 2, sleep: noSleep });
    await assert.rejects(llm.generateStructured({ role: 'g', model: 'm', prompt: 'p', input: 'i', schema }),
      StructuredOutputError);
    assert.equal(client.calls.length, 2);
  });

  it('retries transient errors with backoff, not other errors', async () => {
    let n = 0;
    const client = createFakeLlmClient({ respond: () => { n += 1; return n < 3 ? new TransientLlmError('429') : { value: 1 }; } });
    const llm = createLlm({ client, ledger: createCostLedger(PRICES), sleep: noSleep });
    assert.deepEqual(await llm.generateStructured({ role: 'g', model: 'm', prompt: 'p', input: 'i', schema }), { value: 1 });
    const failing = createFakeLlmClient({ respond: () => new Error('400 bad request') });
    await assert.rejects(createLlm({ client: failing, ledger: createCostLedger(PRICES), sleep: noSleep })
      .generateText({ role: 'g', model: 'm', prompt: 'p', input: 'i' }), /400/);
    assert.equal(failing.calls.length, 1);
  });

  it('embeds and records usage', async () => {
    const ledger = createCostLedger(PRICES);
    const llm = createLlm({ client: createFakeLlmClient({ embedFn: (t) => [t.length] }), ledger, sleep: noSleep });
    assert.deepEqual(await llm.embed({ model: 'e', texts: ['ab', 'abc'] }), [[2], [3]]);
    assert.equal(ledger.totals().byRole.embedding.inputTokens, 20);
  });
});

describe('openai-compatible client', () => {
  function fakeFetch(status, body) {
    const sent = [];
    const impl = async (url, init) => {
      sent.push({ url, ...init, body: JSON.parse(init.body) });
      return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return { impl, sent };
  }

  it('sends chat requests in json_object mode and reads usage', async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    const c = createOpenAiCompatibleClient({ baseUrl: 'https://gw.example/v1/', apiKey: 'k', fetchImpl: f.impl });
    const res = await c.chat({ model: 'm', messages: [], temperature: 0, maxTokens: 10, json: true });
    assert.deepEqual(res, { text: '{"a":1}', inputTokens: 7, outputTokens: 3 });
    assert.equal(f.sent[0].url, 'https://gw.example/v1/chat/completions');
    assert.equal(f.sent[0].headers.Authorization, 'Bearer k');
    assert.deepEqual(f.sent[0].body.response_format, { type: 'json_object' });
  });

  it('orders embeddings by index', async () => {
    const f = fakeFetch(200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { prompt_tokens: 4 } });
    const c = createOpenAiCompatibleClient({ baseUrl: 'https://gw.example/v1', apiKey: 'k', fetchImpl: f.impl });
    assert.deepEqual(await c.embed({ model: 'e', texts: ['a', 'b'] }), { vectors: [[1], [2]], inputTokens: 4 });
  });

  it('maps 429/5xx to transient errors and 4xx to plain errors', async () => {
    const busy = createOpenAiCompatibleClient({ baseUrl: 'https://x', apiKey: 'k', fetchImpl: fakeFetch(429, {}).impl });
    await assert.rejects(busy.chat({ model: 'm', messages: [] }), TransientLlmError);
    const bad = createOpenAiCompatibleClient({ baseUrl: 'https://x', apiKey: 'k', fetchImpl: fakeFetch(400, {}).impl });
    await assert.rejects(bad.chat({ model: 'm', messages: [] }), (e) => !(e instanceof TransientLlmError) && /400/.test(e.message));
  });
});
