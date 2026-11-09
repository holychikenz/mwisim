// =============================================================================
// abilitySearch — the Abilities tool's candidates: slot unlocks, special vs
// combat slots, owned-only, no duplicates, the game's default triggers, cast
// orders, and the coordinate descent (driven by a synthetic objective).
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COORDINATES, abilityContext, bestCandidate, candidatesAt, coordinateSummary, descendAbilities, estimateDescent,
} from '../lib/abilitySearch.js';
import { rankCandidates } from '../lib/equipmentScan/scan.js';

const { abilityDetailMap } = await import('../../src/combatsimulator/dataProvider.js');

const A = (name) => `/abilities/${name}`;
const TRIGGER = { dependencyHrid: '/combat_trigger_dependencies/self', conditionHrid: 'x', comparatorHrid: 'y', value: 1 };
/** A slotted ability with explicit triggers of its own (not the game's defaults). */
const slot = (hrid, level = 1) => ({ hrid, level, triggers: [{ ...TRIGGER, value: level }] });
const owned = (...names) => Object.fromEntries(names.map((n) => [A(n), 1]));
const all = (abilities, ctx) => COORDINATES.flatMap((key) => candidatesAt(abilities, key, ctx));

test('slots unlock at the engine\'s base-intelligence levels', () => {
  for (const [level, count] of [[1, 2], [19, 2], [20, 3], [50, 4], [90, 5]]) {
    const { unlocked } = abilityContext({ intelligenceLevel: level, abilities: [] }, {});
    assert.equal(unlocked.filter(Boolean).length, count, `intelligence ${level}`);
  }
});

const T9_SUBJECT = { intelligenceLevel: 20, abilities: [slot(A('critical_aura')), slot(A('berserk')), null, slot(A('precision')), null] };
const T9_OWNED = owned('critical_aura', 'fierce_aura', 'mystic_aura', 'berserk', 'cleave', 'maim', 'precision');

test('locked slots are never changed; slot 0 takes specials only, the rest never', () => {
  const ctx = abilityContext(T9_SUBJECT, T9_OWNED);
  const candidates = all(ctx.abilities, ctx);
  for (const c of candidates) {
    assert.deepEqual(c.abilities[3], T9_SUBJECT.abilities[3]);
    assert.deepEqual(c.abilities[4], T9_SUBJECT.abilities[4]);
  }
  const at = (slotIndex) => candidates.filter((c) => c.slot === slotIndex);
  for (const c of at(0)) assert.equal(abilityDetailMap[c.to].isSpecialAbility, true);
  for (const c of [...at(1), ...at(2)]) assert.equal(!!abilityDetailMap[c.to].isSpecialAbility, false);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => at(i).length), [2, 2, 2, 0, 0]);
  assert.equal(candidatesAt(ctx.abilities, 'order', ctx).length, 0);
  assert.equal(candidates.length, 6);
});

test('only owned abilities are tried, and none is slotted twice', () => {
  const ctx = abilityContext(T9_SUBJECT, { ...T9_OWNED, '/abilities/not_a_thing': 5, ['__proto__']: 3, [A('poke')]: 0 });
  assert.equal(Object.hasOwn(ctx.owned, '/abilities/not_a_thing'), false);
  assert.equal(Object.hasOwn(ctx.owned, '__proto__'), false);
  assert.equal(Object.hasOwn(ctx.owned, A('poke')), false);
  const candidates = all(ctx.abilities, ctx);
  for (const c of candidates) {
    if (c.to) assert.ok(Object.hasOwn(T9_OWNED, c.to), c.to);
    const hrids = c.abilities.filter(Boolean).map((a) => a.hrid);
    assert.equal(new Set(hrids).size, hrids.length, c.id);
    assert.notEqual(c.to, A('precision')); // parked in a locked slot
  }
});

test('a swapped-in ability carries copies of the game\'s default triggers; kept slots keep theirs', () => {
  const subject = { intelligenceLevel: 20, abilities: [slot(A('critical_aura')), slot(A('berserk')), null, null, null] };
  const ctx = abilityContext(subject, owned('critical_aura', 'fierce_aura', 'berserk', 'cleave', 'provoke'));
  const candidates = all(ctx.abilities, ctx);
  const cleave = candidates.find((c) => c.to === A('cleave') && c.slot === 2);
  assert.deepEqual(cleave.abilities[2].triggers, abilityDetailMap[A('cleave')].defaultCombatTriggers);
  cleave.abilities[2].triggers[0].value = 'mutated';
  assert.notEqual(abilityDetailMap[A('cleave')].defaultCombatTriggers[0].value, 'mutated');
  const provoke = candidates.find((c) => c.to === A('provoke'));
  assert.deepEqual(provoke.abilities[provoke.slot].triggers, []);
  for (const c of candidates) {
    for (const i of [0, 1, 2]) if (i !== c.slot) assert.deepEqual(c.abilities[i], subject.abilities[i]);
  }
  const ids = candidates.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(!id.includes('#'), id);
});

