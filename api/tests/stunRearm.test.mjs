// audit3-15 — a stunned unit does not re-arm its attack. addNextAttackEvent had
// no stun check, so a regen tick or cooldown wake-up during a stun queued an
// auto-attack and cut the stun short. Stun expiry is what re-arms it.
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
const Monster = (await import(join(SRC, 'monster.js'))).default;
const { itemDetailMap: items, abilityDetailMap: abilityData } = (await loadEngine(ROOT)).gameData;

test('audit3-15: a stunned unit queues no action until its stun expires', () => {
  const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.melee, { level: 100, index: 1, items, abilityData })));
  p.zoneBuffs = [];
  p.extraBuffs = [];
  const sim = new CombatSimulator([p], null, null, {});
  sim.reset();
  p.generatePermanentBuffs();
  p.reset();
  const fly = new Monster('/monsters/fly', 0);
  fly.reset(0);
  sim.enemies = [fly];

  p.isStunned = true;
  sim.addNextAttackEvent(p);
  assert.equal(sim.eventQueue.hasPendingAction(p), false, 'stunned unit re-armed');

  sim.processStunExpirationEvent({ source: p });
  assert.equal(sim.eventQueue.hasPendingAction(p), true, 'stun expiry did not re-arm');
});
