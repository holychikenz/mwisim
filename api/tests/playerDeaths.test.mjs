// =============================================================================
// audit2-1 — a player death is counted once.
//
// Every kill site called simResult.addDeath() for players too, and
// checkEncounterEnd counted the same death again, so deaths came out doubled:
// a L20 solo player in infernal_abyss "died" 47 times an hour, though the
// 150 s respawn allows at most 24.
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
const GuildTrial = (await import(join(SRC, 'guildTrial.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const Zone = (await import(join(SRC, 'zone.js'))).default;
const DamageOverTimeEvent = (await import(join(SRC, 'events', 'damageOverTimeEvent.js'))).default;
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

const player = (level, index = 1, buffs = []) => {
  const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.melee, { level, index, items, abilityData })));
  p.zoneBuffs = buffs;
  p.extraBuffs = [];
  return p;
};
const dot = (t, target) => new DamageOverTimeEvent(t, { hrid: '/monsters/x' }, target, 30, 3, 2, '/combat_styles/slash');

test('audit2-1: a weak solo player dies at most once per 150 s respawn', () => {
  const zone = new Zone('/actions/combat/infernal_abyss', 0);
  const sim = new CombatSimulator([player(20, 1, zone.buffs)], zone, null, {});
  const hours = 10;
  withSeed(1, () => sim.simulate(hours * 3600e9));
  const deaths = sim.simResult.deaths.player1;
  assert.ok(deaths > 100, `the L20 player must keep dying (got ${deaths})`);
  assert.ok(deaths / hours <= 3600 / 150, `${deaths / hours} deaths/h exceeds the respawn cap`);
});

test('audit2-1: a trial death counts once', () => {
  const p = player(400);
  const gt = new GuildTrial('/guild_combat/badger', 100, 1, {});
  const sim = new CombatSimulator([p], null, null, { guildTrial: gt });
  sim.reset();
  p.generatePermanentBuffs();
  p.reset();
  sim.enemies = gt.getEncounter();
  p.combatDetails.currentHitpoints = 5;
  sim.processEvent(dot(1e9, p));
  sim.checkEncounterEnd();
  assert.equal(sim.simResult.deaths.player1, 1);
});

test('audit2-1: a dead dungeon party member is not re-counted by later checks', () => {
  const zone = new Zone('/actions/combat/chimerical_den', 0);
  const [a, b] = [player(150, 1, zone.buffs), player(150, 2, zone.buffs)];
  const sim = new CombatSimulator([a, b], zone, null, {});
  sim.reset();
  for (const p of [a, b]) { p.generatePermanentBuffs(); p.reset(); }
  withSeed(1, () => sim.startNewEncounter());
  a.combatDetails.currentHitpoints = 5;
  sim.processEvent(dot(1e9, a));
  sim.checkEncounterEnd();
  sim.checkEncounterEnd();
  assert.equal(sim.simResult.deaths.player1, 1);
  assert.equal(sim.simResult.deaths.player2, undefined);
});

test('audit2-1: a player dead at the end of a completed dungeon run counts again next run', () => {
  const zone = new Zone('/actions/combat/chimerical_den', 0);
  const [a, b] = [player(150, 1, zone.buffs), player(150, 2, zone.buffs)];
  const sim = new CombatSimulator([a, b], zone, null, {});
  sim.reset();
  for (const p of [a, b]) { p.generatePermanentBuffs(); p.reset(); }
  withSeed(1, () => sim.startNewEncounter());
  a.combatDetails.currentHitpoints = 5;
  sim.processEvent(dot(1e9, a));
  // B finishes the run; the next run's first wave refills the party.
  sim.zone.dungeonsCompleted += 1;
  withSeed(2, () => sim.startNewEncounter());
  assert.ok(a.combatDetails.currentHitpoints > 0, 'the completed run refilled player1');
  a.combatDetails.currentHitpoints = 5;
  sim.processEvent(dot(2e9, a));
  assert.equal(sim.simResult.deaths.player1, 2);
});
