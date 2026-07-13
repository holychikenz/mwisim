// =============================================================================
// Guild Trial engine + plumbing tests.
// Run: cd api && npm test
//   (node --import ./register-loader.js --test tests/)
//
// Covers (see GUILD-TRIALS.md Phase 4):
//   - Monster HP scaling: +1% per participant at tier 100, ×T/100 per tier
//   - Ladder progression: +10 per clear, cap 300
//   - Encounter composition from guildTrialDetailMap
//   - 1-hour simulated cutoff ends the run (timeout)
//   - Wipe ends the trial and records max tier
//   - Clearing the cap tier (300) ends the run with endReason "completed";
//     no further encounter spawns (single weekly attempt, no re-clears)
//   - Trial mode schedules NO ConsumableTickEvent / EnrageTickEvent /
//     PlayerRespawnEvent; consumables never used; dead players stay dead
//   - Bonus-regen constants (default 0.03, overridable)
//   - Official parry model (trial mode): ≤5 attempts per attack event, the
//     struck target rolls its own parry, a success negates only that target's
//     instance (the cast continues), zero-parry targets consume no attempt;
//     legacy zone/lab model (single roll, cast-break) preserved
//   - Tier progress: Summary.finalTier + finalTierHpRemovedFrac (wipe /
//     timeout / completed), aggregate endedAtTierCount + avgFinalTierHpRemoved
//   - Per-player damage/DPS: Summary.playerDamageDone (attribution via
//     simResult.attacks, damage to enemies only, idle players report 0),
//     aggregate avgPlayerDps + avgPartyDps (endTime-0 guarded)
//   - enemyScale debug knob: effective-level scaling, participant-HP stacking,
//     true-tier ladder, clamping
//   - Rewards + aggregation helpers (completedRate alongside wipe/timeout)
//   - Headless API path (runGuildTrialSimulation)
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GuildTrial = (await import('../../src/combatsimulator/guildTrial.js')).default;
const CombatSimulator = (await import('../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../src/combatsimulator/player.js')).default;
const Monster = (await import('../../src/combatsimulator/monster.js')).default;
const { extractTrialSummary, computeTrialRewards, aggregateTrialResults } =
  await import('../../src/combatsimulator/guildTrialStats.js');
const { runGuildTrialSimulation } = await import('../lib/simulator.js');

// A real captured player DTO (no abilities / weapon — a deliberately weak melee
// auto-attacker, ideal for forcing quick outcomes in integration tests).
const CYCLOPS = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/lab/cyclops.holychikenz.game.json'), 'utf8')
);
const BASE_DTO = CYCLOPS.player.dto;

function makePlayers(n) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const dto = structuredClone(BASE_DTO);
    dto.hrid = `player${i + 1}`; // unique hrids so per-player stats key cleanly
    const p = Player.createFromDTO(dto);
    p.zoneBuffs = [];
    p.extraBuffs = [];
    players.push(p);
  }
  return players;
}

// Superhuman variant: absurd base levels ⇒ the player one-shots any trial
// monster and is effectively unhittable/unkillable, so ladder clears are fast
// and deterministic-in-outcome without pinning Math.random.
function makeSuperPlayers(n) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const dto = structuredClone(BASE_DTO);
    dto.hrid = `super${i + 1}`;
    for (const k of ['staminaLevel', 'intelligenceLevel', 'attackLevel', 'meleeLevel', 'defenseLevel', 'rangedLevel', 'magicLevel']) {
      dto[k] = 1000000;
    }
    const p = Player.createFromDTO(dto);
    p.zoneBuffs = [];
    p.extraBuffs = [];
    players.push(p);
  }
  return players;
}

// Run body with Math.random pinned to a constant.
async function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = orig;
  }
}

