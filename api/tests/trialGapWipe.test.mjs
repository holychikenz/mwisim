// =============================================================================
// audit-3 — a trial wipe in the 3 s gap after a tier clear credits nothing of
// the next tier. hpRemovedFrac fell back to 1 when enemies was null, so a DoT
// tick that wiped the party after tier 100 reported tier 110 as fully damaged:
// 500 expected guild points instead of 400. The timeout path already used 0.
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
const GuildTrial = (await import(join(SRC, 'guildTrial.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const DamageOverTimeEvent = (await import(join(SRC, 'events', 'damageOverTimeEvent.js'))).default;
const { extractTrialSummary, aggregateTrialResults } = await import(join(SRC, 'guildTrialStats.js'));
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

test('audit-3: a DoT wipe in the gap after a tier clear scores 0 of the next tier', () => {
  const player = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.melee, { level: 400, index: 1, items, abilityData })));
  player.zoneBuffs = [];
  player.extraBuffs = [];
  const gt = new GuildTrial('/guild_combat/badger', 100, 1, {});
  const sim = new CombatSimulator([player], null, null, { guildTrial: gt });
  sim.reset();
  player.generatePermanentBuffs();
  player.reset();
  // Tier 100 just cleared: the ladder advanced, enemies are gone, a DoT still ticks.
  gt.advanceTier();
  sim.enemies = null;
  sim.simulationTime = 30e9;
  player.combatDetails.currentHitpoints = 5;
  sim.processEvent(new DamageOverTimeEvent(31e9, { hrid: '/monsters/trial_badger' }, player, 30, 3, 2, '/combat_styles/slash'));

  sim.simResult.finalizeGuildTrial(gt, { endReason: 'timeout', endTime: sim.simulationTime, hpRemovedFrac: 0 });
  const s = extractTrialSummary(sim.simResult);
  assert.equal(s.endReason, 'wipe');
  assert.equal(s.finalTier, 110);
  assert.equal(s.finalTierHpRemovedFrac, 0);
  assert.equal(aggregateTrialResults([s]).expectedGuildPoints, 400);
});
