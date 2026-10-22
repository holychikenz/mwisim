// =============================================================================
// audit-5 — a unit killed by thorns, retaliation or a parry counter stops
// attacking. processAutoAttackEvent re-armed event.source with no alive check,
// and an area ability kept striking targets after its caster died to the
// first target's reflect. Seeded dungeon runs: 478 attacks by dead units.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { withSeed } from '../lib/determinism.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer, MIXED_PARTY } from '../bench/builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src', 'combatsimulator');
const CombatSimulator = (await import(join(SRC, 'combatSimulator.js'))).default;
const CombatUtilities = (await import(join(SRC, 'combatUtilities.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const Zone = (await import(join(SRC, 'zone.js'))).default;
const Monster = (await import(join(SRC, 'monster.js'))).default;
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

test('audit-5: no auto-attack, cast or ability hit comes from a dead unit', async () => {
  const zone = new Zone('/actions/combat/chimerical_den', 0);
  const players = MIXED_PARTY.map((n, i) => {
    const p = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS[n], { level: 600, index: i + 1, items, abilityData })));
    p.zoneBuffs = zone.buffs;
    p.extraBuffs = [];
    return p;
  });
  const sim = new CombatSimulator(players, zone, null, {});
  const dead = { auto: 0, cast: 0, hit: 0 };
  const isDead = (u) => u.combatDetails.currentHitpoints <= 0;
  const auto = sim.processAutoAttackEvent.bind(sim);
  sim.processAutoAttackEvent = (ev) => { if (isDead(ev.source)) dead.auto++; return auto(ev); };
  const cast = sim.tryUseAbility.bind(sim);
  sim.tryUseAbility = (source, ability) => { if (isDead(source)) dead.cast++; return cast(source, ability); };
  const processAttack = CombatUtilities.processAttack;
  CombatUtilities.processAttack = (source, target, effect) => {
    if (effect && isDead(source)) dead.hit++;
    return processAttack(source, target, effect);
  };
  const log = console.log;
  console.log = () => {};
  try {
    await withSeed(3, () => sim.simulate(2 * 3600e9));
  } finally {
    console.log = log;
    CombatUtilities.processAttack = processAttack;
  }
  assert.deepEqual(dead, { auto: 0, cast: 0, hit: 0 });
});

test('audit-5: an area cast stops at the target whose reflect kills the caster', () => {
  const caster = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.magic, { level: 100, index: 1, items, abilityData })));
  caster.zoneBuffs = [];
  caster.extraBuffs = [];
  const sim = new CombatSimulator([caster], null, null, {});
  sim.reset();
  caster.generatePermanentBuffs();
  caster.reset();
  sim.enemies = ['/monsters/fly', '/monsters/fly', '/monsters/fly'].map(h => { const m = new Monster(h, 0); m.reset(0); return m; });
  let struck = 0;
  const processAttack = CombatUtilities.processAttack;
  // Stand-in for a lethal thorns reflect off the first target.
  CombatUtilities.processAttack = (source) => {
    struck++;
    source.combatDetails.currentHitpoints = 0;
    return { damageDone: 1, didHit: true, thornDamageDone: 1, thornType: 'physicalThorns', retaliationDamageDone: 0, lifeStealHeal: 0, hpDrain: 0, manaLeechMana: 0, isCrit: false };
  };
  try {
    sim.processAbilityDamageEffect(caster, { hrid: '/abilities/test' }, { targetType: 'allEnemies', combatStyleHrid: '/combat_styles/magic', damageType: '/damage_types/fire' });
  } finally {
    CombatUtilities.processAttack = processAttack;
  }
  assert.equal(struck, 1);
});

test('audit-5: a caster killed mid-cast applies none of the cast\'s later effects', async () => {
  const caster = Player.createFromDTO(structuredClone(toCsimPlayer(BUILDS.magic, { level: 100, index: 1, items, abilityData })));
  caster.zoneBuffs = [];
  caster.extraBuffs = [];
  const sim = new CombatSimulator([caster], null, null, {});
  sim.reset();
  caster.generatePermanentBuffs();
  caster.reset();
  const later = [];
  sim.canUseAbility = () => true;
  sim.checkEncounterEnd = () => false;
  // Stand-in for a lethal reflect off the damage effect; the heal and buff after it must not run.
  sim.processAbilityDamageEffect = (source) => { source.combatDetails.currentHitpoints = 0; };
  sim.processAbilityHealEffect = () => later.push('heal');
  sim.processAbilityBuffEffect = () => later.push('buff');
  caster.combatDetails.combatStats.ripple = 1;
  caster.combatDetails.currentManapoints = 0;
  const mp = 0;
  const ability = { hrid: '/abilities/test', manaCost: 0, abilityEffects: [{ effectType: '/ability_effect_types/damage' }, { effectType: '/ability_effect_types/heal' }, { effectType: '/ability_effect_types/buff' }] };
  await withSeed(1, () => sim.tryUseAbility(caster, ability));
  assert.deepEqual(later, []);
  assert.equal(caster.combatDetails.currentHitpoints, 0);
  assert.equal(caster.combatDetails.currentManapoints, mp, 'no ripple mana for the dead');
});
