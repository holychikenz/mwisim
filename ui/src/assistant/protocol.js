// =============================================================================
// protocol — the system prompt, the tool-call parser for local models, and
// history budgeting.
//
// Local WebLLM models other than Hermes cannot take `tools` (web-llm throws
// UnsupportedModelIdError), and Qwen2.5 has no `tool` role. So every local tier
// gets Qwen2.5's own tool template inside the system prompt, emits
// <tool_call>…</tool_call>, and reads results back as a user turn of
// <tool_response> blocks — exactly what Qwen's chat template does. Cloud
// providers get the same system text and native tools.
// Pure: no React, no browser globals.
// =============================================================================

/** Token budgets. Estimates are deliberately pessimistic (chars / 3). */
export const BUDGET = { system: 1400, localHistory: 2200, cloudHistory: 24000, generation: 384, toolResult: 1600 };

export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 3);

const SYSTEM = `You are Roboburble, the assistant in the Milky Way Idle combat simulator. You change the user's setup with the tools and reply in one or two short sentences.
- player is a party slot 1-5 (in Trial: a roster row) or a character name; leave it out for the open one.
- Use item, zone and ability names as get_state shows them. Never invent names.
- Changes apply at once and the user can undo them; do not ask for confirmation.
- Call run_simulation only when the user asks to run or sim.`;

/** @param {{tools: {name, description, parameters}[], now: string, protocol: 'prompt'|'native'}} o */
export function buildSystemPrompt({ tools, now, protocol }) {
  const head = `${SYSTEM}\nNow: ${now}`;
  if (protocol !== 'prompt') return head;
  const lines = tools.map(t => JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return `${head}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${lines.join('\n')}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>`;
}

const TAG = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Tool calls in a local model's reply. Accepts, in order: <tool_call> blocks
 * (a missing close tag at the very end is tolerated); else ```json fences that
 * hold a "name"; else the whole message as one object or array, after an
 * optional <|python_tag|> (Llama style, `parameters` for `arguments`).
 * @returns {{text: string, calls: {id, name, args}[], errors: string[]}}
 */
export function parseToolCalls(text, names) {
  const known = new Set(names);
  const source = String(text ?? '');
  let prose = source;
  let candidates = [];
  let strict = true;   // inside tags, unreadable JSON is an error; elsewhere it is just text
  if (source.includes('<tool_call>')) {
    candidates = [...source.matchAll(TAG)].map(m => m[1]);
    prose = source.replace(TAG, '');
  } else {
    const fences = [...source.matchAll(FENCE)].filter(m => /"name"\s*:/.test(m[1]));
    if (fences.length) {
      candidates = fences.map(m => m[1]);
      for (const m of fences) prose = prose.replace(m[0], '');
    } else {
      const bare = source.replace('<|python_tag|>', '').trim();
      if (/^[[{][\s\S]*[\]}]$/.test(bare)) { candidates = [bare]; prose = ''; strict = false; }
    }
  }
  const calls = [];
  const errors = [];
  let attempts = 0;
  for (const raw of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      if (strict) errors.push(`invalid JSON: ${raw.trim().slice(0, 60)}`);
      continue;
    }
    for (const obj of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!obj || typeof obj.name !== 'string') continue;
      attempts++;
      if (!known.has(obj.name)) { errors.push(`unknown tool '${obj.name}'`); continue; }
      let args = obj.arguments ?? obj.parameters ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { errors.push(`arguments for ${obj.name} are not JSON`); continue; }
      }
      calls.push({ id: `c${calls.length}`, name: obj.name, args });
    }
  }
  // A bare message that held no call attempt was just text.
  if (!strict && !attempts) return { text: source, calls: [], errors: [] };
  return { text: prose.trim(), calls, errors };
}

const toolResponses = (results) =>
  results.map(r => `<tool_response>\n${r.isError ? 'Error: ' : ''}${r.content}\n</tool_response>`).join('\n');

/**
 * The transcript as web-llm messages: system only at index 0, an assistant turn
 * as the exact text the model generated, a tool round as ONE user turn of
 * <tool_response> blocks, consecutive user turns merged, ending on user.
 */
export function toLocalMessages(system, transcript) {
  const out = [{ role: 'system', content: system }];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (role === 'user' && last.role === 'user') last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const e of transcript) {
    if (e.role === 'user') push('user', e.text);
    else if (e.role === 'assistant') push('assistant', typeof e.raw === 'string' ? e.raw : e.text || '');
    else if (e.role === 'tool') push('user', toolResponses(e.results));
  }
  while (out.length > 1 && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

const entryTokens = (e) => estimateTokens(JSON.stringify(e));

/**
 * The newest whole rounds (a round starts at a user turn) that fit `budget`
 * estimated tokens. The newest round is always kept; a tool round is never split.
 */
export function fitHistory(transcript, budget) {
  const rounds = [];
  for (const e of transcript) {
    if (e.role === 'user' || !rounds.length) rounds.push([]);
    rounds[rounds.length - 1].push(e);
  }
  const kept = [];
  let used = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const cost = rounds[i].reduce((a, e) => a + entryTokens(e), 0);
    if (kept.length && used + cost > budget) break;
    kept.unshift(rounds[i]);
    used += cost;
  }
  return kept.flat();
}