// --------------------------------------------------------------------------
// Pure: HP scaling
// --------------------------------------------------------------------------
test('monster HP scales +1% per participant at tier 100', () => {
  const base = new GuildTrial('/guild_combat/chameleon', 100, 0).getEncounter()[0];
  base.updateCombatDetails();
  const baseHp = base.combatDetails.maxHitpoints;

  const scaled = new GuildTrial('/guild_combat/chameleon', 100, 50).getEncounter()[0];
  scaled.updateCombatDetails();

  assert.equal(scaled.combatDetails.maxHitpoints, Math.floor(baseHp * (1 + 0.01 * 50)));
  // pc=0 must be exactly the unscaled value.
  assert.equal(base.trialHpScaleFactor, 1);
});

test('participant HP scaling survives a stat recompute (buff re-applies it)', () => {
  const m = new GuildTrial('/guild_combat/chameleon', 100, 25).getEncounter()[0];
  m.updateCombatDetails();
  const first = m.combatDetails.maxHitpoints;
  m.updateCombatDetails(); // recompute — must not drop or double the scaling
  assert.equal(m.combatDetails.maxHitpoints, first);
});

test('tier maps directly to room level and scales stats by T/100', () => {
  const m100 = new GuildTrial('/guild_combat/chameleon', 100, 0).getEncounter()[0];
  const m200 = new GuildTrial('/guild_combat/chameleon', 200, 0).getEncounter()[0];
  m100.updateCombatDetails();
  m200.updateCombatDetails();

  assert.equal(m100.roomLevel, 100);
  assert.equal(m200.roomLevel, 200);
  assert.equal(m100.difficultyTier, 0);
  // difficultyTier 0 ⇒ staminaLevel scales purely by roomLevel/100.
  assert.ok(Math.abs(m200.staminaLevel - 2 * m100.staminaLevel) < 1e-6);
  assert.ok(m200.combatDetails.maxHitpoints > m100.combatDetails.maxHitpoints);
});

// --------------------------------------------------------------------------
// Pure: ladder + encounter composition
// --------------------------------------------------------------------------
test('ladder advances +10 per clear and caps at 300', () => {
  const gt = new GuildTrial('/guild_combat/badger', 100, 0);
  assert.equal(gt.currentTier, 100);
  assert.equal(gt.maxTierCleared, 0);

  gt.advanceTier();
  assert.equal(gt.currentTier, 110);
  assert.equal(gt.tiersCleared, 1);
  assert.equal(gt.maxTierCleared, 100);

  gt.advanceTier();
  assert.equal(gt.currentTier, 120);
  assert.equal(gt.maxTierCleared, 110);

  for (let i = 0; i < 100; i++) gt.advanceTier();
  assert.equal(gt.currentTier, 300); // capped
});

test('encounter composition comes from guildTrialDetailMap', () => {
  const badger = new GuildTrial('/guild_combat/badger', 100, 0).getEncounter();
  assert.deepEqual(badger.map((m) => m.hrid), ['/monsters/trial_badger', '/monsters/trial_badger']);

  const swarm = new GuildTrial('/guild_combat/swarm', 100, 0).getEncounter();
  assert.deepEqual(
    swarm.map((m) => m.hrid),
    ['/monsters/trial_beetle', '/monsters/trial_dragonfly', '/monsters/trial_wasp', '/monsters/trial_firefly']
  );
});

test('constructor defaults + guards', () => {
  const d = new GuildTrial('/guild_combat/jellyfish');
  assert.equal(d.startTier, 100);
  assert.equal(d.participantCount, 1);
  assert.throws(() => new GuildTrial('/guild_combat/does_not_exist'));
  assert.throws(() => new GuildTrial('/guild_skilling/cooking')); // skilling trial has no monsters
});

test('bonus regen constants default to 0.03 and are overridable', () => {
  const def = new GuildTrial('/guild_combat/badger', 100, 5);
  assert.equal(def.bonusHpRegenRatio, 0.03);
  assert.equal(def.bonusMpRegenRatio, 0.03);

  const ov = new GuildTrial('/guild_combat/badger', 100, 5, {
    bonusHpRegenRatio: 0.1,
    bonusMpRegenRatio: 0.05,
  });
  assert.equal(ov.bonusHpRegenRatio, 0.1);
  assert.equal(ov.bonusMpRegenRatio, 0.05);
});

