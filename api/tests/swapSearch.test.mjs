// =============================================================================
// swapSearch — the Swaps tool's candidates: owned-only, combat requirements
// against the build, pouch slot counts, no duplicate consumables, weapon
// exclusivity, default ticks and `allowed`, the descent cap, the labyrinth,
// and the descent confirmed against the start (synthetic objective, no pool).
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { COORDINATES, candidatesAt, swapContext, swapGroups } from '../lib/swapSearch.js';
import { prepareSwapRun, runSwapSearch } from '../routes/optimizeSwaps.js';

const { itemDetailMap } = await import('../../src/combatsimulator/dataProvider.js');

const I = (name) => `/items/${name}`;
const E = (slot) => `/equipment_types/${slot}`;
const drink = (name) => ({ hrid: I(name), triggers: [] });
const own = (name, enhancementLevel = 0) => ({ itemHrid: I(name), enhancementLevel, count: 1 });
const LEVELS = Object.fromEntries(['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'].map((s) => [`${s}Level`, 100]));
const subject = (extra = {}) => ({
  ...LEVELS,
  equipment: { [E('body')]: { hrid: I('anchorbound_plate_body'), enhancementLevel: 5 }, [E('two_hand')]: { hrid: I('cursed_bow'), enhancementLevel: 3 } },
  food: [null, null, null], drinks: [drink('stamina_coffee'), null, null], abilities: [null, null, null, null, null], ...extra,
});
const withGear = (s, slot, name) => ({ ...s, equipment: { ...s.equipment, [E(slot)]: { hrid: I(name), enhancementLevel: 0 } } });
const all = (ctx, state = ctx.start) => COORDINATES.flatMap((key) => candidatesAt(state, key, ctx));

test('candidates come only from what is owned or worn', () => {
  const ctx = swapContext(subject(), [own('maelstrom_plate_body', 2), own('defense_coffee'), { itemHrid: '/items/not_a_thing' }, { itemHrid: '__proto__' }, null]);
  const candidates = all(ctx);
  assert.deepEqual(candidates.map((c) => c.id).sort(), [`${E('body')}:${I('maelstrom_plate_body')}`, `drinks:0:${I('defense_coffee')}`]);
  const body = candidates.find((c) => c.id.startsWith(E('body')));
  assert.deepEqual(body.state.equipment[E('body')], { hrid: I('maelstrom_plate_body'), enhancementLevel: 2 });
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].kind, 'gear');
});

test('combat requirements are checked against the build', () => {
  const at = (defenseLevel) => all(swapContext(subject({ defenseLevel }), [own('maelstrom_plate_body')]))
    .filter((c) => c.id.includes('maelstrom')).length;
  assert.equal(at(94), 0);
  assert.equal(at(95), 1);
});

test('consumable slots open with the pouch, and nothing is slotted twice', () => {
  const base = subject({ drinks: [drink('stamina_coffee'), drink('defense_coffee'), null] });
  const counts = (s) => {
    const ctx = swapContext(s, [own('defense_coffee'), own('attack_coffee')]);
    return [0, 1, 2].map((i) => candidatesAt(ctx.start, `drinks:${i}`, ctx));
  };
  assert.deepEqual(counts(base).map((c) => c.length), [1, 0, 0]);
  assert.deepEqual(counts(withGear(base, 'pouch', 'large_pouch')).map((c) => c.length), [1, 1, 0]);
  const guzzling = counts(withGear(base, 'pouch', 'guzzling_pouch'));
  assert.deepEqual(guzzling.map((c) => c.length), [1, 1, 1]);
  for (const c of guzzling.flat()) {
    const hrids = c.state.drinks.filter(Boolean).map((d) => d.hrid);
    assert.equal(new Set(hrids).size, hrids.length, c.id);
  }
  const food = withGear(subject(), 'pouch', 'large_pouch');
  const ctx = swapContext(food, [own('donut'), own('cupcake')]);
  assert.deepEqual([0, 1, 2].map((i) => candidatesAt(ctx.start, `food:${i}`, ctx).length), [2, 2, 2]);
});

test('weapons: no off hand under a two-hander; a main hand clears it and a two-hander clears the main hand', () => {
  const names = ['regal_sword', 'knights_aegis', 'griffin_bulwark'];
  const ctx = swapContext(subject(), names.map((n) => own(n)), { allowed: new Set(names.map(I)) });
  assert.equal(candidatesAt(ctx.start, E('off_hand'), ctx).length, 0);
  const [sword] = candidatesAt(ctx.start, E('main_hand'), ctx);
  assert.equal(sword.state.equipment[E('two_hand')], undefined);
  assert.deepEqual(candidatesAt(sword.state, E('off_hand'), ctx).map((c) => c.state.equipment[E('off_hand')].hrid), [I('knights_aegis')]);
  const [bulwark] = candidatesAt(sword.state, E('two_hand'), ctx);
  assert.equal(bulwark.state.equipment[E('main_hand')], undefined);
  assert.equal(bulwark.state.equipment[E('off_hand')], undefined);
});

