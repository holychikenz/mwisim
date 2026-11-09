// =============================================================================
// The Loadout and Abilities tools: the UI's pure helpers (whose slot, which
// loadouts), the loadout route's prepare, and a tiny seeded end-to-end run of
// both routes on the real pool (fly T0, 0.1 h, 2 replicates, 1 worker).
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import loadoutRoutes, { prepareLoadoutRun } from '../routes/optimizeLoadout.js';
import abilityRoutes from '../routes/optimizeAbilities.js';
import progressRoutes from '../routes/optimizeProgress.js';
import swapRoutes from '../routes/optimizeSwaps.js';
import { prepareEquipmentRun } from '../routes/optimizeEquipment.js';
import { sanitiseDropCreditCosts, sanitiseFidelity } from '../lib/optimizerRoute.js';

const { pickSubjectSlot, loadoutCandidates, progressColumns, applySwapChanges, applyAbilityChanges, headlineRow, samePayload } =
  await import('../../ui/src/utils/candidateOptimizer.js');
const { verdictOf } = await import('../../ui/src/utils/equipmentOptimizer.js');
const { resolvePlayer } = await import('../../ui/src/utils/characterStore.js');
const { toPlayerDTO } = await import('../../ui/src/utils/playerDTO.js');

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('pickSubjectSlot: main by default, a selected pick wins, falls back when the pick leaves', () => {
  const party = { 1: { characterId: 'x' }, 2: { characterId: 'main' }, 3: { characterId: 'y' } };
  assert.deepEqual(pickSubjectSlot({ selectedParty: [1, 2, 3], party, mainId: 'main', picked: null }), { slot: 2, index: 1, mainSlot: 2 });
  assert.deepEqual(pickSubjectSlot({ selectedParty: [1, 2, 3], party, mainId: 'main', picked: 3 }), { slot: 3, index: 2, mainSlot: 2 });
  assert.deepEqual(pickSubjectSlot({ selectedParty: [1, 2], party, mainId: 'main', picked: 3 }), { slot: 2, index: 1, mainSlot: 2 });
  assert.deepEqual(pickSubjectSlot({ selectedParty: [3, 1], party, mainId: 'absent', picked: null }), { slot: 3, index: 0, mainSlot: null });
  assert.deepEqual(pickSubjectSlot({ selectedParty: [], party, mainId: 'main', picked: 2 }), { slot: null, index: -1, mainSlot: null });
});

test('headlineRow: "Best" needs a significant GAIN; a delta of exactly 0, or a null one, is not one', () => {
  const sig = (id, gain) => ({ id, significantFamilywise: true, significant: true, ...gain });
  assert.equal(headlineRow([sig('zero', { delta: 0 }), sig('none', { delta: null }), sig('up', { delta: 0.5 })])?.id, 'up');
  assert.equal(headlineRow([sig('flat', { perLevel: 0 }), sig('level', { perLevel: 0.01 })])?.id, 'level');
  assert.equal(headlineRow([sig('zero', { delta: 0 }), { id: 'noise', significantFamilywise: false, delta: 3 }]), undefined);
});

test('verdictOf: a gain is > 0; a zero or missing change is no clear change, never a gain or a loss', () => {
  const sig = { significant: true, significantFamilywise: true };
  for (const row of [{ ...sig, delta: 0 }, { ...sig, delta: null }, { ...sig, perLevel: 0 }, { significant: true, delta: 0 }, {}]) {
    assert.equal(verdictOf(row), 'noise', JSON.stringify(row));
  }
  assert.equal(verdictOf({ ...sig, delta: 0.5 }), 'strong-gain');
  assert.equal(verdictOf({ significant: true, perLevel: 0.01 }), 'gain');
  assert.equal(verdictOf({ ...sig, perLevel: -0.01, delta: 9 }), 'strong-loss', 'perLevel before delta');
  assert.equal(verdictOf({ significant: true, delta: -0.5 }), 'loss');
  assert.equal(verdictOf({ delta: 3 }), 'noise');
  assert.equal(verdictOf(null), 'unknown');
});