// --------------------------------------------------------------------------
// enemyScale debug knob
// --------------------------------------------------------------------------
test('enemyScale 0.5 at tier 100 constructs monsters identical to an unscaled level-50 build', () => {
  const scaled = new GuildTrial('/guild_combat/chameleon', 100, 0, { enemyScale: 0.5 }).getEncounter()[0];
  scaled.updateCombatDetails();

  const reference = new Monster('/monsters/trial_chameleon', 0, 50);
  reference.updateCombatDetails();

  // Same effective room level ⇒ same stats in EVERY respect.
  assert.equal(scaled.roomLevel, 50);
  assert.equal(scaled.combatDetails.maxHitpoints, reference.combatDetails.maxHitpoints);
  assert.equal(scaled.staminaLevel, reference.staminaLevel);
  assert.equal(scaled.attackLevel, reference.attackLevel);
  assert.equal(scaled.combatDetails.totalArmor, reference.combatDetails.totalArmor);
  assert.deepEqual(
    scaled.abilities.filter(Boolean).map((a) => a.level),
    reference.abilities.filter(Boolean).map((a) => a.level)
  );
});

test('enemyScale: participant HP scaling stacks on top; ladder keeps the true tier', () => {
  // participantCount 50 ⇒ ×1.5 HP applied AFTER the effective-level scaling.
  const base = new GuildTrial('/guild_combat/chameleon', 100, 0, { enemyScale: 0.5 }).getEncounter()[0];
  base.updateCombatDetails();
  const scaled = new GuildTrial('/guild_combat/chameleon', 100, 50, { enemyScale: 0.5 }).getEncounter()[0];
  scaled.updateCombatDetails();
  assert.equal(scaled.combatDetails.maxHitpoints, Math.floor(base.combatDetails.maxHitpoints * 1.5));

  // The ladder itself is untouched by enemyScale: true tier advances 100→110,
  // while the spawned monsters use the scaled effective level.
  const gt = new GuildTrial('/guild_combat/chameleon', 100, 0, { enemyScale: 0.5 });
  gt.getEncounter();
  gt.advanceTier();
  assert.equal(gt.currentTier, 110);
  assert.equal(gt.getEncounter()[0].roomLevel, 55); // round(110 × 0.5)
});

test('enemyScale clamps to [0.05, 5] and falls back to 1 on garbage', () => {
  const opts = (enemyScale) => new GuildTrial('/guild_combat/badger', 100, 0, { enemyScale }).enemyScale;
  assert.equal(opts(undefined), 1);
  assert.equal(opts('nonsense'), 1);
  assert.equal(opts(-2), 1);
  assert.equal(opts(0.001), 0.05);
  assert.equal(opts(100), 5);
  assert.equal(opts(0.8), 0.8);
});

// --------------------------------------------------------------------------
// Integration: 1-hour cutoff
// --------------------------------------------------------------------------
test('1-hour simulated cutoff ends the run (stalemate ⇒ timeout)', async () => {
  const players = makePlayers(2);
  const gt = new GuildTrial('/guild_combat/chameleon', 100, 5);
  const sim = new CombatSimulator(players, null, null, { guildTrial: gt });

  // random ≈ 1 ⇒ every hit/crit roll fails (hitChance & critChance are always
  // < 1), so no damage ever lands: neither side dies ⇒ the run reaches the cap.
  const result = await withRandom(0.9999999999, () =>
    sim.simulate(10 * GuildTrial.TRIAL_DURATION_NS)
  );

  assert.equal(result.isGuildTrial, true);
  assert.equal(result.trialEndReason, 'timeout');
  assert.ok(result.simulatedTime >= GuildTrial.TRIAL_DURATION_NS);
  assert.ok(result.simulatedTime < GuildTrial.TRIAL_DURATION_NS + 5e9); // stopped right at the cap
  assert.equal(result.trialMaxTierCleared, 0);

  // Tier progress on a mid-encounter timeout: still on the start tier, and —
  // in this stalemate, where every roll misses — exactly 0 HP removed.
  const summary = extractTrialSummary(result);
  assert.equal(summary.finalTier, 100);
  assert.equal(summary.finalTierHpRemovedFrac, 0);
});

