// Roboburble's cloud providers: request shaping, transcript conversion,
// response parsing and where the user's key goes. Fetch is mocked; no network.
import test from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../../ui/src/assistant/providers.js');

const KEY = 'sk-test-SECRET-123';
const tools = [{ name: 'get_state', description: 'Read.', parameters: { type: 'object', properties: {} } }];
const anthropicRaw = [
  { type: 'thinking', thinking: 'hm', signature: 'sig' },
  { type: 'text', text: 'Raising.' },
  { type: 'tool_use', id: 'tu1', name: 'get_state', input: {} },
];
const transcriptA = [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: 'Raising.', raw: anthropicRaw, calls: [{ id: 'tu1', name: 'get_state', args: {} }] },
  { role: 'tool', results: [{ id: 'tu1', name: 'get_state', content: 'nope', isError: true }] },
];
const openaiRaw = { role: 'assistant', content: null, tool_calls: [
  { id: 'call_1', type: 'function', function: { name: 'get_state', arguments: '{}' } },
  { id: 'call_2', type: 'function', function: { name: 'get_state', arguments: '{}' } },
] };
const transcriptO = [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: '', raw: openaiRaw, calls: [] },
  { role: 'tool', results: [{ id: 'call_1', content: 'a' }, { id: 'call_2', content: 'b', isError: true }] },
];

const mockFetch = (status, body) => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
  return { seen, fetch };
};

test('1: Anthropic request — URL, headers, no sampling params, input_schema', () => {
  const { url, init } = P.anthropicRequest({ key: KEY, model: 'claude-haiku-5-5', system: 'S', transcript: [{ role: 'user', text: 'hi' }], tools });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(P.ANTHROPIC_URL, url);
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-version'], '2026-10-21');
  assert.equal(init.headers['x-api-key'], KEY);
  const body = JSON.parse(init.body);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), k);
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.system, 'S');
  assert.deepEqual(body.tools[0], { name: 'get_state', description: 'Read.', input_schema: tools[0].parameters });
});

test('2: Anthropic transcript — raw replayed untouched, one tool_result user turn', () => {
  const body = JSON.parse(P.anthropicRequest({ key: KEY, model: 'm', system: 'S', transcript: transcriptA, tools }).init.body);
  assert.deepEqual(body.messages[1], { role: 'assistant', content: anthropicRaw });
  assert.deepEqual(body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'nope', is_error: true }] });
  assert.equal(body.messages.length, 3);
});

test('3: parseAnthropic — text, tool_use calls, refusal, max_tokens', () => {
  const r = P.parseAnthropic({ content: anthropicRaw, stop_reason: 'tool_use' });
  assert.equal(r.text, 'Raising.');
  assert.deepEqual(r.calls, [{ id: 'tu1', name: 'get_state', args: {} }]);
  assert.equal(r.raw, anthropicRaw);
  assert.equal(P.parseAnthropic({ content: [], stop_reason: 'refusal' }).text, 'The model declined to answer.');
  assert.match(P.parseAnthropic({ content: [{ type: 'text', text: 'Long' }], stop_reason: 'max_tokens' }).text, /Long …\(cut off\)/);
});

test('4: chatAnthropic — one call, key only in x-api-key, 401 redacted', async () => {
  const ok = mockFetch(200, { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' });
  const r = await P.chatAnthropic({ fetch: ok.fetch, key: KEY, model: 'm', system: 'S', transcript: [{ role: 'user', text: 'hi' }], tools });
  assert.equal(r.text, 'Hi');
  assert.equal(ok.seen.length, 1);
  assert.equal(ok.seen[0].url, P.ANTHROPIC_URL);
  assert.ok(!ok.seen[0].url.includes(KEY) && !ok.seen[0].init.body.includes(KEY));
  const bad = mockFetch(401, { error: { message: `invalid x-api-key ${KEY}` } });
  await assert.rejects(P.chatAnthropic({ fetch: bad.fetch, key: KEY, model: 'm', system: 'S', transcript: [], tools }),
    (e) => /^Anthropic 401: /.test(e.message) && !e.message.includes(KEY));
  const down = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(P.chatAnthropic({ fetch: down, key: KEY, model: 'm', system: 'S', transcript: [], tools }), /Could not reach api\.anthropic\.com/);
});

test('5: OpenAI request — URL, Bearer, reasoning_effort none, tool_choice auto, system first', () => {
  const { url, init } = P.openaiRequest({ key: KEY, model: 'gpt-6-luna', system: 'S', transcript: [{ role: 'user', text: 'hi' }], tools });
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'S' });
  assert.ok(!('temperature' in body));
  assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'get_state', description: 'Read.', parameters: tools[0].parameters } });
});

