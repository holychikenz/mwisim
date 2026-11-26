// =============================================================================
// Guild trial plumbing tests: the summary and aggregation (shared/guildTrialStats.js),
// rewards, and the headless API path (runGuildTrialSimulation) on the twin.
// Run: cd api && npm test
//
// The trial engine itself (participant scaling, ladder, parry model, enemyScale,
// timeouts, wipes, per-tier resets) lives in rust/src/guild_trial.rs and
// simulator.rs; twin:check holds it bit for bit to goldens frozen on the retired
// JS engine (badger x3, swarm, jellyfish cases).
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { extractTrialSummary, computeTrialRewards, aggregateTrialResults } =
  await import('../../shared/guildTrialStats.js');
const { runGuildTrialSimulation } = await import('../lib/simulator.js');
const { getTwinBackend, runTwin, twinTrialRequest } = await import('../../shared/twinEngine.js');
const { playerDetails } = await import('../lib/unitDetails.js');

// A real captured player DTO (no abilities / weapon — a deliberately weak melee
// auto-attacker, ideal for forcing quick outcomes in integration tests).
const CYCLOPS = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/lab/cyclops.holychikenz.game.json'), 'utf8')
);
const BASE_DTO = CYCLOPS.player.dto;

const dto = (hrid) => ({ ...structuredClone(BASE_DTO), hrid });

// Superhuman variant: absurd base levels ⇒ the player one-shots any trial
// monster and is effectively unhittable/unkillable.
function superDto(hrid) {
  const d = dto(hrid);
  for (const k of ['staminaLevel', 'intelligenceLevel', 'attackLevel', 'meleeLevel', 'defenseLevel', 'rangedLevel', 'magicLevel']) d[k] = 1000000;
  return d;
}

/** One full trial on the twin; resolves to its SimResult. */
const trialRun = (players, trialHrid, startTier, participantCount) =>
  runTwin(getTwinBackend(), twinTrialRequest({ players, trialHrid, startTier, participantCount, trialOptions: {} }));

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

test('audit3-14: a start tier off the 100..300 ladder is a RangeError', async () => {
  await assert.rejects(
    runGuildTrialSimulation({ players: [], trialHrid: '/guild_combat/jellyfish', startTier: '100', iterations: 1 }),
    RangeError
  );
  for (const startTier of [105, 90, 310]) {
    await assert.rejects(runGuildTrialSimulation({ players: [dto('p1')], trialHrid: '/guild_combat/jellyfish', startTier, iterations: 1 }), RangeError, String(startTier));
  }
});

// --------------------------------------------------------------------------
// Per-player damage and healing attribution, on real twin output
// --------------------------------------------------------------------------
test('playerDamageDone attributes the kill to the killer; idle players report 0', async () => {
  // super1 one-shots the tier-300 monster within milliseconds; the weak
  // player1 (attack interval ~3 s) never gets a swing off.
  const result = await trialRun([superDto('super1'), dto('player1')], '/guild_combat/chameleon', 300, 2);
  assert.equal(result.trialEndReason, 'completed');

  const summary = extractTrialSummary(result);

  // Roster completeness: every player appears, even with zero damage.
  assert.deepEqual(Object.keys(summary.playerDamageDone).sort(), ['player1', 'super1']);
  assert.equal(summary.playerDamageDone.player1, 0);
  assert.ok(summary.playerDamageDone.super1 > 0);

  // Single-iteration aggregate: DPS = damage / endTimeSeconds.
  const agg = aggregateTrialResults([summary], { startTier: 300 });
  const endSeconds = summary.endTime / 1e9;
  assert.ok(endSeconds > 0);
  assert.ok(Math.abs(agg.avgPlayerDps.super1 - summary.playerDamageDone.super1 / endSeconds) < 1e-9);
  assert.equal(agg.avgPlayerDps.player1, 0);
  assert.ok(Math.abs(agg.avgPartyDps - summary.playerDamageDone.super1 / endSeconds) < 1e-9);
});