// --------------------------------------------------------------------------
// Integration: wipe + no forbidden events + dead-stay-dead
// --------------------------------------------------------------------------
test('wipe ends the trial, records outcome, and schedules no forbidden events', async () => {
  const players = makePlayers(2);
  // Huge participant count ⇒ monster HP is unkillable, so the party cannot
  // advance; the monster grinds them down. High tier ⇒ big incoming damage.
  const gt = new GuildTrial('/guild_combat/chameleon', 300, 100000);
  const sim = new CombatSimulator(players, null, null, { guildTrial: gt });

  const seenTypes = new Set();
  const origAdd = sim.eventQueue.addEvent.bind(sim.eventQueue);
  sim.eventQueue.addEvent = (e) => {
    seenTypes.add(e.type);
    return origAdd(e);
  };

  // random = 0 ⇒ every hit/crit lands: the monster reliably kills the party.
  const result = await withRandom(0, () => sim.simulate(GuildTrial.TRIAL_DURATION_NS));

  assert.equal(result.trialEndReason, 'wipe');
  assert.ok(result.simulatedTime < GuildTrial.TRIAL_DURATION_NS, 'wipe ends before the 1h cap');

  // No consumables, no enrage, no player respawn — ever.
  assert.equal(seenTypes.has('consumableTick'), false, 'no ConsumableTickEvent');
  assert.equal(seenTypes.has('enrageTick'), false, 'no EnrageTickEvent');
  assert.equal(seenTypes.has('playerRespawn'), false, 'no PlayerRespawnEvent');

  // Consumables never used despite the DTO carrying food & drinks.
  assert.deepEqual(result.consumablesUsed, {});

  // Dead players stay dead: all HP <= 0 at wipe, and each death recorded once.
  for (const p of players) {
    assert.ok(p.combatDetails.currentHitpoints <= 0);
  }
  const deathTiers = Object.values(result.trialPlayerDeaths).flat();
  assert.ok(deathTiers.length >= 1);
  assert.ok(deathTiers.every((t) => t === 300)); // wiped on the (only) tier 300

  // Tier progress on a mid-encounter wipe: finalTier is the start tier, and
  // the HP-removed fraction is strictly between 0 and 1 (players landed hits
  // — random=0 always hits — but the 100000-participant HP pool is huge) and
  // must match the live encounter state exactly. The wipe path does not null
  // sim.enemies, so hand-check against the monster's actual HP.
  const summary = extractTrialSummary(result);
  assert.equal(summary.finalTier, 300);
  const mob = sim.enemies[0].combatDetails;
  const expectedFrac = (mob.maxHitpoints - mob.currentHitpoints) / mob.maxHitpoints;
  assert.ok(summary.finalTierHpRemovedFrac > 0, 'players removed some HP');
  assert.ok(summary.finalTierHpRemovedFrac < 1, 'encounter was not cleared');
  assert.ok(Math.abs(summary.finalTierHpRemovedFrac - expectedFrac) < 1e-12,
    'fraction matches the live encounter HP state');
});