test('6: OpenAI transcript — raw with tool_calls, one tool message per call id', () => {
  const body = JSON.parse(P.openaiRequest({ key: KEY, model: 'm', system: 'S', transcript: transcriptO, tools }).init.body);
  assert.deepEqual(body.messages[2], openaiRaw);
  assert.deepEqual(body.messages.slice(3), [
    { role: 'tool', tool_call_id: 'call_1', content: 'a' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Error: b' },
  ]);
});

test('7: parseOpenAI — arguments parsed, bad JSON is argsError, length cut off', () => {
  const r = P.parseOpenAI({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
    { id: 'a', function: { name: 'set_zone', arguments: '{"tier":2}' } },
    { id: 'b', function: { name: 'set_zone', arguments: '{tier' } },
  ] } }] });
  assert.deepEqual(r.calls[0], { id: 'a', name: 'set_zone', args: { tier: 2 } });
  assert.ok(r.calls[1].argsError);
  assert.equal(r.text, '');
  assert.match(P.parseOpenAI({ choices: [{ finish_reason: 'length', message: { content: 'Long' } }] }).text, /\(cut off\)/);
});

test('8: chatOpenAI — key only in Authorization; errors redacted', async () => {
  const ok = mockFetch(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }] });
  const r = await P.chatOpenAI({ fetch: ok.fetch, key: KEY, model: 'm', system: 'S', transcript: [{ role: 'user', text: 'hi' }], tools });
  assert.equal(r.text, 'Hi');
  assert.equal(ok.seen[0].url, P.OPENAI_URL);
  assert.ok(!ok.seen[0].init.body.includes(KEY));
  const bad = mockFetch(429, { error: { message: `quota for ${KEY}` } });
  await assert.rejects(P.chatOpenAI({ fetch: bad.fetch, key: KEY, model: 'm', system: 'S', transcript: [], tools }),
    (e) => /^OpenAI 429: /.test(e.message) && !e.message.includes(KEY));
});

test('9: an empty Claude reply is left out', () => {
  const transcript = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '', raw: [], calls: [] }, { role: 'user', text: 'again' }];
  const body = JSON.parse(P.anthropicRequest({ key: KEY, model: 'm', system: 'S', transcript, tools }).init.body);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'again' }] }]);
});

test('10: the state line is its own block on the user turn, never after tool results', () => {
  const transcript = [{ role: 'user', text: 'hi', now: 'Zone · Simulate' }, transcriptA[1],
    { role: 'tool', results: [{ id: 'tu1', name: 'get_state', content: 'ok' }] }];
  const body = JSON.parse(P.anthropicRequest({ key: KEY, model: 'm', system: 'S', transcript, tools }).init.body);
  assert.equal(body.system, 'S');
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }, { type: 'text', text: 'Now: Zone · Simulate' }]);
  assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]);
  const o = JSON.parse(P.openaiRequest({ key: KEY, model: 'm', system: 'S', transcript, tools }).init.body);
  assert.equal(o.messages[1].content, 'hi\n\nNow: Zone · Simulate');
});

