// Roboburble's prompt protocol for local models: the tool-call parser, the
// system prompt, local message shaping and history budgeting.
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildSystemPrompt, parseToolCalls, toLocalMessages, estimateTokens, fitHistory } =
  await import('../../ui/src/assistant/protocol.js');
const { toolSpecs } = await import('../../ui/src/assistant/tools.js');

const NAMES = ['adjust_enhancement', 'get_state', 'set_zone'];

test('1: one <tool_call> block gives a call plus prose', () => {
  const r = parseToolCalls('Sure.\n<tool_call>\n{"name": "adjust_enhancement", "arguments": {"delta": 1}}\n</tool_call>', NAMES);
  assert.deepEqual(r.calls, [{ id: 'c0', name: 'adjust_enhancement', args: { delta: 1 } }]);
  assert.equal(r.text, 'Sure.');
  assert.deepEqual(r.errors, []);
});

test('2: two blocks give two calls in order', () => {
  const r = parseToolCalls('<tool_call>{"name":"set_zone","arguments":{"tier":3}}</tool_call>\n<tool_call>{"name":"get_state","arguments":{}}</tool_call>', NAMES);
  assert.deepEqual(r.calls.map(c => [c.id, c.name]), [['c0', 'set_zone'], ['c1', 'get_state']]);
});

test('3: an unterminated final block is parsed if its JSON is complete', () => {
  const r = parseToolCalls('<tool_call>\n{"name":"get_state","arguments":{}}', NAMES);
  assert.equal(r.calls.length, 1);
});

test('4: malformed JSON in tags is skipped and recorded; prose kept', () => {
  const r = parseToolCalls('Trying.<tool_call>{"name": "get_state", </tool_call>', NAMES);
  assert.equal(r.calls.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.text, 'Trying.');
});

test('5: a json fence with a call is a call; other JSON stays text', () => {
  const r = parseToolCalls('```json\n{"name":"get_state","arguments":{}}\n```', NAMES);
  assert.equal(r.calls[0].name, 'get_state');
  const t = '```json\n{"tier": 3}\n```';
  const plain = parseToolCalls(t, NAMES);
  assert.equal(plain.calls.length, 0);
  assert.equal(plain.text, t);
});

test('6: a bare Llama-style object after <|python_tag|> is a call', () => {
  const r = parseToolCalls('<|python_tag|>{"name": "set_zone", "parameters": {"tier": 2}}', NAMES);
  assert.deepEqual(r.calls, [{ id: 'c0', name: 'set_zone', args: { tier: 2 } }]);
  assert.equal(r.text, '');
});

test('7: string-encoded arguments are parsed; non-JSON is an error and no call', () => {
  const ok = parseToolCalls('<tool_call>{"name":"set_zone","arguments":"{\\"tier\\":1}"}</tool_call>', NAMES);
  assert.deepEqual(ok.calls[0].args, { tier: 1 });
  const bad = parseToolCalls('<tool_call>{"name":"set_zone","arguments":"tier one"}</tool_call>', NAMES);
  assert.equal(bad.calls.length, 0);
  assert.equal(bad.errors.length, 1);
});

test('8: text only — no calls, text unchanged', () => {
  const r = parseToolCalls('Your gear is already +20.', NAMES);
  assert.deepEqual(r, { text: 'Your gear is already +20.', calls: [], errors: [] });
});

test('9: an unknown tool name is an error, not a call', () => {
  const r = parseToolCalls('<tool_call>{"name":"launch","arguments":{}}</tool_call>', NAMES);
  assert.equal(r.calls.length, 0);
  assert.match(r.errors[0], /launch/);
});