// healingDone is keyed by the HEALER, hitpointsGained by the RECEIVER. These
// are different questions and must give different answers. The healer has
// /abilities/quick_aid (targetType "lowestHpAlly") as its only ability, so the
// only healing it does is to a party member.
test('healing is attributed to the healer, not the unit that received it', async () => {
  const healer = dto('healer1');
  healer.abilities = [{ hrid: '/abilities/quick_aid', level: 100, triggers: [] }];
  for (const k of Object.keys(healer)) if (k.endsWith('Level')) healer[k] = 200; // enough MP/int to actually cast
  const result = await trialRun([healer, dto('player1')], '/guild_combat/chameleon', 100, 5);

  const healerHeal = result.healingDone?.healer1?.['/abilities/quick_aid'] ?? 0;
  assert.ok(healerHeal > 0, `healer did no quick_aid healing (healingDone=${JSON.stringify(result.healingDone)})`);

  const summary = extractTrialSummary(result);
  assert.ok(summary.playerHealingDone.healer1 > 0);
  assert.equal(summary.playerHealingDone.player1, 0);

  // ...even though player1 is exactly who RECEIVED healing.
  const tankReceived = Object.values(result.hitpointsGained?.player1 ?? {}).reduce((a, b) => a + b, 0);
  assert.ok(tankReceived > 0, 'tank received no healing — fixture did not exercise the path');
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
// Pure: rewards + aggregation
// --------------------------------------------------------------------------
test('computeTrialRewards: base ladder + multipliers', () => {
  // 7/15/2026 payout model: every eligible member gets 50% of the BASE Guild
  // Points (pre-Builders'-Hall) × Treasury; signed-up members get +50% of that.
  assert.deepEqual(computeTrialRewards(0), {
    points: 0,
    tokensPerEligibleMember: 0,
    tokensPerParticipant: 0,
  });
  assert.deepEqual(computeTrialRewards(1), {
    points: 400,
    tokensPerEligibleMember: 200,
    tokensPerParticipant: 300,
  });
  assert.deepEqual(computeTrialRewards(3), {
    points: 800,
    tokensPerEligibleMember: 400,
    tokensPerParticipant: 600,
  });

  const rw = computeTrialRewards(2, { buildersHallBonus: 0.5, treasuryBonus: 1.0 });
  assert.equal(rw.points, 600 * 1.5); // 900 — Builders' Hall boosts POINTS only
  assert.equal(rw.tokensPerEligibleMember, 0.5 * 600 * 2.0); // 600 — Treasury boosts tokens
  assert.equal(rw.tokensPerParticipant, 600 * 1.5); // 900 — +50% participation bonus
});


test('unfinished tiers pay half their reward proportional to progress, including the first tier', () => {
  assert.deepEqual(computeTrialRewards(0, { finalTierHpRemovedFrac: 0.5 }), {
    points: 100, tokensPerEligibleMember: 50, tokensPerParticipant: 75,
  });
  assert.deepEqual(computeTrialRewards(2, {
    finalTierHpRemovedFrac: 0.75, buildersHallBonus: 0.5, treasuryBonus: 1,
  }), { points: 1012.5, tokensPerEligibleMember: 675, tokensPerParticipant: 1012.5 });
  const partial = aggregateTrialResults([{ maxTierCleared: 100, tiersCleared: 1,
    finalTier: 110, finalTierHpRemovedFrac: 0.5, endReason: 'timeout' }]);
  assert.equal(partial.expectedGuildPoints, 450);
  const completed = aggregateTrialResults([{ maxTierCleared: 300, tiersCleared: 21,
    finalTier: 300, finalTierHpRemovedFrac: 1, endReason: 'completed' }]);
  assert.equal(completed.expectedGuildPoints, 4400, 'cap tier is paid once');
});


test('headless trial keeps personal buffs separate and applies shared buffs once', async () => {
  const hpBuff = (name, flatBoost) => ({ uniqueHrid: `/test/${name}`,
    typeHrid: '/buff_types/max_hitpoints', flatBoost, ratioBoost: 0, duration: 0 });
  const bare = { ...structuredClone(BASE_DTO), equipment: {}, houseRooms: {}, achievements: {} };
  const dtos = [100, 300].map((amount, i) => ({ ...structuredClone(bare),
    hrid: `personal${i}`, extraBuffs: [hpBuff(`personal${i}`, amount)] }));
  const shared = hpBuff('shared', 50);
  // The request the twin gets: the shared buff once as a party buff, each member's own on its DTO.
  const twin = getTwinBackend();
  let request;
  const spy = { run: (json, onProgress) => { request = JSON.parse(json); return twin.run(json, onProgress); } };
  const { setTwinBackend } = await import('../../shared/twinEngine.js');
  setTwinBackend(spy);
  try {
    await runGuildTrialSimulation({ players: dtos, trialHrid: '/guild_combat/badger',
      guildBuffs: [shared], iterations: 1 });
  } finally { setTwinBackend(twin); }
  assert.deepEqual(request.partyBuffs, [shared]);
  assert.deepEqual(request.players.map((p) => p.extraBuffs), dtos.map((d) => d.extraBuffs));
  // And what that composes to: the party buff once, each member's own on top.
  const [plain] = playerDetails([bare], { zoneBuffs: [], partyBuffs: [] });
  const got = playerDetails(dtos, { zoneBuffs: [], partyBuffs: [shared] }).map((d) => d.combatDetails.maxHitpoints);
  assert.deepEqual(got, [plain.combatDetails.maxHitpoints + 150, plain.combatDetails.maxHitpoints + 350]);
  assert.deepEqual(dtos.map(d => d.extraBuffs.length), [1, 1], 'caller DTOs are not mutated');
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
  // tokens (7/15/2026 model): eligible = 50% of base points; participant ×1.5.
  // iter1 base 400 ⇒ elig 200 / part 300; iter2 base 800 ⇒ elig 400 / part 600.
  assert.equal(agg.expectedTokensPerEligibleMember, (200 + 400) / 2);
  assert.equal(agg.expectedTokensPerParticipant, (300 + 600) / 2);
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
  assert.equal(agg.expectedTokensPerEligibleMember, 0);
  assert.equal(agg.expectedTokensPerParticipant, 0);
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


test('audit2-14: runGuildTrialSimulation refuses a non-positive or fractional iteration count', async () => {
  for (const iterations of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      runGuildTrialSimulation({ players: [structuredClone(BASE_DTO)], trialHrid: '/guild_combat/chameleon', iterations }),
      RangeError,
      String(iterations)
    );
  }
});


test('audit2-14: the UI cleans a saved or imported iteration count before running', async () => {
  const { trialIterations, DEFAULT_TRIAL_CONFIG } = await import('../../ui/src/utils/roster.js');
  for (const iterations of ['', 0, -3, 1.5, NaN, null, undefined, '50']) {
    assert.equal(trialIterations({ iterations }), DEFAULT_TRIAL_CONFIG.iterations, String(iterations));
  }
  assert.equal(trialIterations({ iterations: 250 }), 250);
});

test('a saved or imported decimal participant count is rounded before it reaches the engine', async () => {
  const { trialParticipants } = await import('../../ui/src/utils/roster.js');
  assert.equal(trialParticipants({ participantCount: 30.5 }, 7), 31);
  assert.equal(trialParticipants({ participantCount: 0.2 }, 7), 1);
  assert.equal(trialParticipants({ participantCount: null }, 7), 7);
  assert.equal(trialParticipants({}, 7), 7);
});


// --------------------------------------------------------------------------
// Healing summary filter
// --------------------------------------------------------------------------
test('self-upkeep (regen, lifesteal, consumables) is excluded from playerHealingDone', () => {
  // Raw healingDone records every source; the summary filter drops the ones
  // that are a unit keeping itself alive rather than healing the party.
  const simResult = {
    manaUsed: { solo1: 0 },
    attacks: {},
    healingDone: {
      solo1: {
        regen: 500,
        lifesteal: 250,
        '/items/marsberry_donut': 300,   // consumable — self-upkeep by prefix
        '/abilities/quick_aid': 42,          // genuine output to the party
      },
    },
  };

  const summary = extractTrialSummary(simResult);
  assert.equal(summary.playerHealingDone.solo1, 42);

  // The raw data is untouched — the exclusion lives only at the summary layer.
  assert.equal(simResult.healingDone.solo1.regen, 500);
  assert.equal(simResult.healingDone.solo1.lifesteal, 250);
});


test('a lone regenerating player reports zero healing done', () => {
  const simResult = {
    manaUsed: { solo1: 0 },
    attacks: {},
    healingDone: { solo1: { regen: 1234 } },
  };
  assert.equal(extractTrialSummary(simResult).playerHealingDone.solo1, 0);
});


// --------------------------------------------------------------------------
// Totals are NOT reconstructible from rates
// --------------------------------------------------------------------------
test('avgPlayerDamage is the mean of per-iteration TOTALS, not rate x mean duration', () => {
  const base = { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', finalTier: 100, finalTierHpRemovedFrac: 0, tierTimes: {}, playerDeaths: {} };
  // Durations and damage correlate hard, so the mean-of-rates and the
  // mean-of-totals genuinely disagree (Jensen). This is what makes the
  // assertion below meaningful rather than a coincidental match.
  const summaries = [
    { ...base, endTime: 1e9,   playerDamageDone: { a: 100 },   playerHealingDone: { a: 10 } },
    { ...base, endTime: 100e9, playerDamageDone: { a: 50000 }, playerHealingDone: { a: 90 } },
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  const meanTotal = (100 + 50000) / 2;
  assert.ok(Math.abs(agg.avgPlayerDamage.a - meanTotal) < 1e-9);
  assert.ok(Math.abs(agg.avgPlayerHealing.a - (10 + 90) / 2) < 1e-9);

  // The invalid reconstruction, shown to be a different number.
  const meanDuration = (1 + 100) / 2;
  const bogus = agg.avgPlayerDps.a * meanDuration;
  assert.ok(Math.abs(bogus - agg.avgPlayerDamage.a) > 1,
    `reconstruction ${bogus} coincidentally matched the true total ${agg.avgPlayerDamage.a}`);
});

test('a degenerate zero-duration iteration still contributes its real total', () => {
  const base = { maxTierCleared: 0, tiersCleared: 0, endReason: 'wipe', finalTier: 100, finalTierHpRemovedFrac: 0, tierTimes: {}, playerDeaths: {} };
  const summaries = [
    { ...base, endTime: 10e9, playerDamageDone: { a: 1000 }, playerHealingDone: {} },
    { ...base, endTime: 0,    playerDamageDone: { a: 500 },  playerHealingDone: {} }, // DPS-guarded, total is not
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  assert.ok(Math.abs(agg.avgPlayerDamage.a - 750) < 1e-9); // (1000 + 500) / 2
  // ...while the pre-existing rate field still guards it as it always did.
  assert.ok(Math.abs(agg.avgPlayerDps.a - 100 / 2) < 1e-9);
});

test('aggregateTrialResults empty case includes the new total fields', () => {
  const agg = aggregateTrialResults([], {});
  assert.deepEqual(agg.avgPlayerDamage, {});
  assert.deepEqual(agg.avgPlayerHealing, {});
});

test('non-regression: the new fields do not disturb the pre-existing ones', () => {
  const base = { maxTierCleared: 100, tiersCleared: 1, endReason: 'wipe', finalTier: 110, finalTierHpRemovedFrac: 0.25, tierTimes: { 100: 5e9 }, playerDeaths: { a: [110] } };
  const summaries = [
    { ...base, endTime: 10e9, playerDamageDone: { a: 1000, b: 500 }, playerHealingDone: { a: 7 } },
    { ...base, endTime: 20e9, playerDamageDone: { a: 4000 },         playerHealingDone: {} },
  ];
  const agg = aggregateTrialResults(summaries, { startTier: 100 });

  // Exactly the values the rate arithmetic produced before this change.
  assert.ok(Math.abs(agg.avgPlayerDps.a - (100 + 200) / 2) < 1e-12);
  assert.ok(Math.abs(agg.avgPlayerDps.b - (50 + 0) / 2) < 1e-12);
  assert.ok(Math.abs(agg.avgPartyDps - (150 + 200) / 2) < 1e-12);
  assert.equal(agg.iterations, 2);
  assert.equal(agg.wipeRate, 1);
  assert.equal(agg.expectedMaxTierCleared, 100);
  assert.deepEqual(agg.endedAtTierCount, { 110: 2 });
  assert.deepEqual(agg.deathsByTier, { 110: 2 });

  // A summary with no playerHealingDone at all (an older/partial record) is
  // tolerated rather than throwing.
  assert.ok(Math.abs(agg.avgPlayerHealing.a - 7 / 2) < 1e-12);
});


test('roster export build ids are stable across exports and unique per (character, loadout)', async () => {
  const { exportBuildId } = await import('../../ui/src/utils/roster.js');
  const pairs = [['c', 'tank 1'], ['c', 'tank_1'], ['c', '坦克'], ['c', 'танк'], ['c~x', 'y'], ['c', 'x~y']];
  const ids = pairs.map(([characterId, loadoutName]) => exportBuildId({ characterId, loadoutName, id: Math.random() }));
  assert.equal(new Set(ids).size, pairs.length);
  assert.deepEqual(pairs.map(([characterId, loadoutName]) => exportBuildId({ characterId, loadoutName })), ids);
});
