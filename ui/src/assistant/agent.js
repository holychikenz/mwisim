// =============================================================================
// agent — the bounded tool loop. The LLM and the tool executor are injected:
//   llm.chat({transcript, tools, now, signal}) → {text, calls, raw, parseErrors?}
//   execute(call) → {id, name, content, isError?}
// Transcript entries: {role:'user', text} | {role:'assistant', text, calls, raw}
// | {role:'tool', results}. The caller keeps the returned transcript only when
// a turn completes; a stopped turn runs no further tools and is not remembered.
// Pure: no React, no browser globals.
// =============================================================================

export async function runAgent({ llm, execute, transcript, tools, now, signal, onEvent = () => {}, maxSteps = 4, maxCalls = 5 }) {
  const t = [...transcript];
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { stopped: true };
    let reply;
    try {
      reply = await llm.chat({ transcript: t, tools, now: typeof now === 'function' ? now() : now, signal });
    } catch (error) {
      return signal?.aborted ? { stopped: true } : { error };
    }
    if (signal?.aborted) return { stopped: true };
    t.push({ role: 'assistant', text: reply.text, calls: reply.calls, raw: reply.raw });
    if (!reply.calls.length) {
      if (reply.parseErrors?.length && step < maxSteps - 1) {
        t.push({ role: 'tool', results: [{ id: 'parse', name: 'parse', isError: true,
          content: `Your tool call could not be read (${reply.parseErrors[0]}). Use <tool_call>{"name": …, "arguments": {…}}</tool_call>.` }] });
        continue;
      }
      return { transcript: t, text: reply.text };
    }
    if (reply.text) onEvent({ type: 'text', text: reply.text });
    const results = [];
    for (const [i, call] of reply.calls.entries()) {
      results.push(i < maxCalls ? await execute(call)
        : { id: call.id, name: call.name, isError: true, content: `Skipped: at most ${maxCalls} calls per reply.` });
    }
    // Every call id is answered (OpenAI and Anthropic require it).
    t.push({ role: 'tool', results });
  }
  return { transcript: t, text: `I stopped after ${maxSteps} rounds of tool calls.`, limit: true };
}