test('10: the prompt protocol lists one JSON line per tool and fits the budget', () => {
  const tools = toolSpecs();
  const s = buildSystemPrompt({ tools, protocol: 'prompt' });
  const block = s.split('<tools>\n')[1].split('\n</tools>')[0].split('\n');
  assert.equal(block.length, tools.length);
  for (const line of block) assert.equal(JSON.parse(line).type, 'function');
  assert.match(s, /<tool_call>\n\{"name": <function-name>, "arguments": <args-json-object>\}\n<\/tool_call>/);
  assert.doesNotMatch(s, /Now: Zone|undefined/, 'no per-turn state in the system prompt');
  assert.ok(s.length <= 4200, `system prompt is ${s.length} chars`);
});

test('11: the native protocol has no <tools> block', () => {
  const s = buildSystemPrompt({ tools: toolSpecs(), protocol: 'native' });
  assert.ok(!s.includes('<tools>'));
  assert.match(s, /Roboburble/);
});

test('12: toLocalMessages — system first, tool round as one user turn, ends on user', () => {
  const transcript = [
    { role: 'user', text: 'raise my gear' },
    { role: 'assistant', text: '', raw: '<tool_call>{"name":"adjust_enhancement"}</tool_call>', calls: [{}] },
    { role: 'tool', results: [{ id: 'c0', content: 'ok' }, { id: 'c1', content: 'bad', isError: true }] },
    { role: 'assistant', text: 'Done.', raw: 'Done.', calls: [] },
    { role: 'user', text: 'thanks' },
    { role: 'user', text: 'and again' },
  ];
  const m = toLocalMessages('SYS', transcript);
  assert.equal(m[0].role, 'system');
  assert.equal(m.filter(x => x.role === 'system').length, 1);
  assert.equal(m[2].role, 'assistant');
  assert.equal(m[2].content, transcript[1].raw);
  assert.equal(m[3].role, 'user');
  assert.equal(m[3].content.match(/<tool_response>/g).length, 2);
  assert.match(m[3].content, /Error: bad/);
  assert.equal(m.at(-1).role, 'user');
  assert.equal(m.at(-1).content, 'thanks\n\nand again');
  for (let i = 1; i < m.length; i++) assert.ok(!(m[i].role === 'user' && m[i - 1].role === 'user'));
});

test('13: fitHistory drops whole oldest rounds and keeps the newest', () => {
  const round = (n, size) => [
    { role: 'user', text: `q${n}`.padEnd(size, '.') },
    { role: 'assistant', text: '', raw: 'call', calls: [{}] },
    { role: 'tool', results: [{ id: 'c0', content: 'r'.repeat(size) }] },
    { role: 'assistant', text: 'a', raw: 'a', calls: [] },
  ];
  const t = [...round(1, 300), ...round(2, 300), ...round(3, 300)];
  const cost = (xs) => xs.reduce((a, e) => a + estimateTokens(JSON.stringify(e)), 0);
  const kept = fitHistory(t, cost(round(3, 300)) + cost(round(2, 300)) + 5);
  assert.equal(kept[0].text.slice(0, 2), 'q2');
  assert.equal(kept.length, 8);
  const tiny = fitHistory(t, 1);
  assert.deepEqual(tiny, round(3, 300), 'the newest round always survives');
  assert.equal(estimateTokens('abcdef'), 2);
});

test('14: the state line rides on its user turn, so a later step only appends', () => {
  const sys = buildSystemPrompt({ tools: toolSpecs(), protocol: 'prompt' });
  const u = { role: 'user', text: 'raise my gear', now: 'Zone · Simulate · Smelly Planet T0 · 24 h · open P1 Ada (tank)' };
  const step1 = toLocalMessages(sys, [u]);
  const step2 = toLocalMessages(sys, [u,
    { role: 'assistant', text: '', raw: '<tool_call>{"name":"get_state","arguments":{}}</tool_call>', calls: [{}] },
    { role: 'tool', results: [{ id: 'c0', content: 'ok' }] }]);
  assert.equal(step1[1].content, `raise my gear\n\nNow: ${u.now}`);
  assert.deepEqual(step2.slice(0, step1.length), step1);
  assert.ok(!sys.includes('open P1'));
});
