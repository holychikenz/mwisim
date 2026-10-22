// =============================================================================
// audit-1 — a party wipe in the 3 s respawn gap after a wave clear.
//
// A wave clear removes only AutoAttackEvents, so a damage-over-time tick can
// kill the last player while this.enemies === null. That reached the dungeon
// wipe branch, whose log line read this.enemies.map and threw; the branch also
// left the pending EnemyRespawnEvent, so the restart skipped wave 1.
//
// Repro: pirate_cove T0, one L150 magic build, seed 5, 2 h (crashed at ~1 h).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { withSeed } from '../lib/determinism.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src', 'combatsimulator');
const CombatSimulator = (await import(join(SRC, 'combatSimulator.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const Zone = (await import(join(SRC, 'zone.js'))).default;
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

function makeSim(zoneHrid, builds, level) {
  const zone = new Zone(zoneHrid, 0);
  const players = builds.map((n, i) => {
    const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS[n], { level, index: i + 1, items, abilityData })));
    p.zoneBuffs = zone.buffs;
    p.extraBuffs = [];
    return p;
  });
  return new CombatSimulator(players, zone, null, {});
}

async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

test('audit-1: a gap wipe in a dungeon neither throws nor skips wave 1', async () => {
  const sim = makeSim('/actions/combat/pirate_cove', ['magic'], 150);
  const spawns = [];
  const orig = sim.startNewEncounter.bind(sim);
  sim.startNewEncounter = () => { orig(); spawns.push([sim.simulationTime, sim.zone.encountersKilled - 1]); };
  let wipeAt = null;
  const origCheck = sim.checkEncounterEnd.bind(sim);
  sim.checkEncounterEnd = () => {
    const gap = sim.enemies === null;
    const r = origCheck();
    if (gap && sim.allPlayersDead && wipeAt === null) wipeAt = sim.simulationTime;
    return r;
  };
  await quiet(() => withSeed(5, () => sim.simulate(2 * 3600e9)));
  assert.ok(wipeAt !== null, 'the seeded run must still hit a gap wipe');
  // Nothing spawns until the restart 3 s later, and the restart is wave 1. A
  // leftover EnemyRespawnEvent spawned wave 1 onto the dead party first, so
  // the restart came up as wave 2.
  const next = spawns.find(([t]) => t > wipeAt);
  assert.deepEqual(next, [wipeAt + 3e9, 1]);
});

test('audit-1: a planet encounter after a gap wipe is not a failed dungeon run', async () => {
  const sim = makeSim('/actions/combat/fly', ['magic'], 150);
  sim.reset();
  for (let i = 0; i < 9; i++) await withSeed(i + 1, () => sim.startNewEncounter());
  const before = sim.zone.encountersKilled;
  sim.allPlayersDead = true;
  await withSeed(99, () => sim.startNewEncounter());
  assert.equal(sim.zone.dungeonsFailed, 0);
  assert.equal(sim.allPlayersDead, false);
  assert.equal(sim.zone.encountersKilled, before + 1, 'the boss counter is not reset');
});