test('loadoutCandidates: every OTHER saved loadout as a plain DTO', () => {
  const loadout = (food) => ({ equipment: {}, food: [food, null, null], drinks: [null, null, null],
    abilities: [null, { hrid: '/abilities/poke', triggers: [] }, null, null, null], triggerMemory: {} });
  const character = { id: 'c', name: 'c', intelligenceLevel: 10, abilityLevels: { '/abilities/poke': 4 },
    loadouts: { a: loadout(null), b: loadout({ itemHrid: '/items/donut', triggers: [] }), 'c#1': loadout(null) } };
  const out = loadoutCandidates(character, 'a');
  assert.deepEqual(out.map((c) => c.name), ['b', 'c#1']);
  for (const c of out) {
    assert.deepEqual(c.player, toPlayerDTO(resolvePlayer(character, character.loadouts[c.name])));
    assert.equal('abilityMemory' in c.player, false);
  }
});

test('prepareLoadoutRun: server-owned ids, the subject\'s hrid / buffs / level gap, consumables stripped in a lab', () => {
  const subject = { hrid: 'player2', extraBuffs: [{ x: 1 }], debuffOnLevelGap: -0.3 };
  const out = prepareLoadoutRun(
    { target: { kind: 'labyrinth' }, simPlayers: [{ hrid: 'player1' }, subject], subjectIndex: 1, scan: { hours: 1, replicates: 2 } },
    { candidates: [
      { name: 'tank#2', player: { hrid: 'x', food: [{ hrid: '/items/donut' }, null, null], drinks: [{ hrid: '/items/coffee' }, null, null] } },
      { name: 'junk', player: null },
    ] },
  );
  assert.deepEqual(out.candidates.map((c) => c.id), ['loadout0']);
  assert.equal(out.candidates[0].label, 'tank#2');
  const dto = out.dtos.get('loadout0');
  assert.equal(dto.hrid, 'player2');
  assert.deepEqual(dto.extraBuffs, subject.extraBuffs);
  assert.equal(dto.debuffOnLevelGap, -0.3);
  assert.deepEqual(dto.food, [null, null, null]);
  assert.deepEqual(dto.drinks, [null, null, null]);
  assert.equal(out.workload.total, 4);
});

// ---------------------------------------------------------------------------
// end to end, real pool
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;
const melee = toCsimPlayer(BUILDS.melee, { level: 100, index: 1, items, abilityData });
const bare = toCsimPlayer(BUILDS.bare, { level: 100, index: 1, items, abilityData });
const ranged = toCsimPlayer(BUILDS.ranged, { level: 100, index: 1, items, abilityData });
const BASE_BODY = { zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 }, scan: { hours: 0.1, replicates: 2 }, workers: 1 };

