// =============================================================================
// audit-4 — Promote spawns a tracked, fully reset monster.
//
// The promoted monster was never reset() (110 HP, level-1 stats) and never put
// in this.enemies, yet it got attack events; its death then crashed
// simResult.updateTimeSpentAlive, which had no entry for its hrid.
// Repro: enchanted_fortress T0, L90 melee + magic, seed 2 (crashed at ~5920 s).
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
const SimResult = (await import(join(SRC, 'simResult.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const Zone = (await import(join(SRC, 'zone.js'))).default;
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

test('audit-4: a promoted monster is reset, replaces the pawn and is tracked', async () => {
  const zone = new Zone('/actions/combat/enchanted_fortress', 0);
  const players = ['melee', 'magic'].map((n, i) => {
    const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS[n], { level: 90, index: i + 1, items, abilityData })));
    p.zoneBuffs = zone.buffs;
    p.extraBuffs = [];
    return p;
  });
  const sim = new CombatSimulator(players, zone, null, {});
  const promoted = [];
  const orig = sim.processAbilityPromoteEffect.bind(sim);
  sim.processAbilityPromoteEffect = (source, a, e) => {
    const m = orig(source, a, e);
    promoted.push({
      full: m.combatDetails.currentHitpoints === m.combatDetails.maxHitpoints && m.combatDetails.maxHitpoints > 110,
      replaced: sim.enemies.includes(m) && !sim.enemies.includes(source),
      tracked: sim.simResult.timeSpentAlive.some(t => t.name === m.hrid && t.alive && t.spawnedAt === sim.simulationTime),
    });
    return m;
  };
  const log = console.log;
  console.log = () => {};
  try { await withSeed(2, () => sim.simulate(6000e9)); } finally { console.log = log; }
  assert.ok(promoted.length > 0, 'the seeded run must still promote');
  assert.deepEqual(promoted.filter(p => !(p.full && p.replaced && p.tracked)), []);
});

test('audit-4: closing an untracked unit is a no-op, not a throw', () => {
  const r = new SimResult(null, null, 1);
  r.updateTimeSpentAlive('/monsters/nobody', false, 5e9);
  assert.deepEqual(r.timeSpentAlive, []);
});
