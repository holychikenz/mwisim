// The header shows App's (simMode, optTarget) as a target over a row of tools.
// React has no test harness here, so the mapping is pure and tested on its own.
import test from 'node:test';
import assert from 'node:assert/strict';

const { OPT_TARGETS, TARGETS, TOOLS, supports, toRoute, fromRoute } =
  await import('../../ui/src/utils/optimizerTarget.js');

const route = (target, tool, costs = false) => ({ target, tool, costs });

test('toRoute: simulation modes are targets, optimisers carry optTarget, Costs selects nothing', () => {
  assert.deepEqual(toRoute('zone', 'labyrinth'), route('zone', 'simulate'));
  assert.deepEqual(toRoute('labyrinth', 'zone'), route('labyrinth', 'simulate'));
  assert.deepEqual(toRoute('guildTrial', 'labyrinth'), route('guildTrial', 'simulate'));
  assert.deepEqual(toRoute('equipOpt', 'labyrinth'), route('labyrinth', 'equipOpt'));
  assert.deepEqual(toRoute('triggerOpt', 'zone'), route('zone', 'triggerOpt'));
  assert.deepEqual(toRoute('itemCosts', 'labyrinth'), route(null, null, true));
});

test('toRoute: garbage never throws and reads as Zone · Simulate', () => {
  for (const mode of [undefined, null, '', 'bogus', 'simulate', 42, {}, [], 'constructor']) {
    assert.deepEqual(toRoute(mode, 'labyrinth'), route('zone', 'simulate'), String(mode));
  }
  assert.deepEqual(toRoute('triggerOpt', 'guildTrial'), route('zone', 'triggerOpt'));
  assert.deepEqual(toRoute('equipOpt', undefined), route('zone', 'equipOpt'));
});

test('fromRoute: a target keeps an optimiser that suits it, otherwise falls back to Simulate', () => {
  // Zone · Gear, pick Lab: still Gear, re-aimed.
  assert.deepEqual(fromRoute('labyrinth', 'equipOpt', 'zone'), { simMode: 'equipOpt', optTarget: 'labyrinth' });
  // Lab · Triggers, pick Trial: no optimiser fights a trial.
  assert.deepEqual(fromRoute('guildTrial', 'triggerOpt', 'labyrinth'), { simMode: 'guildTrial', optTarget: 'labyrinth' });
  // From Costs no tool is selected, so a target lands on Simulate.
  assert.deepEqual(fromRoute('labyrinth', null, 'zone'), { simMode: 'labyrinth', optTarget: 'zone' });
});

test('fromRoute: a tool takes the current target; Simulate leaves optTarget alone', () => {
  assert.deepEqual(fromRoute('labyrinth', 'triggerOpt', 'zone'), { simMode: 'triggerOpt', optTarget: 'labyrinth' });
  assert.deepEqual(fromRoute('zone', 'equipOpt', 'labyrinth'), { simMode: 'equipOpt', optTarget: 'zone' });
  assert.deepEqual(fromRoute('zone', 'simulate', 'labyrinth'), { simMode: 'zone', optTarget: 'labyrinth' });
});

test('fromRoute: garbage never throws and lands on Zone · Simulate', () => {
  for (const [t, tool, o] of [
    [undefined, undefined, undefined],
    [null, null, null],
    [42, {}, 'bogus'],
    ['zone', 'itemCosts', 'guildTrial']
  ]) {
    assert.deepEqual(fromRoute(t, tool, o), { simMode: 'zone', optTarget: 'zone' }, `${t} ${tool} ${o}`);
  }
  // An unknown target reads as Zone, which a real tool can still fight.
  assert.deepEqual(fromRoute('bogus', 'equipOpt', 'labyrinth'), { simMode: 'equipOpt', optTarget: 'zone' });
});

test('every reachable state survives the round trip through the header', () => {
  const modes = [...TARGETS.map(t => t.value), ...TOOLS.map(t => t.value)];
  for (const simMode of modes) {
    for (const optTarget of OPT_TARGETS) {
      const r = toRoute(simMode, optTarget);
      assert.deepEqual(fromRoute(r.target, r.tool, optTarget), { simMode, optTarget }, `${simMode} ${optTarget}`);
    }
  }
});

test('tabs: Trial offers Simulate only; Costs offers nothing; tools aim only where optTarget can', () => {
  assert.equal(supports('simulate', 'guildTrial'), true);
  for (const { value } of TOOLS) {
    assert.equal(supports(value, 'guildTrial'), false, value);
    assert.equal(supports(value, 'zone'), true, value);
    assert.equal(supports(value, 'labyrinth'), true, value);
  }
  for (const tool of ['simulate', ...TOOLS.map(t => t.value)]) {
    assert.equal(supports(tool, null), false, tool);
  }
  assert.equal(supports('bogus', 'zone'), false);
  // A tool aimed at a trial would need optTarget (and toTargetPayload) to grow first.
  assert.ok(TOOLS.every(t => t.targets.every(x => OPT_TARGETS.includes(x))));
});
