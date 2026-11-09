// Roboburble's bounded tool loop, with a scripted fake LLM.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runAgent } = await import('../../ui/src/assistant/agent.js');

const call = (id, name, args = {}) => ({ id, name, args });
function scripted(replies) {
  const seen = [];
  return {
    seen,
    chat: async ({ transcript }) => {
      seen.push(transcript.map(e => e.role));
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { text: '', calls: [], raw: 'raw', ...r };
    },
  };
}
const executor = (fn = (c) => ({ id: c.id, name: c.name, content: `ok ${c.name}` })) => {
  const calls = [];
  return { calls, execute: async (c) => { calls.push(c); return fn(c); } };
};
const user = [{ role: 'user', text: 'hi' }];

test('1: call → result → final answer', async () => {
  const llm = scripted([{ calls: [call('c0', 'adjust_enhancement', { delta: 1 })] }, { text: 'Done.' }]);
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.text, 'Done.');
  assert.deepEqual(r.transcript.map(e => e.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(ex.calls[0].args, { delta: 1 });
});

test('2: two calls in one reply run in order into one tool message', async () => {
  const llm = scripted([{ calls: [call('a', 'set_zone'), call('b', 'run_simulation')] }, { text: 'ok' }]);
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.deepEqual(ex.calls.map(c => c.name), ['set_zone', 'run_simulation']);
  assert.deepEqual(r.transcript[2].results.map(x => x.id), ['a', 'b']);
});

test('3: a tool error is fed back and the next reply returned', async () => {
  const llm = scripted([{ calls: [call('a', 'set_zone')] }, { text: 'That zone does not exist.' }]);
  const ex = executor((c) => ({ id: c.id, name: c.name, isError: true, content: 'Unknown zone' }));
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.transcript[2].results[0].isError, true);
  assert.equal(r.text, 'That zone does not exist.');
});

test('4: stops after maxSteps rounds of tool calls', async () => {
  const llm = { chat: async () => ({ text: '', calls: [call('x', 'get_state')], raw: 'r' }) };
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.limit, true);
  assert.equal(ex.calls.length, 4);
});

test('5: abort after the first reply — nothing executed, input untouched', async () => {
  const ac = new AbortController();
  const llm = { chat: async () => { ac.abort(); return { text: '', calls: [call('x', 'set_zone')], raw: 'r' }; } };
  const ex = executor();
  const transcript = [...user];
  const r = await runAgent({ llm, execute: ex.execute, transcript, signal: ac.signal });
  assert.deepEqual(r, { stopped: true });
  assert.equal(ex.calls.length, 0);
  assert.equal(transcript.length, 1);
});

test('6: parse errors with no calls are fed back once', async () => {
  const llm = scripted([{ text: '<tool_call>{bad', parseErrors: ['invalid JSON'] }, { text: 'Sorry, done.' }]);
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.text, 'Sorry, done.');
  assert.equal(r.transcript[2].results[0].isError, true);
  assert.match(r.transcript[2].results[0].content, /could not be read/);
});

test('7: an LLM failure returns {error} with nothing executed', async () => {
  const llm = scripted([new Error('boom')]);
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.error.message, 'boom');
  assert.equal(ex.calls.length, 0);
});

test('8: a tool that throws is reported as a failed call and the turn goes on', async () => {
  const llm = scripted([{ calls: [call('a', 'run_simulation'), call('b', 'get_state')] }, { text: 'Could not start.' }]);
  const ex = executor((c) => {
    if (c.name === 'run_simulation') throw new Error('flushSync boom');
    return { id: c.id, name: c.name, content: 'ok' };
  });
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  assert.equal(r.text, 'Could not start.');
  assert.deepEqual(r.transcript[2].results.map(x => [x.id, !!x.isError]), [['a', true], ['b', false]]);
  assert.match(r.transcript[2].results[0].content, /run_simulation failed: flushSync boom/);
});

test('9: parse errors beside readable calls are reported with the results', async () => {
  const llm = scripted([{ calls: [call('c0', 'get_state')], parseErrors: ["unknown tool 'launch'"] }, { text: 'ok' }]);
  const ex = executor();
  const r = await runAgent({ llm, execute: ex.execute, transcript: user });
  const results = r.transcript[2].results;
  assert.deepEqual(results.map(x => x.id), ['c0', 'parse']);
  assert.equal(results[1].isError, true);
  assert.match(results[1].content, /launch/);
});

test('10: the state line is stamped once on the user turn, never passed to the LLM', async () => {
  const args = [];
  const replies = [{ text: '', calls: [call('a', 'get_state')], raw: 'r' }, { text: 'Done.', calls: [], raw: 'r' }];
  const llm = { chat: async (a) => { args.push(a); return replies.shift(); } };
  let n = 0;
  const transcript = [{ role: 'user', text: 'hi' }];
  const r = await runAgent({ llm, execute: executor().execute, transcript, now: () => `S${++n}` });
  assert.equal(n, 1);
  assert.equal(r.transcript[0].now, 'S1');
  assert.equal(transcript[0].now, undefined);
  assert.equal(args.length, 2);
  for (const a of args) assert.ok(!('now' in a));
});

