// Client for an OpenAI-compatible gateway (chat completions + embeddings), using Node's fetch.
// The gateway in use ignores `json_schema` response formats, so structured calls request
// `json_object` and the schema is described in the prompt; llmClient.js validates the result.
import { TransientLlmError } from './llmClient.js';

const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

export function createOpenAiCompatibleClient({ baseUrl, apiKey, timeoutMs = 180000, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) { // network failure or timeout
      throw new TransientLlmError(`${err.name}: ${err.message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const message = `LLM gateway HTTP ${res.status}: ${detail}`;
      if (TRANSIENT_STATUSES.has(res.status)) throw new TransientLlmError(message);
      throw new Error(message);
    }
    return res.json();
  }

  return {
    async chat({ model, messages, temperature, maxTokens, json }) {
      const data = await post('/chat/completions', {
        model, messages, temperature, max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      });
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    },

    async embed({ model, texts }) {
      const data = await post('/embeddings', { model, input: texts });
      const rows = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length) throw new Error(`embeddings: got ${rows.length} vectors for ${texts.length} texts`);
      return { vectors: rows.map((r) => r.embedding), inputTokens: data.usage?.prompt_tokens ?? 0 };
    },
  };
}
