// =============================================================================
// guildTrialStats — pure helpers for guild-trial result plumbing.
// -----------------------------------------------------------------------------
// Shared by the browser workers (worker.js / multiWorker.js) and the headless
// API. No DOM / worker globals so it is unit-testable directly under node.
//
//   extractTrialSummary(simResult)      → lightweight per-iteration record
//   computeTrialRewards(tiers, opts)    → { points, tokensPerParticipant }
//   aggregateTrialResults(summaries, o) → cross-iteration statistics
// =============================================================================

import GuildTrial from "./guildTrial";

const ONE_SECOND_NS = 1e9;

/**
 * Total damage `sourceHrid` dealt TO ENEMIES over the run, summed from the
 * engine's attack bookkeeping: simResult.attacks[source][target][ability] is a
 * { [damageValue]: count } histogram ("miss" entries carry no damage). The
 * source key is always the ORIGINAL attacking unit — auto-attacks, ability
 * hits, damage-over-time ticks (DoTs record their sourceRef, so they keep
 * paying a caster who has since died), parry counters, and thorns/retaliation
 * the unit reflects onto monsters all land under it. Targets in
 * `playerHridSet` are skipped so only damage to monsters counts (heals and
 * anything aimed at fellow players never do).
 */
function sumDamageToEnemies(attacks, sourceHrid, playerHridSet) {
    let total = 0;
    const byTarget = attacks?.[sourceHrid];
    if (!byTarget) return 0;
    for (const [targetHrid, byAbility] of Object.entries(byTarget)) {
        if (playerHridSet.has(targetHrid)) continue; // damage TO enemies only
        for (const hits of Object.values(byAbility)) {
            for (const [hit, count] of Object.entries(hits)) {
                if (hit === "miss") continue;
                const damage = Number(hit);
                if (Number.isFinite(damage)) {
                    total += damage * count;
                }
            }
        }
    }
    return total;
}

/**
 * Pull the small, serialisable trial fields out of a full SimResult so many
 * iterations can be shuttled between workers cheaply.
 */
export function extractTrialSummary(simResult) {
    // Per-player total damage dealt to enemies over the whole run (all tiers,
    // no per-tier/per-ability splits — keep the summary cheap). The roster's
    // hrids come from simResult.manaUsed, which simulate() populates
    // unconditionally for EVERY player — so players who dealt no damage still
    // appear, with 0.
    const playerHrids = Object.keys(simResult.manaUsed || {});
    const playerHridSet = new Set(playerHrids);
    const playerDamageDone = {};
    for (const hrid of playerHrids) {
        playerDamageDone[hrid] = sumDamageToEnemies(simResult.attacks, hrid, playerHridSet);
    }

    return {
        maxTierCleared: simResult.trialMaxTierCleared ?? 0,
        tiersCleared: simResult.trialTiersCleared ?? 0,
        endReason: simResult.trialEndReason ?? "unknown", // "wipe" | "timeout" | "completed"
        endTime: simResult.trialEndTime ?? simResult.simulatedTime ?? 0,
        // Tier in progress (or just cleared, for "completed") when the run
        // ended, and the fraction (0..1) of that tier's encounter TOTAL max HP
        // removed by then. "completed" ⇒ 1.0; a timeout during the 3 s respawn
        // gap reports the never-spawned NEXT tier with 0 progress.
        finalTier: simResult.trialCurrentTier ?? 0,
        finalTierHpRemovedFrac: simResult.trialFinalTierHpRemovedFrac ?? 0,
        // { hrid: totalDamageDealtToEnemies } — endTime is the DPS denominator.
        playerDamageDone,
        tierTimes: simResult.trialTierTimes ?? {}, // { tier: nsSpent }
        playerDeaths: simResult.trialPlayerDeaths ?? {}, // { hrid: [tier, ...] }
    };
}

/**
 * Rewards for clearing `tiersCleared` tiers.
 *   Combat points  = 400 (first tier) + 200 × (tiersCleared - 1)
 *   Guild tokens   = 200 (first tier) + 100 × (tiersCleared - 1)  [per participant]
 * Multipliers: points × (1 + buildersHallBonus), tokens × (1 + treasuryBonus).
 * Zero tiers cleared ⇒ no reward.
 *
 * The trial is a single weekly attempt with no re-clear of any tier (the run
 * completes when the cap tier 300 is cleared), so tiersCleared is always the
 * number of distinct tiers beaten.
 */