test('cast orders permute the filled unlocked slots 1-4 and move triggers with the ability', () => {
  const subject = { intelligenceLevel: 90, abilities: [slot(A('fierce_aura')), slot(A('poke'), 1), slot(A('cleave'), 2), slot(A('maim'), 3), null] };
  const ctx = abilityContext(subject, {});
  const orders = candidatesAt(ctx.abilities, 'order', ctx);
  assert.equal(orders.length, 5);
  for (const c of orders) {
    assert.deepEqual(c.abilities[0], subject.abilities[0]);
    assert.equal(c.abilities[4], null);
    assert.deepEqual(c.abilities.slice(1, 4).map((a) => a.hrid).sort(), [A('cleave'), A('maim'), A('poke')]);
    for (const a of c.abilities.slice(1, 4)) assert.equal(a, subject.abilities.find((s) => s?.hrid === a.hrid));
  }
  const one = abilityContext({ intelligenceLevel: 90, abilities: [null, slot(A('poke')), null, null, null] }, {});
  assert.equal(candidatesAt(one.abilities, 'order', one).length, 0);
});

test('descent climbs to the best combination and stops on a pass that changes nothing', async () => {
  const worth = { [A('fierce_aura')]: 10, [A('precision')]: 5, [A('cleave')]: 4, [A('maim')]: 3, [A('poke')]: 2 };
  const score = (abilities) => abilities.reduce((sum, a, i) => sum + (a ? worth[a.hrid] * (6 - i) : 0), 0);
  const evaluate = async (jobs) => jobs.map((job) => {
    const value = 100 + score(job.playerDTOs[0].abilities);
    return { id: job.id, metrics: { encountersPerHour: value } };
  });
  const subject = { intelligenceLevel: 90, abilities: [null, slot(A('poke')), null, null, null] };
  const ctx = abilityContext(subject, owned('poke', 'cleave', 'maim', 'precision', 'fierce_aura'));
  const scan = { hours: 1, replicates: 2 };
  let sims = 0;
  const rank = async (abilities, candidates) => {
    const result = await rankCandidates({
      playerDTOs: [{ ...subject, abilities }], candidates, evaluate, objective: 'encountersPerHour', ...scan,
      applyCandidate: (dtos, row) => dtos.map((dto) => ({ ...dto, abilities: row.abilities })),
    });
    sims += result.simulationsRun;
    return result;
  };
  const { abilities, steps } = await descendAbilities({ ctx, coordinates: COORDINATES, passes: 3, rank });
  assert.deepEqual(abilities.map((a) => a?.hrid ?? null),
    [A('fierce_aura'), A('precision'), A('cleave'), A('maim'), A('poke')]);
  assert.equal(steps.at(-1).taken, false);
  assert.ok(sims <= estimateDescent(ctx, COORDINATES, 3, scan).total, `${sims} sims`);
  const best = bestCandidate(ctx, abilities);
  assert.equal(best.id, 'best');
  assert.match(best.label, /Aura: empty → Fierce Aura/);
  assert.match(best.label, /Ability 1: Poke → Precision/);
  assert.equal(bestCandidate(ctx, ctx.abilities).label, 'No change found');
});

test('coordinateSummary reports counts, locks and unlock levels; the cast order is always open', () => {
  const ctx = abilityContext({ intelligenceLevel: 1, abilities: [null, slot(A('poke')), null, null, null] }, owned('poke', 'cleave'));
  const summary = Object.fromEntries(coordinateSummary(ctx).map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(summary), COORDINATES);
  assert.equal(summary.s1.count, 1);
  assert.equal(summary.s1.unlocked, true);
  assert.equal(summary.s2.unlocked, false);
  assert.equal(summary.s2.unlockLevel, 20);
  assert.equal(summary.s2.count, 0);
  assert.equal(summary.order.unlocked, true);
  assert.equal(summary.order.unlockLevel, null);
});