test('11: a turn that fails or is stopped after a tool round keeps that round; with none, nothing', async () => {
  const failed = await runAgent({ llm: scripted([{ calls: [call('a', 'adjust_enhancement', { delta: 2 })] }, new Error('overloaded')]),
    execute: executor().execute, transcript: user });
  assert.equal(failed.error.message, 'overloaded');
  assert.deepEqual(failed.transcript.map(e => e.role), ['user', 'assistant', 'tool']);
  const ac = new AbortController();
  const stopped = await runAgent({ llm: scripted([{ calls: [call('a', 'set_zone')] }, { text: 'never asked' }]),
    execute: executor((c) => { ac.abort(); return { id: c.id, name: c.name, content: 'ok' }; }).execute, transcript: user, signal: ac.signal });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.transcript.map(e => e.role), ['user', 'assistant', 'tool']);
  assert.equal((await runAgent({ llm: scripted([new Error('down')]), execute: executor().execute, transcript: user })).transcript, undefined);
});

test('12: after a provider 4xx the turn keeps a note of what its tools did, never the rounds the provider may have rejected', async () => {
  const rejected = Object.assign(new Error('Anthropic 400: messages.2: invalid tool_result'), { status: 400 });
  const ex = executor((c) => (c.name === 'get_state' ? { id: c.id, name: c.name, isError: true, content: 'nope' }
    : { id: c.id, name: c.name, content: 'P1 Ann (default) loadout: 8 item(s) +2.' }));
  const r = await runAgent({ llm: scripted([{ calls: [call('a', 'adjust_enhancement', { delta: 2 }), call('b', 'get_state')] }, rejected]),
    execute: ex.execute, transcript: user });
  assert.equal(r.error, rejected);
  assert.deepEqual(r.transcript.map(e => e.role), ['user', 'assistant']);
  assert.equal(r.transcript[1].raw, undefined);
  assert.match(r.transcript[1].text, /adjust_enhancement: P1 Ann \(default\) loadout: 8 item\(s\) \+2\./);
  assert.doesNotMatch(r.transcript[1].text, /get_state/); // a failed call changed nothing
  // Nothing ran: nothing to keep. A 5xx is not the history's fault: its rounds are kept as they are (as in 11).
  const failedOnly = executor((c) => ({ id: c.id, name: c.name, isError: true, content: 'no' }));
  assert.equal((await runAgent({ llm: scripted([{ calls: [call('a', 'set_zone')] }, rejected]), execute: failedOnly.execute, transcript: user })).transcript, undefined);
  const overloaded = Object.assign(new Error('Anthropic 529: Overloaded'), { status: 529 });
  const kept = await runAgent({ llm: scripted([{ calls: [call('a', 'set_zone')] }, overloaded]), execute: executor().execute, transcript: user });
  assert.deepEqual(kept.transcript.map(e => e.role), ['user', 'assistant', 'tool']);
  // A rate limit is not the history's fault either.
  const limited = Object.assign(new Error('Anthropic 429: rate_limit_error'), { status: 429 });
  const kept429 = await runAgent({ llm: scripted([{ calls: [call('a', 'set_zone')] }, limited]), execute: executor().execute, transcript: user });
  assert.deepEqual(kept429.transcript.map(e => e.role), ['user', 'assistant', 'tool']);
});

test('13: a stop between two calls of one reply runs neither the rest nor another request; every call id is answered', async () => {
  const ac = new AbortController();
  const llm = scripted([{ calls: [call('a', 'set_zone'), call('b', 'run_simulation')] }, { text: 'never asked' }]);
  const ex = executor((c) => { ac.abort(); return { id: c.id, name: c.name, content: 'ok' }; });
  const r = await runAgent({ llm, execute: ex.execute, transcript: user, signal: ac.signal });
  assert.equal(r.stopped, true);
  assert.deepEqual(ex.calls.map(c => c.name), ['set_zone']);
  assert.deepEqual(r.transcript[2].results.map(x => [x.id, !!x.isError, x.content]), [['a', false, 'ok'], ['b', true, 'Skipped: stopped.']]);
  assert.equal(llm.seen.length, 1);
  // In the last round too: a stop, not the round limit.
  const ac2 = new AbortController();
  const last = await runAgent({ llm: scripted([{ calls: [call('a', 'set_zone')] }]), maxSteps: 1, signal: ac2.signal, transcript: user,
    execute: executor((c) => { ac2.abort(); return { id: c.id, name: c.name, content: 'ok' }; }).execute });
  assert.equal(last.stopped, true);
  assert.equal(last.limit, undefined);
});
