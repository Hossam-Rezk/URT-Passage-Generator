// Scripted LLM client for tests. `respond(call)` returns the reply text (or an object, which is
// JSON-encoded) for each chat call; `embedFn(text)` returns a vector. Every call is recorded.
export function createFakeLlmClient({ respond, embedFn = () => [1, 0, 0], tokens = { input: 100, output: 50 } } = {}) {
  const calls = [];
  return {
    calls,
    async chat(call) {
      calls.push({ type: 'chat', ...call });
      const reply = await respond(call, calls.length);
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'string' ? reply : JSON.stringify(reply),
        inputTokens: tokens.input, outputTokens: tokens.output };
    },
    async embed({ model, texts }) {
      calls.push({ type: 'embed', model, texts });
      return { vectors: texts.map((t) => embedFn(t)), inputTokens: texts.length * 10 };
    },
  };
}