async function serve(t) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', loadoutRoutes);
  app.use('/api', abilityRoutes);
  app.use('/api', progressRoutes);
  app.use('/api', swapRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/api`;
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
});

/** POST an SSE run and return its frames, in order. */
async function frames(url, body) {
  const text = await (await post(url, body)).text();
  return text.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
}

function assertRunShape(list) {
  assert.equal(list[0].type, 'start');
  assert.equal(list.at(-1).type, 'result', JSON.stringify(list.at(-1)).slice(0, 300));
  assert.ok(list.slice(1, -1).every((f) => f.type === 'progress'));
  assert.ok(list.slice(1, -1).length > 0);
  return list.at(-1).result;
}

test('Loadout route end to end: preview, ranked rows on paired seeds, deterministic', async (t) => {
  const base = await serve(t);
  const body = { ...BASE_BODY, players: [melee], subjectIndex: 0,
    candidates: [{ name: 'same', player: melee }, { name: 'bare #1', player: bare }] };
  const preview = await (await post(`${base}/optimize-loadout/preview`, body)).json();
  assert.equal(preview.success, true);
  assert.equal(preview.candidates, 2);
  assert.equal(preview.workload.total, 6);

  const result = assertRunShape(await frames(`${base}/optimize-loadout`, body));
  assert.deepEqual(result.rows.map((r) => r.label), ['same', 'bare #1']);
  const [same, bareRow] = result.rows;
  assert.equal(same.delta, 0);
  assert.equal(same.significant, false);
  assert.ok(bareRow.delta < 0, `bare delta ${bareRow.delta}`);
  for (const row of result.rows) {
    for (const key of ['encountersPerHour', 'effectiveEncountersPerHour', 'deathsPerHour']) {
      assert.ok(Number.isFinite(row.metrics[key]), `${row.label} ${key}`);
    }
    assert.ok('pValue' in row.statistics);
  }
  const again = assertRunShape(await frames(`${base}/optimize-loadout`, body));
  assert.deepEqual(again.rows, result.rows);
});

test('drop credit rides the pool: rows carry the breakdown only when the table is posted beside a cost table', async (t) => {
  const base = await serve(t);
  // Rats drop sugar and wheat; the build's coffee is all that is priced, at a second each.
  const body = { ...BASE_BODY, zone: { zoneHrid: '/actions/combat/rat', difficultyTier: 0 }, players: [melee], subjectIndex: 0,
    candidates: [{ name: 'same', player: melee }], consumableCosts: { '/items/ultra_melee_coffee': 1 } };
  const dropCreditCosts = { '/items/sugar': 1, '/items/wheat': 1 };
  const on = assertRunShape(await frames(`${base}/optimize-loadout`, { ...body, dropCreditCosts })).baseline.metrics;
  assert.ok(on.dropCreditSecondsPerHour > 0, JSON.stringify(on));
  assert.ok(Math.abs(on.netConsumableSecondsPerHour - (on.consumableSecondsPerHour - on.dropCreditSecondsPerHour)) < 1e-6);
  assert.ok(on.effectiveEncountersPerHour > on.encountersPerHour, 'the drops are worth more than the coffee');
  const off = assertRunShape(await frames(`${base}/optimize-loadout`, body)).baseline.metrics;
  assert.equal('dropCreditSecondsPerHour' in off, false);
  const uncosted = assertRunShape(await frames(`${base}/optimize-loadout`, { ...body, consumableCosts: undefined, dropCreditCosts })).baseline.metrics;
  assert.equal('dropCreditSecondsPerHour' in uncosted, false);
});

test('drop credit makes a run costed where the bill is known — nothing slotted — but not beside an unpriced plate', async (t) => {
  const base = await serve(t);
  const preview = async (player, extra) => (await post(`${base}/optimize-loadout/preview`,
    { ...BASE_BODY, players: [player], subjectIndex: 0, candidates: [{ name: 'same', player }], ...extra })).json();
  const credit = { dropCreditCosts: { '/items/sugar': 1 } };
  const alone = await preview(bare, credit); // eats nothing: a bill of zero
  assert.equal(alone.consumableCostsKnown, true);
  assert.equal(alone.objective, 'effectiveEncountersPerHour');
  const unpriced = await preview(melee, credit); // food and coffee slotted, none priced: the bill is unknown
  assert.equal(unpriced.consumableCostsKnown, false);
  assert.equal(unpriced.objective, 'encountersPerHour');
  assert.equal((await preview(bare, {})).consumableCostsKnown, false);
  // A Loadout candidate that eats, with nothing priced, leaves the bill as unknown as the party's own plate would.
  const mixed = await (await post(`${base}/optimize-loadout/preview`,
    { ...BASE_BODY, players: [bare], subjectIndex: 0, candidates: [{ name: 'eats', player: melee }], ...credit })).json();
  assert.equal(mixed.consumableCostsKnown, false);
  assert.equal(mixed.objective, 'encountersPerHour');
});

test('sanitiseDropCreditCosts: a candidate loadout that slots food counts as eating; a cost table admits it', () => {
  const credit = { '/items/sugar': 1 };
  const none = { food: [null, null, null], drinks: [null, null, null] };
  const eats = { food: [{ hrid: '/items/donut', triggers: [] }, null, null], drinks: [] };
  const sanitise = (body, consumableCosts) => sanitiseDropCreditCosts({ dropCreditCosts: credit, ...body }, { consumableCosts, simPlayers: [none] });
  assert.deepEqual(sanitise({}, null), credit);
  assert.equal(sanitise({ candidates: [{ name: 'eats', player: eats }] }, null), null);
  assert.deepEqual(sanitise({ candidates: [{ name: 'eats', player: eats }] }, { '/items/donut': 30 }), credit);
  assert.deepEqual(sanitise({ candidates: [{ name: 'bare', player: none }, null, { player: 'junk' }] }, null), credit);
});

test('sanitiseDropCreditCosts: only the loadouts a run simulates count, the first 40 that have a player', () => {
  const credit = { '/items/sugar': 1 };
  const none = { food: [null, null, null], drinks: [null, null, null] };
  const eats = { food: [{ hrid: '/items/donut', triggers: [] }, null, null], drinks: [] };
  const sanitise = (candidates) => sanitiseDropCreditCosts({ dropCreditCosts: credit, candidates }, { consumableCosts: null, simPlayers: [none] });
  const bare = Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, player: none }));
  assert.deepEqual(sanitise([...bare, { name: 'eats', player: eats }]), credit); // the 41st is never simulated
  assert.equal(sanitise([null, ...bare.slice(1), { name: 'eats', player: eats }]), null); // a junk entry takes no place
});

test('prepareLoadoutRun: under a costed objective a loadout slotting unpriced food or drink says so, as Swaps does', () => {
  const base = { target: { kind: 'zone' }, simPlayers: [{ hrid: 'player1' }], subjectIndex: 0, scan: { hours: 1, replicates: 2 },
    objective: 'effectiveEncountersPerHour', consumableCosts: { '/items/donut': 0 }, consumableCostsKnown: true };
  const candidates = [
    { name: 'priced', player: { food: [{ hrid: '/items/donut' }, null, null], drinks: [] } },
    { name: 'coffee', player: { food: [], drinks: [{ hrid: '/items/coffee' }, null, null] } },
    { name: 'bare', player: { food: 'junk' } },
  ];
  const labels = (extra) => prepareLoadoutRun({ ...base, ...extra }, { candidates }).candidates.map((c) => c.label);
  assert.deepEqual(labels({}), ['priced', 'coffee · no price', 'bare']);
  // Raw EPH ignores prices, and with no bill known effective EPH is EPH: nothing to flag.
  assert.deepEqual(labels({ objective: 'encountersPerHour' }), ['priced', 'coffee', 'bare']);
  assert.deepEqual(labels({ consumableCosts: null, consumableCostsKnown: false }), ['priced', 'coffee', 'bare']);
});

test('Abilities route end to end: one swap and one cast order, default triggers, deterministic', async (t) => {
  const base = await serve(t);
  const slot = (hrid) => ({ hrid, level: 10, triggers: abilityData[hrid].defaultCombatTriggers });
  const subject = { ...melee, abilities: [slot('/abilities/critical_aura'), slot('/abilities/berserk'), slot('/abilities/cleave'), null, null] };
  const body = { ...BASE_BODY, players: [subject], subjectIndex: 0, coordinates: ['s0', 'order'],
    ownedAbilities: { '/abilities/critical_aura': 10, '/abilities/fierce_aura': 5, '/abilities/berserk': 10,
      '/abilities/cleave': 10, '/abilities/precision': 10, '/abilities/not_a_thing': 3 } };
  const preview = await (await post(`${base}/optimize-abilities/preview`, body)).json();
  assert.equal(preview.success, true);
  assert.equal(preview.candidates, 2);
  assert.equal(preview.slots.length, 6);
  assert.equal(preview.workload.total, 6);

  const result = assertRunShape(await frames(`${base}/optimize-abilities`, body));
  const byId = Object.fromEntries(result.rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['order:2-1', 's0:/abilities/fierce_aura']);
  assert.deepEqual(byId['s0:/abilities/fierce_aura'].abilities[0],
    { hrid: '/abilities/fierce_aura', level: 5, triggers: abilityData['/abilities/fierce_aura'].defaultCombatTriggers });
  const order = byId['order:2-1'].abilities;
  assert.equal(order[1].hrid, '/abilities/cleave');
  assert.equal(order[2].hrid, '/abilities/berserk');
  assert.deepEqual(order[1].triggers, subject.abilities[2].triggers);
  assert.deepEqual(order[2].triggers, subject.abilities[1].triggers);
  const again = assertRunShape(await frames(`${base}/optimize-abilities`, body));
  assert.deepEqual(again.rows, result.rows);
});

test('Loadout route: no candidates, or a subjectIndex outside the party, is a 400', async (t) => {
  const base = await serve(t);
  const empty = await post(`${base}/optimize-loadout`, { ...BASE_BODY, players: [melee], subjectIndex: 0, candidates: [] });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'This character has no other saved loadout to compare');
  const outside = await post(`${base}/optimize-loadout`, { ...BASE_BODY, players: [melee], subjectIndex: 3, candidates: [{ name: 'b', player: bare }] });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).success, false);
});

test('Abilities route: a best-combination pass bigger than one change at a time is refused, with the reason in the preview', async (t) => {
  const base = await serve(t);
  const everything = Object.fromEntries(Object.keys(abilityData).map((hrid) => [hrid, 1]));
  const body = { ...BASE_BODY, players: [{ ...melee, intelligenceLevel: 100 }], subjectIndex: 0, search: 'best', ownedAbilities: everything };
  const preview = await (await post(`${base}/optimize-abilities/preview`, body)).json();
  assert.equal(preview.success, true); // a 200, so the panel keeps its slot checkboxes
  assert.ok(preview.workload.candidates > 151, `${preview.workload.candidates} per pass`);
  assert.match(preview.refusal, /Untick a slot/);
  const run = await post(`${base}/optimize-abilities`, body);
  assert.equal(run.status, 400);
  assert.equal((await run.json()).error, preview.refusal);
  assert.equal((await (await post(`${base}/optimize-abilities/preview`, { ...body, coordinates: ['s0', 'order'] })).json()).refusal, null);
  const swaps = await (await post(`${base}/optimize-abilities/preview`, { ...body, search: 'swaps' })).json();
  assert.equal(swaps.refusal, null);
  assert.ok(swaps.skipped > 0);
});

test('prepareLoadoutRun: loadouts past the cap are reported as skipped, not dropped silently', () => {
  const out = prepareLoadoutRun(
    { target: { kind: 'zone' }, simPlayers: [{ hrid: 'player1' }], subjectIndex: 0, scan: { hours: 1, replicates: 2 } },
    { candidates: Array.from({ length: 42 }, (_, i) => ({ name: `l${i}`, player: {} })) });
  assert.equal(out.candidates.length, 40);
  assert.equal(out.echo.skipped, 2);
  assert.equal(out.workload.total, 41 * 2);
});

test('fidelity: hours, replicates and alpha clamp or fall back to the defaults; the equipment scan adds its step', () => {
  const DEFAULTS = { hours: 24, replicates: 6, alpha: 0.05 };
  const cases = [
    [{ hours: 5000, replicates: 45.5, alpha: 0.9, step: 99 }, { hours: 1000, replicates: 40, alpha: 0.5 }, 20],
    [{ hours: 0.05, replicates: 2.5, alpha: 0.0001, step: 0 }, { hours: 24, replicates: 2, alpha: 0.0001 }, 6],
    [{ hours: 0.1, replicates: 2, alpha: 0.5, step: 1 }, { hours: 0.1, replicates: 2, alpha: 0.5 }, 1],
    [{ hours: 'x', replicates: 1.99, alpha: -1, step: 2.7 }, DEFAULTS, 2],
    [undefined, DEFAULTS, 6],
    [null, DEFAULTS, 6],
  ];
  for (const [scan, fidelity, step] of cases) {
    assert.deepEqual(sanitiseFidelity(scan), fidelity, JSON.stringify(scan));
    assert.deepEqual(prepareEquipmentRun({ players: [melee], zone: BASE_BODY.zone, scan }).scan, { ...fidelity, step }, JSON.stringify(scan));
  }
});

test('Progress route end to end: the probes, per-level rows with costs, deterministic', async (t) => {
  const base = await serve(t);
  const subject = { ...ranged, abilities: [null, ranged.abilities[1], null, null, null] };
  const body = { ...BASE_BODY, players: [subject], subjectIndex: 0, levels: 10 };
  const preview = await (await post(`${base}/optimize-progress/preview`, body)).json();
  assert.equal(preview.success, true);
  assert.deepEqual(preview.probes.map((p) => p.label), ['Ranged +10', 'Attack +10', 'Rain Of Arrows +10 lvls']);
  assert.equal(preview.workload.total, 8);

  const result = assertRunShape(await frames(`${base}/optimize-progress`, body));
  assert.equal(result.rows.length, 3);
  for (const row of result.rows) {
    assert.ok('perLevel' in row, row.id);
    assert.ok(Number.isFinite(row.metrics.encountersPerHour), row.id);
  }
  assert.ok(Number.isFinite(result.rows.find((r) => r.id === 'stat:ranged').xpPerLevel));
  const again = assertRunShape(await frames(`${base}/optimize-progress`, body));
  assert.deepEqual(again.rows, result.rows);
});

test('progressColumns: cost and yield always; a book-price column only when the source prices books', () => {
  assert.deepEqual(progressColumns(null).map((c) => c.key), ['cost', 'yield']);
  const columns = progressColumns({ prices: { '/items/poke': { ask: 2e6, bid: -1, vendor: 0 } }, unit: 'coins', expenseMode: 'ask' });
  const price = columns.find((c) => c.key === 'price');
  assert.equal(price.cell({ kind: 'ability', bookHrid: '/items/poke', pctPerBook: 0.001 }), '+0.050%');
  assert.equal(price.cell({ kind: 'stat', xpPerLevel: 1, pctPerMillionXp: 0.1 }), '—');
});

test('Swaps route end to end: owned consumables and gear, default ticks, deterministic', async (t) => {
  const base = await serve(t);
  const owned = [{ itemHrid: '/items/ultra_defense_coffee', enhancementLevel: 0, count: 2 },
    { itemHrid: '/items/anchorbound_plate_body', enhancementLevel: 5, count: 1 }, { itemHrid: '/items/cursed_bow', enhancementLevel: 0, count: 1 }];
  const body = { ...BASE_BODY, players: [melee], subjectIndex: 0, owned };
  const preview = await (await post(`${base}/optimize-swaps/preview`, body)).json();
  assert.equal(preview.success, true);
  assert.equal(preview.candidates, 4); // the coffee into each of 3 drink slots, and the unrefined body (defense, as worn)
  assert.equal(preview.workload.total, 10);
  const twoHand = preview.groups.find((g) => g.key === '/equipment_types/two_hand');
  assert.equal(twoHand.items.find((i) => i.hrid === '/items/cursed_bow').default, false);

  const result = assertRunShape(await frames(`${base}/optimize-swaps`, body));
  assert.equal(result.rows.length, 4);
  for (const row of result.rows) assert.ok(row.changes?.length, row.id);
  const again = assertRunShape(await frames(`${base}/optimize-swaps`, body));
  assert.deepEqual(again.rows, result.rows);
});

test('applySwapChanges writes only the changed slots, in the store\'s shape, without mutating the player', () => {
  const sword = { itemHrid: '/items/regal_sword', enhancementLevel: 3 };
  const body = { itemHrid: '/items/anchorbound_plate_body', enhancementLevel: 5 };
  const player = { equipment: { '/equipment_types/two_hand': { itemHrid: '/items/cursed_bow', enhancementLevel: 0 }, '/equipment_types/body': body },
    food: [{ itemHrid: '/items/donut', triggers: [] }, null, null], drinks: [null, null, null], abilities: [] };
  const frozen = JSON.stringify(player);
  const next = applySwapChanges(player, [
    { kind: 'gear', slot: '/equipment_types/main_hand', from: null, item: { hrid: sword.itemHrid, enhancementLevel: 3 } },
    { kind: 'gear', slot: '/equipment_types/two_hand', from: '/items/cursed_bow', item: null },
    { kind: 'drinks', index: 1, from: null, item: { hrid: '/items/defense_coffee', triggers: [{ x: 1 }] } },
  ]);
  assert.deepEqual(next.equipment['/equipment_types/main_hand'], sword);
  assert.equal(next.equipment['/equipment_types/two_hand'], null);
  assert.deepEqual(next.drinks[1], { itemHrid: '/items/defense_coffee', triggers: [{ x: 1 }] });
  assert.equal(next.equipment['/equipment_types/body'], body);
  assert.equal(next.food[0], player.food[0]);
  assert.equal(next.abilities, player.abilities);
  assert.equal(JSON.stringify(player), frozen);
});

test('applyAbilityChanges writes only the slots a row changed from the run\'s start; an edit made since stands', () => {
  const a = (name, v = 1) => ({ hrid: `/abilities/${name}`, level: 1, triggers: [{ value: v }] });
  const start = [a('fierce_aura'), a('poke'), a('cleave'), null, null];
  const row = [a('fierce_aura'), a('maim'), a('cleave'), null, null]; // slot 1: poke → maim
  const player = { abilities: [a('fierce_aura'), a('poke'), a('precision'), null, null], abilityMemory: { '/abilities/maim': { level: 7 } } };
  const out = applyAbilityChanges(player, row, start);
  assert.deepEqual(out.map((s) => s?.hrid ?? null), ['/abilities/fierce_aura', '/abilities/maim', '/abilities/precision', null, null]);
  assert.equal(out[1].level, 7, 'at the level the character has now');
  assert.equal(out[2], player.abilities[2], 'slot 2 was edited since the run and is kept');
  // The row's ability, put elsewhere since the run, is not slotted twice.
  const moved = { ...player, abilities: [a('fierce_aura'), a('poke'), a('cleave'), a('maim'), null] };
  assert.deepEqual(applyAbilityChanges(moved, row, start).map((s) => s?.hrid ?? null), ['/abilities/fierce_aura', '/abilities/maim', '/abilities/cleave', null, null]);
  // The same ability with other triggers is a change.
  assert.deepEqual(applyAbilityChanges(player, [a('fierce_aura'), a('poke', 2), a('cleave'), null, null], start)[1].triggers, [{ value: 2 }]);
});

test('samePayload: the same payload or an equal rebuild; never a missing preview', () => {
  const p = { players: [{ hrid: 'player1' }], subjectIndex: 0 };
  assert.ok(samePayload(p, p));
  assert.ok(samePayload(p, JSON.parse(JSON.stringify(p))));
  assert.ok(!samePayload(p, { ...p, subjectIndex: 1 }));
  assert.ok(!samePayload(null, p));
  assert.ok(!samePayload(null, null));
});
