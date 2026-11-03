// =============================================================================
// audit3-1 — a dead player comes back clean. The respawn path filled HP/MP
// BEFORE clearing buffs (a max-HP buff that died with the player left HP above
// the new max), and the hours-mode dungeon refill revived the dead without
// clearing CCs, whose expiry events went at death: a stun never ended.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src', 'combatsimulator');
const CombatSimulator = (await import(join(SRC, 'combatSimulator.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const { itemDetailMap: items, abilityDetailMap: abilityData } = (await loadEngine(ROOT)).gameData;

const HP_BUFF = {
  uniqueHrid: '/buff_uniques/test_hp', typeHrid: '/buff_types/max_hitpoints',
  flatBoost: 500, ratioBoost: 0, ratioBoostLevelBonus: 0, flatBoostLevelBonus: 0, duration: 300e9,
};

function setup() {
  const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.melee, { level: 100, index: 1, items, abilityData })));
  p.zoneBuffs = [];
  p.extraBuffs = [];
  const sim = new CombatSimulator([p], null, null, {});
  sim.reset();
  p.generatePermanentBuffs();
  p.reset();
  const baseMax = p.combatDetails.maxHitpoints;
  p.addBuff(HP_BUFF, 0);
  assert.equal(p.combatDetails.maxHitpoints, baseMax + 500, 'buff applied');
  p.isStunned = true;
  p.stunExpireTime = 1e9;
  return { sim, p, baseMax };
}

test('audit3-1: a respawned player is at max HP and not stunned', () => {
  const { sim, p, baseMax } = setup();
  p.combatDetails.currentHitpoints = 0;
  sim.processPlayerRespawnEvent({ hrid: p.hrid });
  assert.equal(p.combatDetails.maxHitpoints, baseMax);
  assert.equal(p.combatDetails.currentHitpoints, baseMax, 'HP above max after respawn');
  assert.equal(p.isStunned, false);
});

test('audit3-1: a dungeon refill clears a dead player\'s CCs and buffs, a live player keeps its buffs', () => {
  const dead = setup();
  dead.p.combatDetails.currentHitpoints = 0;
  dead.sim._refillPlayer(dead.p);
  assert.equal(dead.p.isStunned, false, 'dead player revived still stunned');
  assert.equal(dead.p.combatDetails.currentHitpoints, dead.baseMax);

  const live = setup();
  live.p.combatDetails.currentHitpoints = 1;
  live.sim._refillPlayer(live.p);
  assert.equal(live.p.combatDetails.maxHitpoints, live.baseMax + 500, 'live player lost its buff');
  assert.equal(live.p.combatDetails.currentHitpoints, live.baseMax + 500);
});
