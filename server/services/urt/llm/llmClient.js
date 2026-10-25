// The LLM interface the agents use: generateStructured, generateText, embed (PLAN.md §4.2).
//
// A provider client only has to implement two calls:
//   chat({ model, messages, temperature, maxTokens, json }) -> { text, inputTokens, outputTokens }
//   embed({ model, texts })                                  -> { vectors, inputTokens }
// openaiCompatibleClient.js is the implementation in use; fakeLlmClient.js is for tests. A direct
// Gemini client (@google/genai) can be added behind the same two calls.
//
// This layer adds what every role needs: retries with backoff on transient errors (429/5xx/timeouts),
// one more attempt with the validation errors when structured output does not match its zod schema,
// and recording token usage in the cost ledger.

export class TransientLlmError extends Error {}

export class StructuredOutputError extends Error {
  constructor(message, { issues, lastText }) {
    super(message);
    this.issues = issues;
    this.lastText = lastText;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Parse the first complete JSON object in the reply; models sometimes add text or a second object after it. */
export function parseJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return JSON.parse(text); // throws a useful message
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return JSON.parse(text.slice(start)); // unbalanced: let JSON.parse report it
}

function describeIssues(error) {
  return error.issues.slice(0, 20).map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function createLlm({ client, ledger, maxRetries = 3, sleep = defaultSleep, logger = null }) {
  async function withTransientRetry(fn, label) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof TransientLlmError) || attempt >= maxRetries) throw err;
        const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        logger?.warn?.({ event: 'urt_llm_retry', label, attempt: attempt + 1, error: err.message });
        await sleep(delay);
      }
    }
  }

  async function chatOnce({ role, model, messages, temperature, maxTokens, json, ref }) {
    const started = Date.now();
    const res = await withTransientRetry(
      () => client.chat({ model, messages, temperature, maxTokens, json }), `${role}:${ref ?? ''}`);
    const costUsd = ledger.record({ role, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, ref });
    logger?.info?.({ event: 'urt_llm_call', role, model, ref, inputTokens: res.inputTokens,
      outputTokens: res.outputTokens, costUsd, latencyMs: Date.now() - started });
    return res;
  }

  return {
    /**
     * Ask for JSON matching `schema` (a zod schema). `prompt` is the system/instruction text and
     * `input` the user content. Returns the parsed, validated value.
     */
    async generateStructured({ role, model, prompt, input, schema, temperature = 0.4, maxTokens = 8192, ref }) {
      const messages = [{ role: 'system', content: prompt }, { role: 'user', content: input }];
      let lastText = '';
      let issues = null;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const res = await chatOnce({ role, model, messages, temperature, maxTokens, json: true, ref });
        lastText = res.text;
        let value;
        try {
          value = parseJson(res.text);
        } catch (err) {
          issues = `- (root): not valid JSON (${err.message})`;
        }
        if (value !== undefined) {
          const parsed = schema.safeParse(value);
          if (parsed.success) return parsed.data;
          issues = describeIssues(parsed.error);
        }
        logger?.warn?.({ event: 'urt_llm_schema_invalid', role, ref, attempt, issues });
        messages.push({ role: 'assistant', content: res.text },
          { role: 'user', content: `Your reply did not match the required JSON format:\n${issues}\n`
            + 'Reply again with the complete corrected JSON object only.' });
      }
      throw new StructuredOutputError(`${role}: output did not match the schema after ${maxRetries} attempts`,
        { issues, lastText });
    },

    async generateText({ role, model, prompt, input, temperature = 0.4, maxTokens = 2048, ref }) {
      const res = await chatOnce({ role, model, temperature, maxTokens, json: false, ref,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: input }] });
      return res.text;
    },

    async embed({ model, texts, ref }) {
      const res = await withTransientRetry(() => client.embed({ model, texts }), `embed:${ref ?? ''}`);
      ledger.record({ role: 'embedding', model, inputTokens: res.inputTokens, outputTokens: 0, ref });
      return res.vectors;
    },
  };
}