test('11: fitCloudHistory cuts once per turn: over budget, earlier turns lose their thinking and the current loop keeps its own', () => {
  const step = (id, signature = 'sig') => [
    { role: 'assistant', text: '', calls: [{ id, name: 'get_state', args: {} }],
      raw: [{ type: 'thinking', thinking: 'hm', signature }, { type: 'tool_use', id, name: 'get_state', input: {} }] },
    { role: 'tool', results: [{ id, name: 'get_state', content: 'ok' }] },
  ];
  const done = { role: 'assistant', text: 'Done.', calls: [], raw: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'Done.' }] };
  const turn = (q, signature) => [{ role: 'user', text: q }, ...step(`${q}1`, signature), done];
  // Under budget: sent untouched, thinking included.
  const small = [...turn('a'), { role: 'user', text: 'b' }, ...step('b1')];
  assert.deepEqual(P.fitCloudHistory(small), small);
  // Over budget (turn a's signature alone is about 25k estimated tokens): turn b's requests, step by step. The last
  // step's tool result alone would push turn a out if the loop counted toward the cut.
  const head = [...turn('a', 'S'.repeat(75000)), { role: 'user', text: 'b' }];
  const big = step('b2');
  big[1].results[0].content = 'x'.repeat(80000);
  const loops = [[], step('b1'), [...step('b1'), ...big]];
  const requests = loops.map(loop => P.fitCloudHistory([...head, ...loop]));
  for (const [k, r] of requests.entries()) {
    // The loop exactly as the model made it, thinking kept; turn a kept without its thinking.
    assert.deepEqual(r.slice(5), loops[k]);
    assert.deepEqual(r.slice(0, 5).map(e => (Array.isArray(e.raw) ? e.raw.map(b => b.type) : e.role)),
      ['user', ['tool_use'], 'tool', ['text'], 'user']);
    // The cut never moves within a turn: each request extends the one before.
    if (k) assert.deepEqual(r.slice(0, requests[k - 1].length), requests[k - 1]);
  }
  const body = JSON.parse(P.anthropicRequest({ key: KEY, model: 'm', system: 'S', transcript: requests[2], tools }).init.body);
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(body.messages[7].content.map(b => b.type), ['thinking', 'tool_use']);
  const o = [{ role: 'user', text: 'x'.repeat(80000) }, { role: 'user', text: 'b' }, { role: 'assistant', text: '', raw: openaiRaw, calls: [] }];
  assert.equal(P.fitCloudHistory(o)[1].raw, openaiRaw);
});

test('11b: past the budget the rounds are fitted as sent, without thinking, so signatures push none out', () => {
  const sig = 'S'.repeat(30000); // about 10k estimated tokens of signature per reply
  const round = (q) => [{ role: 'user', text: q },
    { role: 'assistant', text: 'ok', raw: [{ type: 'thinking', thinking: '', signature: sig }, { type: 'text', text: 'ok' }], calls: [] }];
  const kept = P.fitCloudHistory([...round('a'), ...round('b'), ...round('c'), { role: 'user', text: 'd' }]);
  assert.deepEqual(kept.filter(e => e.role === 'user').map(e => e.text), ['a', 'b', 'c', 'd']);
  for (const e of kept) if (Array.isArray(e.raw)) assert.deepEqual(e.raw.map(b => b.type), ['text']);
});

test('12: a worker error rejects pending and later calls and reports the death once', { timeout: 2000 }, async () => {
  const { createLocalClient } = await import('../../ui/src/assistant/localLlm.js');
  const workers = [];
  const posted = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(m) { posted.push(m); }
    terminate() { this.terminated = true; }
  };
  try {
    const deaths = [];
    const c = createLocalClient(e => deaths.push(e.message));
    const pending = c.cached('m');
    workers[0].onerror({ message: 'boom' });
    await assert.rejects(pending, /boom/);
    await assert.rejects(c.load('m'), /boom/);
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(deaths, ['boom']);
    assert.equal(posted.length, 1);
  } finally {
    delete globalThis.Worker;
  }
});
