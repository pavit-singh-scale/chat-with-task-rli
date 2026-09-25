import { config } from './config.js';

// One non-streaming chat-completion call against the LiteLLM proxy
// (OpenAI-compatible; same proxy + key as trajectory-viewer-v2).
// max_tokens has to cover thinking AND the reply — they share one budget. At
// effort "high" the old 4096 ceiling was consumed entirely by thinking on a
// docgen-sized prompt: finish_reason "length" with an EMPTY response body.
// 32000 leaves generous room for a long review doc plus its thinking; this is a
// non-streaming call, so it is bounded by the proxy's request timeout rather
// than by the ceiling itself.
// Just under Node's undici default header timeout (300s), so we abort with our
// own message rather than its opaque one. A realistic docgen prompt at 32000 /
// high measured ~200s; a deliberately maximal one ran past 9 minutes and would
// blow either ceiling.
const REQUEST_TIMEOUT_MS = 290_000;

export async function chatCompletion({ messages, tools, maxTokens = 32000, onUsage }) {
  if (!config.litellm.apiKey) throw new Error('LITELLM_API_KEY is not set — copy .env.example to .env');
  const body = {
    model: config.litellm.model,
    messages,
    max_tokens: maxTokens,
    // Opus 5.x controls thinking via adaptive mode + effort (high). It rejects
    // `temperature` (and LiteLLM's reasoning_effort→thinking.enabled mapping)
    // whenever thinking is on, so we pass the native Anthropic params straight
    // through the OpenAI-compatible proxy and send no temperature.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  };
  if (tools?.length) body.tools = tools;

  // The proxy throws transient 429/5xx under load — retry with backoff.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${config.litellm.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.litellm.apiKey}`,
        },
        body: JSON.stringify(body),
        // A big max_tokens at high effort can generate for minutes. Without an
        // explicit signal this hits Node's undici default (300s) and throws an
        // opaque UND_ERR_HEADERS_TIMEOUT that skips the retry logic below —
        // which only inspects res.ok. Fail with something a reader can act on.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error(
          `LiteLLM request exceeded ${REQUEST_TIMEOUT_MS / 1000}s (model ${config.litellm.model}, `
          + `max_tokens ${maxTokens}, effort ${body.output_config.effort}). The generation was still `
          + 'running — lower max_tokens or effort for this call.'
        );
      }
      throw e;
    }
    if (res.ok) break;
    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => '');
    const maxAttempts = res.status === 429 ? 6 : 3; // 429 = token-bucket; wait it out
    if (!retryable || attempt >= maxAttempts) throw new Error(`LiteLLM ${res.status}: ${detail.slice(0, 500)}`);
    let wait = 2000 * 2 ** attempt;
    if (res.status === 429) {
      // honor the proxy's "resets at: <ts> UTC" when present, capped at 90s
      const m = detail.match(/resets at:\s*([0-9-]+ [0-9:]+ UTC)/);
      const until = m ? Date.parse(m[1]) : NaN;
      wait = Number.isFinite(until) ? Math.min(Math.max(until - Date.now() + 1500, 2000), 90_000) : Math.min(wait, 30_000);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  const data = await res.json();
  if (onUsage && data.usage) onUsage(data.usage); // {prompt_tokens, completion_tokens, total_tokens}
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LiteLLM returned no message');
  return msg;
}

// Tool-use agent loop. onEvent receives progress events suitable for SSE:
//   {type:'tool', name, args}  {type:'assistant', content}
// Returns the full list of new messages (assistant + tool results) so the
// caller can persist them.
export async function runAgentLoop({ messages, tools, executor, onEvent, maxSteps = 15, onUsage }) {
  const transcript = [...messages];
  const added = [];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await chatCompletion({ messages: transcript, tools, onUsage });
    transcript.push(msg);
    added.push(msg);
    // A message that still carries tool_calls is the model narrating its next
    // step ("Let me check the trajectory…") — reasoning, not the answer. Flag it
    // so the client can keep it out of the transcript; only the last message,
    // the one with no tool calls, is the reply.
    const calls = msg.tool_calls || [];
    if (msg.content) onEvent?.({ type: 'assistant', content: msg.content, final: !calls.length });
    if (!calls.length) return { messages: added, final: msg.content || '' };

    // Tools may return { content, images: [{ mime, b64, label }] } — the text goes
    // back as the tool result and the images follow as one user message (the
    // chat-completions tool role carries text only). Images are sent this turn
    // and replaced by a text stub in the persisted transcript, so history
    // never balloons with base64.
    const pendingImages = [];
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch { /* model sent malformed JSON; executor sees {} */ }
      onEvent?.({ type: 'tool', name: call.function.name, args });
      let result;
      try {
        result = await executor(call.function.name, args);
      } catch (e) {
        result = `ERROR: ${e.message}`;
      }
      if (result && typeof result === 'object' && Array.isArray(result.images)) {
        pendingImages.push(...result.images);
        result = result.content ?? '';
      }
      const toolMsg = { role: 'tool', tool_call_id: call.id, content: String(result) };
      transcript.push(toolMsg);
      added.push(toolMsg);
    }
    if (pendingImages.length) {
      transcript.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Images returned by view_artifact, in order:' },
          ...pendingImages.flatMap((im) => [
            { type: 'text', text: im.label || 'image' },
            { type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } },
          ]),
        ],
      });
      added.push({ role: 'user', content: `[${pendingImages.length} artifact image(s) were shown to the model: ${pendingImages.map((im) => im.label).join('; ')}]` });
    }
  }
  // Hit the per-turn step ceiling. Don't dead-end — signal the client so it can
  // offer a Continue that resumes the loop with full context.
  onEvent?.({ type: 'truncated' });
  return { messages: added, final: '', truncated: true };
}