test('defaults: gear needing the same skills as the slot\'s item now, and every consumable; `allowed` overrides', () => {
  const owned = [own('maelstrom_plate_body'), own('griffin_bulwark'), own('defense_coffee')];
  const ctx = swapContext(subject(), owned);
  const groups = Object.fromEntries(swapGroups(ctx).map((g) => [g.key, g]));
  assert.equal(groups[E('body')].items[0].default, true);
  assert.equal(groups[E('two_hand')].items[0].default, false);
  assert.equal(groups.drinks.items[0].default, true);
  assert.ok(!all(ctx).some((c) => c.id.includes('griffin_bulwark')));
  const only = swapContext(subject(), owned, { allowed: new Set([I('griffin_bulwark')]) });
  assert.deepEqual(all(only).map((c) => c.id), [`${E('two_hand')}:${I('griffin_bulwark')}`]);
});

const BASE = { target: { kind: 'zone' }, subjectIndex: 0, scan: { hours: 1, replicates: 2, alpha: 0.05 } };

test('a best-combination pass past the cap is refused; one swap at a time is capped and reports the rest', () => {
  const consumables = Object.keys(itemDetailMap).filter((h) => itemDetailMap[h].consumableDetail?.usableInActionTypeMap?.['/action_types/combat']
    && /food|drink/.test(itemDetailMap[h].categoryHrid)).map((h) => ({ itemHrid: h, count: 1 }));
  const base = { ...BASE, simPlayers: [withGear(subject(), 'pouch', 'guzzling_pouch')] };
  const best = prepareSwapRun(base, { search: 'best', owned: consumables });
  assert.equal(best.workload.candidates, 3 * 29 + 3 * 27 + 2 + 2 + 2);
  assert.ok(best.workload.candidates > 151);
  assert.match(best.refusal, /Untick some items/);
  assert.equal(prepareSwapRun(base, { search: 'best', owned: consumables, allowed: [] }).refusal, null);
  const swaps = prepareSwapRun(base, { search: 'swaps', owned: consumables });
  assert.equal(swaps.refusal, null);
  assert.equal(swaps.candidates.length, 150);
  assert.equal(swaps.echo.skipped, 9);
});

test('a labyrinth swaps gear only', () => {
  const p = prepareSwapRun({ ...BASE, target: { kind: 'labyrinth' }, simPlayers: [subject()] },
    { owned: [own('defense_coffee'), own('maelstrom_plate_body')] });
  assert.deepEqual(p.candidates.map((c) => c.id), [`${E('body')}:${I('maelstrom_plate_body')}`]);
  assert.ok(!p.echo.groups.some((g) => g.key === 'food' || g.key === 'drinks'));
});

test('the descent climbs to the best combination and is confirmed against the start', async () => {
  const WORTH = { [I('maelstrom_plate_body')]: 10, [I('defense_coffee')]: 5, [I('attack_coffee')]: 3 };
  const worth = (dto) => [dto.equipment[E('body')], ...dto.drinks].reduce((sum, x) => sum + (WORTH[x?.hrid] || 0), 0);
  const evaluate = async (jobs) => jobs.map((job) => ({ id: job.id, metrics: { encountersPerHour: 100 + worth(job.playerDTOs[0]) } }));
  const base = { ...BASE, simPlayers: [withGear(subject(), 'pouch', 'large_pouch')], objective: 'encountersPerHour' };
  const p = { ...base, ...prepareSwapRun(base, { search: 'best', passes: 3,
    owned: [own('maelstrom_plate_body'), own('defense_coffee'), own('attack_coffee')] }) };
  const result = await runSwapSearch(p, { evaluate, seedBase: 1, onProgress: () => {} });
  assert.deepEqual(result.rows.map((r) => r.id), ['best']);
  const { state } = result.rows[0];
  assert.equal(state.equipment[E('body')].hrid, I('maelstrom_plate_body'));
  assert.deepEqual(state.drinks.map((d) => d?.hrid ?? null), [I('defense_coffee'), I('attack_coffee'), null]);
  assert.equal(result.baseline.metrics.encountersPerHour, 100);
  assert.ok(result.simulationsRun <= p.workload.total, `${result.simulationsRun} > ${p.workload.total}`);
});