// --------------------------------------------------------------------------
// Integration: clearing the cap tier COMPLETES the run (no re-clears)
// --------------------------------------------------------------------------
test('clearing the cap tier (300) ends the run with endReason "completed" and spawns no further encounter', async () => {
  const players = makeSuperPlayers(1);
  const gt = new GuildTrial('/guild_combat/chameleon', 300, 1);
  const sim = new CombatSimulator(players, null, null, { guildTrial: gt });

  const result = await sim.simulate(GuildTrial.TRIAL_DURATION_NS);

  assert.equal(result.trialEndReason, 'completed');
  assert.equal(result.trialMaxTierCleared, 300);
  assert.equal(result.trialTiersCleared, 1);
  // Single weekly attempt, no re-clear of any tier: exactly ONE encounter was
  // ever spawned — clearing 300 must not respawn it.
  assert.equal(gt.encounterCount, 1);
  assert.ok(result.simulatedTime < GuildTrial.TRIAL_DURATION_NS, 'completed well before the 1h cap');

  // Tier progress on completion: the just-cleared cap tier at exactly 1.0.
  const summary = extractTrialSummary(result);
  assert.equal(summary.finalTier, 300);
  assert.equal(summary.finalTierHpRemovedFrac, 1);
});

test('full ladder from 100 completes at the cap after 21 distinct tiers, one encounter each', async () => {
  const players = makeSuperPlayers(1);
  const gt = new GuildTrial('/guild_combat/chameleon', 100, 1);
  const sim = new CombatSimulator(players, null, null, { guildTrial: gt });

  const result = await sim.simulate(GuildTrial.TRIAL_DURATION_NS);

  assert.equal(result.trialEndReason, 'completed');
  assert.equal(result.trialMaxTierCleared, 300);
  assert.equal(result.trialTiersCleared, 21); // 100,110,...,300 — each fought once
  assert.equal(gt.encounterCount, 21);
  assert.equal(Object.keys(result.trialTierTimes).length, 21);
});

// --------------------------------------------------------------------------
// Per-player damage / DPS
// --------------------------------------------------------------------------
test('playerDamageDone attributes the kill to the killer; idle players report 0', async () => {
  // super1 one-shots the tier-300 monster within milliseconds; the weak
  // player1 (attack interval ~3 s) never gets a swing off.
  const players = [makeSuperPlayers(1)[0], makePlayers(1)[0]];
  const gt = new GuildTrial('/guild_combat/chameleon', 300, 2);
  const sim = new CombatSimulator(players, null, null, { guildTrial: gt });

  const result = await sim.simulate(GuildTrial.TRIAL_DURATION_NS);
  assert.equal(result.trialEndReason, 'completed');

  const summary = extractTrialSummary(result);

  // Roster completeness: every player appears, even with zero damage.
  assert.deepEqual(Object.keys(summary.playerDamageDone).sort(), ['player1', 'super1']);
  assert.equal(summary.playerDamageDone.player1, 0);

  // The killer's total is at least the encounter's total max HP (per-hit
  // damage is capped at remaining HP, so the sum equals HP removed; ≥ guards
  // any monster self-healing).
  const reference = new GuildTrial('/guild_combat/chameleon', 300, 2).getEncounter()[0];
  reference.updateCombatDetails();
  assert.ok(summary.playerDamageDone.super1 >= reference.combatDetails.maxHitpoints,
    `super1 dealt ${summary.playerDamageDone.super1}, encounter max HP ${reference.combatDetails.maxHitpoints}`);

  // Single-iteration aggregate: DPS = damage / endTimeSeconds.
  const agg = aggregateTrialResults([summary], { startTier: 300 });
  const endSeconds = summary.endTime / 1e9;
  assert.ok(endSeconds > 0);
  assert.ok(Math.abs(agg.avgPlayerDps.super1 - summary.playerDamageDone.super1 / endSeconds) < 1e-9);
  assert.equal(agg.avgPlayerDps.player1, 0);
  assert.ok(Math.abs(agg.avgPartyDps - summary.playerDamageDone.super1 / endSeconds) < 1e-9);
});

