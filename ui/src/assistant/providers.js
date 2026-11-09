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
// Within a turn requests only append: the system prompt never changes, the state
// line rides on the user turn, and fitCloudHistory cuts once per turn, so the tool
// loop's thinking blocks stay valid.
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

const withoutThinking = (e) => (Array.isArray(e.raw)
  ? { ...e, raw: e.raw.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : e);

/**
 * The cloud history, cut once per turn. Claude binds each thinking block to everything sent before
 * it, and a tool loop must send its own blocks back, so the cut is decided on the history up to this
 * turn's user entry, which the loop never changes. If that fits the budget, everything is sent as is.
 * If not: its newest whole rounds that fit, fitted as sent, without thinking (removing all of it is
 * allowed, and none comes back: the transcript only grows), then this turn's loop untouched.
 */
export function fitCloudHistory(transcript) {
  const at = transcript.findLastIndex(e => e.role === 'user') + 1;
  const head = transcript.slice(0, at);
  if (fitHistory(head, BUDGET.cloudHistory).length === head.length) return transcript;
  // shortcut: past the budget earlier turns replay no thinking (Claude re-plans from their text); move to server-side compaction if long chats get slow or costly.
  return [...fitHistory(head.map(withoutThinking), BUDGET.cloudHistory), ...transcript.slice(at)];
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
