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
import { prepareEquipmentRun } from '../routes/optimizeEquipment.js';
import { sanitiseFidelity } from '../lib/optimizerRoute.js';

const { pickSubjectSlot, loadoutCandidates } = await import('../../ui/src/utils/candidateOptimizer.js');
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
const BASE_BODY = { zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 }, scan: { hours: 0.1, replicates: 2 }, workers: 1 };

async function serve(t) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', loadoutRoutes);
  app.use('/api', abilityRoutes);
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

test('the equipment scan clamps hours, replicates and alpha exactly as sanitiseFidelity does', () => {
  const zone = BASE_BODY.zone;
  const scans = [{ hours: 5000, replicates: 45.5, alpha: 0.9, step: 99 }, { hours: 0.05, replicates: 2.5, alpha: 0.0001, step: 0 },
    { hours: 'x', replicates: 1.99, alpha: -1, step: 2.7 }, undefined];
  for (const scan of scans) {
    const { hours, replicates, alpha } = prepareEquipmentRun({ players: [melee], zone, scan }).scan;
    assert.deepEqual({ hours, replicates, alpha }, sanitiseFidelity(scan), JSON.stringify(scan));
  }
  assert.deepEqual(prepareEquipmentRun({ players: [melee], zone, scan: scans[0] }).scan, { hours: 1000, replicates: 40, alpha: 0.5, step: 20 });
  assert.deepEqual(prepareEquipmentRun({ players: [melee], zone, scan: scans[1] }).scan, { hours: 24, replicates: 2, alpha: 0.0001, step: 6 });
});
