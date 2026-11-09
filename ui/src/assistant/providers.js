// =============================================================================
// providers — Anthropic Messages and OpenAI Chat Completions with the user's
// own key, by plain fetch from the browser.
//
// Anthropic: version 2026-10-21 rejects temperature/top_p/top_k with a 400, so
// none is ever sent; browsers need anthropic-dangerous-direct-browser-access.
// OpenAI (gpt-6-luna): Chat Completions function calling needs
// reasoning_effort "none".
// The key goes only in its header; errors are redacted; nothing is logged.
// `fetch` is injected and called unbound (the hook passes fetch.bind(globalThis)).
// Requests only append: the system prompt never changes and the state line rides
// on the user turn, so Claude's thinking blocks stay valid (fitCloudHistory is the
// one exception).
// Pure: no React, no browser globals.
// =============================================================================

import { BUDGET, fitHistory } from './protocol.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const CUT = ' …(cut off)';

// -- Anthropic ----------------------------------------------------------------

function anthropicMessages(transcript) {
  const out = [];
  const push = (role, content) => {
    const last = out[out.length - 1];
    const blocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
    if (last?.role === role && role === 'user') last.content = [...blocks(last.content), ...blocks(content)];
    else out.push({ role, content });
  };
  for (const e of transcript) {
    // The turn's state line is its own block, apart from the user's words (and never after tool results).
    if (e.role === 'user') push('user', e.now ? [{ type: 'text', text: e.text }, { type: 'text', text: `Now: ${e.now}` }] : e.text);
    // The full content array, thinking and tool_use blocks included, untouched. An empty reply is left
    // out: the API rejects empty assistant content, and sending one back only invites another.
    else if (e.role === 'assistant') { const c = e.raw ?? e.text; if (c?.length) push('assistant', c); }
    else if (e.role === 'tool') {
      push('user', e.results.map(r => ({
        type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}),
      })));
    }
  }
  return out;
}

export function anthropicRequest({ key, model, system, transcript, tools }) {
  return {
    url: ANTHROPIC_URL,
    init: {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2026-10-21',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000, // thinking counts toward it (Claude Haiku 5.5 thinks by default)
        system,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: anthropicMessages(transcript),
      }),
    },
  };
}

export function parseAnthropic(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  let text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  const calls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input ?? {} }));
  if (json?.stop_reason === 'refusal') text = 'The model declined to answer.';
  else if (json?.stop_reason === 'max_tokens') text += CUT;
  return { text, calls, raw: content };
}

// -- OpenAI -------------------------------------------------------------------

function openaiMessages(system, transcript) {
  const out = [{ role: 'system', content: system }];
  for (const e of transcript) {
    if (e.role === 'user') out.push({ role: 'user', content: e.now ? `${e.text}\n\nNow: ${e.now}` : e.text });
    // The message as returned, tool_calls included.
    else if (e.role === 'assistant') out.push(e.raw ?? { role: 'assistant', content: e.text || '' });
    else if (e.role === 'tool') {
      for (const r of e.results) out.push({ role: 'tool', tool_call_id: r.id, content: `${r.isError ? 'Error: ' : ''}${r.content}` });
    }
  }
  return out;
}

export function openaiRequest({ key, model, system, transcript, tools }) {
  return {
    url: OPENAI_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        reasoning_effort: 'none',
        messages: openaiMessages(system, transcript),
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
      }),
    },
  };
}

export function parseOpenAI(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || { role: 'assistant', content: '' };
  const calls = (message.tool_calls || []).map(c => {
    const call = { id: c.id, name: c.function?.name };
    try {
      call.args = JSON.parse(c.function?.arguments || '{}');
    } catch (e) {
      call.args = {};
      call.argsError = e.message;
    }
    return call;
  });
  let text = message.content || '';
  if (choice.finish_reason === 'length') text += CUT;
  return { text, calls, raw: message };
}

// -- history ------------------------------------------------------------------

/**
 * The cloud history: the newest whole rounds within budget. Claude binds each thinking block to
 * everything sent before it, so once older rounds are dropped no thinking block is replayed
 * (dropping all of them is allowed; changing the history before them is not).
 */
export function fitCloudHistory(transcript) {
  const kept = fitHistory(transcript, BUDGET.cloudHistory);
  if (kept.length === transcript.length) return kept;
  // shortcut: past the budget every request replays no thinking (Claude re-plans each step); move to server-side compaction if long chats get slow or costly.
  return kept.map(e => (Array.isArray(e.raw)
    ? { ...e, raw: e.raw.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : e));
}

// -- the call -----------------------------------------------------------------

async function send({ fetch, key, signal }, provider, host, { url, init }) {
  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Could not reach ${host}`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) {
    const message = String(json?.error?.message || res.statusText || 'request failed');
    throw new Error(`${provider} ${res.status}: ${key ? message.replaceAll(key, '…') : message}`);
  }
  return json;
}

export async function chatAnthropic({ fetch, key, model, system, transcript, tools, signal }) {
  const json = await send({ fetch, key, signal }, 'Anthropic', 'api.anthropic.com', anthropicRequest({ key, model, system, transcript, tools }));
  return parseAnthropic(json);
}

export async function chatOpenAI({ fetch, key, model, system, transcript, tools, signal }) {
  const json = await send({ fetch, key, signal }, 'OpenAI', 'api.openai.com', openaiRequest({ key, model, system, transcript, tools }));
  return parseOpenAI(json);
}
