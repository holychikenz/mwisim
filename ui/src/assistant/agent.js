// =============================================================================
// agent — the bounded tool loop. The LLM and the tool executor are injected:
//   llm.chat({transcript, tools, signal}) → {text, calls, raw, parseErrors?}
//   execute(call) → {id, name, content, isError?}
// Transcript entries: {role:'user', text, now?} | {role:'assistant', text, calls, raw}
// | {role:'tool', results}. `now` (the state line) is stamped once on the turn's
// user entry, so every request only appends to the last. The caller keeps the
// returned transcript only when a turn completes; a stopped turn runs no further
// tools and is not remembered.
// Pure: no React, no browser globals.
// =============================================================================

const parseError = (errors) => ({ id: 'parse', name: 'parse', isError: true,
  content: `Your tool call could not be read (${errors.join('; ')}). Use <tool_call>{"name": …, "arguments": {…}}</tool_call>.` });

// A tool whose commit or run throws is reported like any failed call, so the turn goes on.
async function attempt(execute, call) {
  try { return await execute(call); }
  catch (e) { return { id: call.id, name: call.name, isError: true, content: `${call.name} failed: ${e?.message || e}` }; }
}

export async function runAgent({ llm, execute, transcript, tools, now, signal, onEvent = () => {}, maxSteps = 4, maxCalls = 5 }) {
  const t = [...transcript];
  // The state line rides on this turn's user entry, never the system prompt, so each request only
  // appends: web-llm reuses its KV cache and Claude's thinking blocks stay valid.
  if (now != null && t.length) t[t.length - 1] = { ...t[t.length - 1], now: typeof now === 'function' ? now() : now };
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { stopped: true };
    let reply;
    try {
      reply = await llm.chat({ transcript: t, tools, signal });
    } catch (error) {
      return signal?.aborted ? { stopped: true } : { error };
    }
    if (signal?.aborted) return { stopped: true };
    t.push({ role: 'assistant', text: reply.text, calls: reply.calls, raw: reply.raw });
    if (!reply.calls.length) {
      if (reply.parseErrors?.length && step < maxSteps - 1) {
        t.push({ role: 'tool', results: [parseError(reply.parseErrors)] });
        continue;
      }
      return { transcript: t, text: reply.text };
    }
    if (reply.text) onEvent({ type: 'text', text: reply.text });
    const results = [];
    for (const [i, call] of reply.calls.entries()) {
      results.push(i < maxCalls ? await attempt(execute, call)
        : { id: call.id, name: call.name, isError: true, content: `Skipped: at most ${maxCalls} calls per reply.` });
    }
    // A reply can mix readable and unreadable calls; the unreadable ones are reported beside the results.
    if (reply.parseErrors?.length) results.push(parseError(reply.parseErrors));
    // Every call id is answered (OpenAI and Anthropic require it).
    t.push({ role: 'tool', results });
  }
  return { transcript: t, text: `I stopped after ${maxSteps} rounds of tool calls.`, limit: true };
}
