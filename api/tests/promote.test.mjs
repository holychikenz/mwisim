// =============================================================================
// audit-4 — Promote spawns a tracked, fully reset monster.
//
// The promoted monster was never reset() (110 HP, level-1 stats) and never put
// in this.enemies, yet it got attack events; its death then crashed
// simResult.updateTimeSpentAlive, which had no entry for its hrid.
// Found by a seeded run (enchanted_fortress T0, L90 melee + magic, seed 2,
// crash at ~5920 s); tested here on a constructed state so it does not hang
// on one seed's trajectory.
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
const Monster = (await import(join(SRC, 'monster.js'))).default;
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

test('audit-4: a promoted monster is reset, replaces the pawn and is tracked', async () => {
  const player = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.melee, { level: 90, index: 1, items, abilityData })));
  const sim = new CombatSimulator([player], new Zone('/actions/combat/enchanted_fortress', 0), null, {});
  sim.reset();
  const other = new Monster('/monsters/enchanted_pawn', 0);
  const pawn = new Monster('/monsters/enchanted_pawn', 0);
  [other, pawn].forEach(m => m.reset(0));
  sim.enemies = [other, pawn];
  sim.simulationTime = 10e9;
  const m = await withSeed(1, () => sim.processAbilityPromoteEffect(pawn));
  assert.notEqual(m.hrid, pawn.hrid);
  assert.ok(m.combatDetails.maxHitpoints > 110, `max HP ${m.combatDetails.maxHitpoints}`);
  assert.equal(m.combatDetails.currentHitpoints, m.combatDetails.maxHitpoints);
  assert.deepEqual(sim.enemies, [other, m]);
  assert.ok(sim.simResult.timeSpentAlive.some(t => t.name === m.hrid && t.alive && t.spawnedAt === 10e9));
});

test('audit-4: closing an untracked unit is a no-op, not a throw', () => {
  const r = new SimResult(null, null, 1);
  r.updateTimeSpentAlive('/monsters/nobody', false, 5e9);
  assert.deepEqual(r.timeSpentAlive, []);
});