test('avgPlayerDps / avgPartyDps: hand-checked means; endTime 0 contributes 0', () => {
  const base = { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', finalTier: 100, finalTierHpRemovedFrac: 0.5, tierTimes: {}, playerDeaths: {} };
  const summaries = [
    { ...base, endTime: 10e9, playerDamageDone: { a: 1000, b: 500 } }, // a:100, b:50, party:150
    { ...base, endTime: 20e9, playerDamageDone: { a: 4000 } },         // a:200, party:200
    { ...base, endTime: 0, playerDamageDone: { a: 999999 } },          // guarded: contributes 0
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  assert.ok(Math.abs(agg.avgPlayerDps.a - (100 + 200 + 0) / 3) < 1e-12);
  assert.ok(Math.abs(agg.avgPlayerDps.b - (50 + 0 + 0) / 3) < 1e-12);
  assert.ok(Math.abs(agg.avgPartyDps - (150 + 200 + 0) / 3) < 1e-12);
});

// --------------------------------------------------------------------------
// Parry: official model (trial) vs legacy model (zone/lab)
// --------------------------------------------------------------------------

// Direct-drive harness for processAbilityDamageEffect: n players (each with an
// explicit parry stat) vs one trial monster casting an AoE. Bypasses the event
// loop so a single cast can be inspected in isolation.
function makeParrySetup({ trial, parries }) {
  const players = [];
  parries.forEach((parry, i) => {
    const dto = structuredClone(BASE_DTO);
    dto.hrid = `pp${i + 1}`;
    const p = Player.createFromDTO(dto);
    p.zoneBuffs = [];
    p.extraBuffs = [];
    p.generatePermanentBuffs();
    p.reset();
    p.combatDetails.combatStats.parry = parry;
    players.push(p);
  });

  const opts = trial ? { guildTrial: new GuildTrial('/guild_combat/chameleon', 100, 0) } : {};
  const sim = new CombatSimulator(players, null, null, opts);

  const monster = new GuildTrial('/guild_combat/chameleon', 100, 0).getEncounter()[0];
  monster.reset(0);
  // Bullet-proof the monster against parry counters so mid-cast death paths
  // (which expect event-loop bookkeeping) never trigger in this harness.
  monster.combatDetails.currentHitpoints = 1e9;

  sim.enemies = [monster];
  sim.simulationTime = 0;
  return { sim, players, monster };
}

const AOE_ABILITY = { hrid: '/abilities/test_aoe' };
const AOE_EFFECT = {
  effectType: '/ability_effect_types/damage',
  targetType: 'allEnemies',
  combatStyleHrid: '/combat_styles/smash',
  damageType: '/damage_types/physical',
  bonusAccuracyRatio: 0,
  damageFlat: 10,
  damageRatio: 1,
  armorDamageRatio: 0,
  damageOverTimeRatio: 0,
  stunChance: 0,
  blindChance: 0,
  silenceChance: 0,
  pierceChance: 0,
};

function parriedPlayers(sim, players, monster) {
  return players.filter((p) => sim.simResult.attacks[p.hrid]?.[monster.hrid]?.parry);
}

function damagedPlayers(sim, players, monster) {
  return players.filter((p) => sim.simResult.attacks[monster.hrid]?.[p.hrid]?.[AOE_ABILITY.hrid]);
}

test('official parry (trial): an AoE onto 8 parry-capable players makes exactly 5 attempts, in hit order', () => {
  // parry = 1.0 ⇒ every ATTEMPT succeeds, so successful parries === attempts.
  const { sim, players, monster } = makeParrySetup({ trial: true, parries: Array(8).fill(1.0) });

  sim.processAbilityDamageEffect(monster, AOE_ABILITY, AOE_EFFECT);

  const parried = parriedPlayers(sim, players, monster);
  // Exactly MAX_PARRY_ATTEMPTS = 5 attempts — targets 6-8 got no roll.
  assert.equal(parried.length, 5);
  // Attempts are consumed in hit order: the first five players in the array.
  assert.deepEqual(parried.map((p) => p.hrid), players.slice(0, 5).map((p) => p.hrid));
});

test('official parry (trial): a parry negates only that target\'s instance — the cast is NOT broken', () => {
  const { sim, players, monster } = makeParrySetup({ trial: true, parries: Array(8).fill(1.0) });

  sim.processAbilityDamageEffect(monster, AOE_ABILITY, AOE_EFFECT);

  // The five parriers took no damage instance from the cast...
  for (const p of players.slice(0, 5)) {
    assert.equal(sim.simResult.attacks[monster.hrid]?.[p.hrid], undefined,
      `${p.hrid} parried — must have no incoming damage instance`);
  }
  // ...while the remaining three still received theirs (hit or miss, the
  // instance was processed) — several targets each parried with their own
  // counter within the budget.
  const damaged = damagedPlayers(sim, players, monster);
  assert.deepEqual(damaged.map((p) => p.hrid), players.slice(5).map((p) => p.hrid));
});

test('official parry (trial): zero-parry targets consume no attempts', () => {
  // First 6 players cannot parry; last 2 can. If zero-parry targets consumed
  // attempts, the budget (5) would be gone before players 7-8 were struck.
  const { sim, players, monster } = makeParrySetup({ trial: true, parries: [0, 0, 0, 0, 0, 0, 1.0, 1.0] });

  sim.processAbilityDamageEffect(monster, AOE_ABILITY, AOE_EFFECT);

  const parried = parriedPlayers(sim, players, monster);
  assert.deepEqual(parried.map((p) => p.hrid), [players[6].hrid, players[7].hrid]);
  // The six zero-parry players all received their damage instance.
  const damaged = damagedPlayers(sim, players, monster);
  assert.deepEqual(damaged.map((p) => p.hrid), players.slice(0, 6).map((p) => p.hrid));
});

test('legacy parry (zone/lab): single roll, a success breaks the whole cast', () => {
  // No guildTrial ⇒ legacy model. All 8 can parry at 1.0: the single random
  // roll succeeds ⇒ exactly ONE parry counter and NOBODY takes a damage
  // instance (the cast broke).
  const { sim, players, monster } = makeParrySetup({ trial: false, parries: Array(8).fill(1.0) });

  sim.processAbilityDamageEffect(monster, AOE_ABILITY, AOE_EFFECT);

  const parried = parriedPlayers(sim, players, monster);
  assert.equal(parried.length, 1);
  assert.equal(sim.simResult.attacks[monster.hrid], undefined, 'legacy cast-break: no damage instances');
});

// --------------------------------------------------------------------------
// Pure: rewards + aggregation
// --------------------------------------------------------------------------
test('computeTrialRewards: base ladder + multipliers', () => {
  assert.deepEqual(computeTrialRewards(0), { points: 0, tokensPerParticipant: 0 });
  assert.deepEqual(computeTrialRewards(1), { points: 400, tokensPerParticipant: 200 });
  assert.deepEqual(computeTrialRewards(3), { points: 800, tokensPerParticipant: 400 });

  const rw = computeTrialRewards(2, { buildersHallBonus: 0.5, treasuryBonus: 1.0 });
  assert.equal(rw.points, 600 * 1.5);
  assert.equal(rw.tokensPerParticipant, 300 * 2.0);
});

test('aggregateTrialResults: per-tier clear probability + distribution', () => {
  const summaries = [
    { maxTierCleared: 100, tiersCleared: 1, endReason: 'wipe', tierTimes: { 100: 5e9 }, playerDeaths: { a: [110] } },
    { maxTierCleared: 120, tiersCleared: 3, endReason: 'timeout', tierTimes: { 100: 4e9, 110: 6e9, 120: 8e9 }, playerDeaths: {} },
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  assert.equal(agg.iterations, 2);
  assert.equal(agg.perTierClearProbability[100], 1.0);
  assert.equal(agg.perTierClearProbability[110], 0.5);
  assert.equal(agg.perTierClearProbability[120], 0.5);
  assert.equal(agg.wipeRate, 0.5);
  assert.equal(agg.timeoutRate, 0.5);
  assert.equal(agg.completedRate, 0);
  assert.equal(agg.maxTierDistribution[100], 1);
  assert.equal(agg.maxTierDistribution[120], 1);
  assert.equal(agg.expectedMaxTierCleared, (100 + 120) / 2);
  assert.equal(agg.deathsByTier[110], 1);
  // rewards: iter1 tiersCleared=1 ⇒ 400pts; iter2 tiersCleared=3 ⇒ 800pts
  assert.equal(agg.expectedGuildPoints, (400 + 800) / 2);
});

test('aggregateTrialResults reports completedRate; end-reason rates sum to 1', () => {
  const summaries = [
    { maxTierCleared: 300, tiersCleared: 21, endReason: 'completed', tierTimes: {}, playerDeaths: {} },
    { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', tierTimes: {}, playerDeaths: {} },
    { maxTierCleared: 110, tiersCleared: 2, endReason: 'timeout', tierTimes: {}, playerDeaths: {} },
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  assert.equal(agg.completedRate, 1 / 3);
  assert.equal(agg.wipeRate, 1 / 3);
  assert.equal(agg.timeoutRate, 1 / 3);
  assert.ok(Math.abs(agg.wipeRate + agg.timeoutRate + agg.completedRate - 1) < 1e-12);
  // Completed run pays for all 21 tiers: 400 + 200×20 = 4400 base points.
  assert.equal(agg.expectedGuildPoints, (4400 + 0 + 600) / 3);
});

test('aggregateTrialResults buckets avgFinalTierHpRemoved and endedAtTierCount by finalTier', () => {
  const summaries = [
    { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', finalTier: 100, finalTierHpRemovedFrac: 0.2, tierTimes: {}, playerDeaths: {} },
    { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', finalTier: 100, finalTierHpRemovedFrac: 0.8, tierTimes: {}, playerDeaths: {} },
    { maxTierCleared: 100, tiersCleared: 1, endReason: 'timeout', finalTier: 110, finalTierHpRemovedFrac: 0.5, tierTimes: { 100: 1e9 }, playerDeaths: {} },
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  // Runs that ENDED at each tier (distinct from maxTierDistribution, which
  // buckets by highest CLEARED tier: {0: 2, 100: 1} here).
  assert.deepEqual(agg.endedAtTierCount, { 100: 2, 110: 1 });
  assert.equal(agg.avgFinalTierHpRemoved[100], (0.2 + 0.8) / 2);
  assert.equal(agg.avgFinalTierHpRemoved[110], 0.5);
  assert.equal(agg.maxTierDistribution[0], 2);
  assert.equal(agg.maxTierDistribution[100], 1);
});

test('aggregateTrialResults handles empty input', () => {
  const agg = aggregateTrialResults([], {});
  assert.equal(agg.iterations, 0);
  assert.equal(agg.expectedMaxTierCleared, 0);
  assert.equal(agg.completedRate, 0);
  assert.deepEqual(agg.endedAtTierCount, {});
  assert.deepEqual(agg.avgFinalTierHpRemoved, {});
  assert.deepEqual(agg.avgPlayerDps, {});
  assert.equal(agg.avgPartyDps, 0);
});

// --------------------------------------------------------------------------
// Integration: headless API path
// --------------------------------------------------------------------------
test('runGuildTrialSimulation aggregates multiple iterations', async () => {
  const result = await withRandom(0, () =>
    runGuildTrialSimulation({
      players: [{ ...structuredClone(BASE_DTO), hrid: 'p1' }, { ...structuredClone(BASE_DTO), hrid: 'p2' }],
      trialHrid: '/guild_combat/chameleon',
      startTier: 300,
      participantCount: 100000, // unkillable monster ⇒ fast, deterministic wipes
      iterations: 3,
    })
  );

  assert.equal(result.summaries.length, 3);
  assert.equal(result.aggregate.iterations, 3);
  assert.equal(result.aggregate.wipeRate, 1.0);
  assert.equal(result.aggregate.expectedMaxTierCleared, 0);
});