export function computeTrialRewards(tiersCleared, { buildersHallBonus = 0, treasuryBonus = 0 } = {}) {
    if (!tiersCleared || tiersCleared <= 0) {
        return { points: 0, tokensPerParticipant: 0 };
    }
    const basePoints = 400 + 200 * (tiersCleared - 1);
    const baseTokens = 200 + 100 * (tiersCleared - 1);
    return {
        points: basePoints * (1 + buildersHallBonus),
        tokensPerParticipant: baseTokens * (1 + treasuryBonus),
    };
}

/**
 * Aggregate per-iteration summaries into trial statistics.
 * @param {Array} summaries  from extractTrialSummary
 * @param {object} opts { startTier?, buildersHallBonus?, treasuryBonus? }
 */
export function aggregateTrialResults(summaries, opts = {}) {
    const n = summaries.length;
    const startTier = opts.startTier ?? GuildTrial.START_TIER;
    const step = GuildTrial.TIER_STEP;
    const cap = GuildTrial.MAX_TIER;

    if (n === 0) {
        return {
            iterations: 0,
            startTier,
            tierStep: step,
            maxTierCap: cap,
            perTierClearProbability: {},
            maxTierDistribution: {},
            maxTierDistributionPct: {},
            avgTimePerTierMs: {},
            expectedMaxTierCleared: 0,
            expectedTiersCleared: 0,
            wipeRate: 0,
            timeoutRate: 0,
            completedRate: 0,
            deathsByTier: {},
            endedAtTierCount: {},
            avgFinalTierHpRemoved: {},
            avgPlayerDps: {},
            avgPartyDps: 0,
            expectedGuildPoints: 0,
            expectedTokensPerParticipant: 0,
        };
    }

    const highestAttempted = summaries.reduce(
        (m, s) => Math.max(m, s.maxTierCleared || 0, (s.tierTimes && lastTierKey(s.tierTimes)) || 0),
        startTier
    );

    const tiers = [];
    for (let t = startTier; t <= Math.min(highestAttempted, cap); t += step) tiers.push(t);

    const perTierClearProbability = {};
    const maxTierDistribution = {};
    const maxTierDistributionPct = {};
    const tierTimeSum = {};
    const tierTimeCount = {};
    const deathsByTier = {};
    // Bucketed by finalTier (the tier the run ENDED at — one step past the
    // last cleared tier, so distinct from maxTierDistribution's buckets).
    const endedAtTierCount = {};
    const finalTierHpRemovedSum = {};
    // Per-player and party DPS: each iteration contributes
    // damage / endTimeSeconds (0 when endTime is 0), averaged over ALL n
    // iterations — a player absent from an iteration contributes 0 to it.
    const playerDpsSum = {};
    let partyDpsSum = 0;

    // Ensure the "0" (wiped on first tier, cleared nothing) bucket exists.
    maxTierDistribution[0] = 0;

    let wipes = 0;
    let timeouts = 0;
    let completions = 0; // cleared the cap tier (300) — run "completed"
    let sumMaxTier = 0;
    let sumTiersCleared = 0;
    let sumPoints = 0;
    let sumTokens = 0;

    for (const s of summaries) {
        const maxT = s.maxTierCleared || 0;
        sumMaxTier += maxT;
        sumTiersCleared += s.tiersCleared || 0;

        maxTierDistribution[maxT] = (maxTierDistribution[maxT] || 0) + 1;

        if (s.endReason === "wipe") wipes++;
        else if (s.endReason === "timeout") timeouts++;
        else if (s.endReason === "completed") completions++;

        for (const t of tiers) {
            // Monotonic ladder: tier t was cleared iff maxTierCleared >= t.
            if (maxT >= t) {
                perTierClearProbability[t] = (perTierClearProbability[t] || 0) + 1;
            }
        }

        for (const [tierKey, ns] of Object.entries(s.tierTimes || {})) {
            tierTimeSum[tierKey] = (tierTimeSum[tierKey] || 0) + ns;
            tierTimeCount[tierKey] = (tierTimeCount[tierKey] || 0) + 1;
        }

        for (const tierList of Object.values(s.playerDeaths || {})) {
            for (const tier of tierList) {
                deathsByTier[tier] = (deathsByTier[tier] || 0) + 1;
            }
        }

        // "How close did we get" progress on the tier each run ended at.
        const finalTier = s.finalTier ?? 0;
        endedAtTierCount[finalTier] = (endedAtTierCount[finalTier] || 0) + 1;
        finalTierHpRemovedSum[finalTier] =
            (finalTierHpRemovedSum[finalTier] || 0) + (s.finalTierHpRemovedFrac || 0);

        // Per-player / party DPS contribution for this iteration. endTime 0
        // (degenerate run) contributes 0 rather than dividing by zero.
        const endSeconds = (s.endTime || 0) / ONE_SECOND_NS;
        if (endSeconds > 0 && s.playerDamageDone) {
            let partyDamage = 0;
            for (const [hrid, damage] of Object.entries(s.playerDamageDone)) {
                playerDpsSum[hrid] = (playerDpsSum[hrid] || 0) + (damage || 0) / endSeconds;
                partyDamage += damage || 0;
            }
            partyDpsSum += partyDamage / endSeconds;
        }

        // Rewards are paid per tier cleared. No tier is ever re-cleared (the
        // run completes on clearing the cap), so deriving the count from the
        // max tier reached is exact — and robust even if a summary's
        // tiersCleared field were missing.
        const distinctTiersCleared = maxT >= startTier ? (maxT - startTier) / step + 1 : 0;
        const rw = computeTrialRewards(distinctTiersCleared, opts);
        sumPoints += rw.points;
        sumTokens += rw.tokensPerParticipant;
    }

    for (const t of tiers) {
        perTierClearProbability[t] = (perTierClearProbability[t] || 0) / n;
    }
    for (const [k, c] of Object.entries(maxTierDistribution)) {
        maxTierDistributionPct[k] = c / n;
    }

    const avgTimePerTierMs = {};
    for (const [k, sum] of Object.entries(tierTimeSum)) {
        avgTimePerTierMs[k] = sum / tierTimeCount[k] / (ONE_SECOND_NS / 1000);
    }

    // Mean finalTierHpRemovedFrac over the runs that ENDED at each tier.
    const avgFinalTierHpRemoved = {};
    for (const [k, sum] of Object.entries(finalTierHpRemovedSum)) {
        avgFinalTierHpRemoved[k] = sum / endedAtTierCount[k];
    }

    // Mean per-iteration DPS across ALL n iterations.
    const avgPlayerDps = {};
    for (const [hrid, sum] of Object.entries(playerDpsSum)) {
        avgPlayerDps[hrid] = sum / n;
    }

    return {
        iterations: n,
        startTier,
        tierStep: step,
        maxTierCap: cap,
        perTierClearProbability,
        maxTierDistribution,
        maxTierDistributionPct,
        avgTimePerTierMs,
        expectedMaxTierCleared: sumMaxTier / n,
        expectedTiersCleared: sumTiersCleared / n,
        // End-reason rates; wipeRate + timeoutRate + completedRate ≈ 1.
        wipeRate: wipes / n,
        timeoutRate: timeouts / n,
        completedRate: completions / n,
        deathsByTier,
        // Runs that ENDED at each tier (≠ maxTierDistribution, which buckets
        // by highest tier CLEARED), and mean final-tier HP progress per bucket.
        endedAtTierCount,
        avgFinalTierHpRemoved,
        // Who is (not) contributing: mean over iterations of each player's
        // total damage-to-enemies / run duration, and the party-wide total.
        avgPlayerDps,
        avgPartyDps: partyDpsSum / n,
        expectedGuildPoints: sumPoints / n,
        expectedTokensPerParticipant: sumTokens / n,
    };
}

function lastTierKey(tierTimes) {
    let max = 0;
    for (const k of Object.keys(tierTimes)) {
        const v = Number(k);
        if (v > max) max = v;
    }
    return max;
}
