// =============================================================================
// score — turn a SimResult into comparable numbers, and rank candidates
//
// SimResult is a raw accumulator: it holds counts and histograms and computes no
// rates at all. There is no `dps` field, no `xpPerHour`. Every consumer divides
// by `simulatedTime / ONE_HOUR` itself (api/cli.js:147-175,
// ui/src/components/SimulationResults.jsx:33-91). We do the same, once, here.
//
// The objective is encounters per hour. The tie-breaker chain below is adapted
// from the peer fork's, with its "more encounters" step dropped as redundant —
// when encounters IS the objective, breaking a tie on encounters cannot break
// anything. What remains:
//
//   1. encounters per hour, descending, outside a relative epsilon
//   2. fewer player deaths per hour  — a build that dies is not really faster
//   3. FEWER TOTAL TRIGGER CONDITIONS — given equal performance, prefer the
//      simpler set-up. This is the peer's best idea and worth keeping verbatim.
//   4. FEWER THRESHOLDS CHANGED FROM THE INCUMBENT — see below.
//   5. id, lexicographic — so output is deterministic
//
// Tie-break 4 is ours, and it is not cosmetic. Early stages run at low fidelity
// where most values tie inside the epsilon; without it, ranking falls straight
// through to `id` and picks arbitrarily among equals. The observable consequence
// was the optimiser advising "change this threshold from 1 to 45" about two
// values it had measured as identical — churn presented as insight. Preferring
// the incumbent on a tie means every recommendation the tool makes is one it
// actually has evidence for, and it composes with tie-break 3: given equal
// performance, prefer the simpler set-up, then the one you already had.
// =============================================================================

// Static, unlike the engine import below: shared/ is plain ESM with no
// extensionless or JSON imports, so it needs nothing from api/loader.js.
import {
  consumableSecondsUsed,
  consumableTimeShare,
  effectiveRatePerHour,
  sumConsumablesUsed,
} from '../../../shared/consumableCost.js';

const { sumDamageToEnemies } = await import('../../../src/combatsimulator/guildTrialStats.js');

/** Nanoseconds in an hour. Same constant as api/cli.js:14 and App.jsx:50. */
export const ONE_HOUR_NS = 60 * 60 * 1e9;

/**
 * FLOOR for the relative epsilon inside which two objective values count as
 * tied. Also the fixed value used when noise calibration is switched off.
 *
 * This is the peer fork's figure, and on its own it is indefensible. Measured
 * run-to-run standard deviation of encounters/hour, twelve seeds per cell:
 *
 *   zone                  6h       12h      24h
 *   fly (trivial)         0.115%   0.101%   0.077%
 *   chimerical_den        1.139%   0.483%   0.356%
 *   enchanted_fortress    5.730%   3.665%   2.942%
 *
 * At the peer's own stage-one fidelity on a hard zone, the noise is 57x their
 * epsilon — so their screening there is very largely luck. We keep 0.001 only as
 * a floor (never be *less* discriminating than they are on a trivial zone) and
 * derive the working epsilon from measured noise instead. See noiseAwareEpsilons.
 */
export const DEFAULT_RANK_EPSILON = 0.001;

/**
 * FLOOR for the insensitivity band epsilon. The peer uses 0.005 (0.5%), which is
 * likewise beneath the noise floor on anything but a trivial zone.
 */
export const DEFAULT_INSENSITIVITY_EPSILON = 0.005;

/**
 * Ceiling on a derived epsilon. Past this everything ties and the search
 * degenerates into "keep the incumbent" — which is arguably the honest answer at
 * such fidelity, but the user deserves to be told rather than have the run
 * silently do nothing.
 */
export const MAX_DERIVED_EPSILON = 0.25;

/**
 * A difference between two single samples has standard deviation sqrt(2)*sigma.
 * Treating anything inside that as a tie is the weakest defensible bar, so 1.5
 * rounds it up slightly.
 */
export const RANK_SIGMA_MULTIPLIER = 1.5;

/** Insensitivity is a wider claim ("these are interchangeable"), so ~2 sigma. */
export const INSENSITIVITY_SIGMA_MULTIPLIER = 3;

/**
 * Sample mean, standard deviation and coefficient of variation.
 *
 * @param {number[]} values
 * @returns {{mean: number, sd: number, cv: number, samples: number}}
 */
export function coefficientOfVariation(values) {
  const samples = (values || []).filter((value) => Number.isFinite(value));
  if (samples.length < 2) return { mean: samples[0] ?? 0, sd: 0, cv: 0, samples: samples.length };
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance =
    samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (samples.length - 1);
  const sd = Math.sqrt(variance);
  return { mean, sd, cv: Math.abs(mean) > 1e-9 ? sd / Math.abs(mean) : 0, samples: samples.length };
}

/**
 * Monte-Carlo error falls as 1/sqrt(t), so a coefficient of variation measured at
 * one simulated duration predicts another. Verified against the table above:
 * 5.730% at 6h predicts 2.865% at 24h; 2.942% was measured.
 *
 * This is what lets us calibrate ONCE at the cheapest fidelity and derive
 * epsilons for every later stage, instead of paying for a calibration per stage.
 *
 * @param {number} cv
 * @param {number} fromHours
 * @param {number} toHours
 * @returns {number}
 */
export function scaleCoefficientOfVariation(cv, fromHours, toHours) {
  if (!(cv > 0) || !(fromHours > 0) || !(toHours > 0)) return cv || 0;
  return cv * Math.sqrt(fromHours / toHours);
}

/**
 * Epsilons for a stage, derived from noise measured at `fromHours`.
 *
 * @param {object} args
 * @param {number} args.cv          measured coefficient of variation
 * @param {number} args.fromHours   duration it was measured at
 * @param {number} args.toHours     duration of the stage being configured
 * @param {number} [args.rankFloor]
 * @param {number} [args.insensitivityFloor]
 * @returns {{rank: number, insensitivity: number, cvAtStage: number}}
 */
export function noiseAwareEpsilons({
  cv,
  fromHours,
  toHours,
  rankFloor = DEFAULT_RANK_EPSILON,
  insensitivityFloor = DEFAULT_INSENSITIVITY_EPSILON,
}) {
  const cvAtStage = scaleCoefficientOfVariation(cv, fromHours, toHours);
  const clamp = (value, floor) => Math.min(MAX_DERIVED_EPSILON, Math.max(floor, value));
  return {
    rank: clamp(RANK_SIGMA_MULTIPLIER * cvAtStage, rankFloor),
    insensitivity: clamp(INSENSITIVITY_SIGMA_MULTIPLIER * cvAtStage, insensitivityFloor),
    cvAtStage,
  };
}

/**
 * Reduce a SimResult to the scalars we rank and report on.
 *
 * CONSUMABLE COST. `consumableCosts` maps an item hrid to its cost per unit, in
 * SECONDS OF PRODUCTION TIME — the ironcow currency, as produced by
 * ui/src/utils/prices.js buildIronPrices() from the cow webapp. Given it, we can
 * express the whole trade in one unit, because time is what both sides are made
 * of: combat time earns encounters, production time buys the food that sustains
 * it. Hence `effectiveEncountersPerHour` below.
 *
 * Without it the search has a systematic bias, measured on two zones: driving a
 * `missing_hp >= N` food threshold from 400 to 1 bought +0.35% encounters per
 * hour at a cost of 44-55 donuts per hour from a standing start of zero. Under a
 * pure throughput objective that is an improvement. Under any honest accounting
 * it is a disaster.
 *
 * @param {object} simResult
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.consumableCosts] itemHrid → seconds each
 * @returns {object} metrics
 */
export function scoreSimResult(simResult, { consumableCosts = null } = {}) {
  const simulatedTime = Number(simResult?.simulatedTime) || 0;
  const hours = simulatedTime / ONE_HOUR_NS;
  const seconds = simulatedTime / 1e9;
  const perHour = (value) => (hours > 0 ? value / hours : 0);

  // manaUsed is populated unconditionally for every player, so its keys are the
  // canonical roster — the same trick extractTrialSummary uses.
  const playerHrids = Object.keys(simResult?.manaUsed || {});
  const playerHridSet = new Set(playerHrids);

  const deaths = simResult?.deaths || {};
  let playerDeaths = 0;
  let enemyDeaths = 0;
  for (const [hrid, count] of Object.entries(deaths)) {
    if (playerHridSet.has(hrid)) playerDeaths += Number(count) || 0;
    else enemyDeaths += Number(count) || 0;
  }

  let experience = 0;
  for (const bySkill of Object.values(simResult?.experienceGained || {})) {
    for (const amount of Object.values(bySkill || {})) experience += Number(amount) || 0;
  }

  let damage = 0;
  for (const hrid of playerHrids) {
    damage += sumDamageToEnemies(simResult?.attacks, hrid, playerHridSet);
  }

  // CONSUMABLE USAGE. Essential, not decorative: the objective is encounters per
  // hour, and eating more often costs that metric nothing while costing the player
  // real coin. Left unmeasured, the search drives every `missing_hp >= N` threshold
  // toward 1 — "eat at the faintest scratch" — because it is very slightly better
  // on throughput and infinitely worse on the bill. Recording usage lets the
  // ranking hold consumption constant and lets the UI show the trade.
  // The tally, the cost of it and the -1-vs-0 convention all live in
  // shared/consumableCost.js, because the UI's zone results restate their own
  // encounter rate the same way and the two must not drift apart.
  const { byItem: consumablesByItem, total: consumablesTotal } = sumConsumablesUsed(
    simResult?.consumablesUsed
  );
  const consumablesByItemPerHour = {};
  for (const [itemHrid, count] of Object.entries(consumablesByItem)) {
    consumablesByItemPerHour[itemHrid] = perHour(count);
  }
  const { seconds: consumableSeconds } = consumableSecondsUsed(consumablesByItem, consumableCosts);
  const consumableSecondsPerHour = perHour(consumableSeconds);

  // Running dry of mana is invisible in encounters/hour until it is severe, but
  // it is exactly the failure mode a badly-tuned mana threshold produces. Report
  // it so a user can see that a "winning" configuration is starving itself.
  let outOfManaSeconds = 0;
  let anyOutOfMana = false;
  for (const entry of Object.values(simResult?.playerRanOutOfManaTime || {})) {
    outOfManaSeconds += (Number(entry?.totalTimeForOutOfMana) || 0) / 1e9;
  }
  for (const flag of Object.values(simResult?.playerRanOutOfMana || {})) {
    if (flag) anyOutOfMana = true;
  }

  const encountersPerHour = perHour(Number(simResult?.encounters) || 0);

  // Encounters per hour of TOTAL time, combat plus the production time owed for
  // everything consumed. With no cost table this equals encountersPerHour, so the
  // metric is always safe to rank on — it simply stops discriminating.
  const effectiveEncountersPerHour = effectiveRatePerHour(
    encountersPerHour,
    consumableSecondsPerHour
  );

  return {
    hoursSimulated: hours,
    encounters: Number(simResult?.encounters) || 0,
    encountersPerHour,
    effectiveEncountersPerHour,
    enemyKillsPerHour: perHour(enemyDeaths),
    deathsPerHour: perHour(playerDeaths),
    experiencePerHour: perHour(experience),
    damagePerSecond: seconds > 0 ? damage / seconds : 0,
    consumablesPerHour: perHour(consumablesTotal),
    consumablesByItemPerHour,
    consumableSecondsPerHour,
    // Fraction of a player's real time that goes on producing consumables rather
    // than fighting. The headline number for an ironcow player.
    consumableTimeShare: consumableTimeShare(consumableSecondsPerHour),
    consumableCostsKnown: !!consumableCosts,
    outOfManaSecondsPerHour: perHour(outOfManaSeconds),
    ranOutOfMana: anyOutOfMana,
  };
}

/** Metric names carried through to the UI, in display order. */
export const REPORTED_METRICS = [
  'effectiveEncountersPerHour',
  'encountersPerHour',
  'consumableSecondsPerHour',
  'consumablesPerHour',
  'enemyKillsPerHour',
  'experiencePerHour',
  'damagePerSecond',
  'deathsPerHour',
  'outOfManaSecondsPerHour',
];

/**
 * The objective to rank on. When consumable production times are known, the
 * time-denominated one; otherwise raw throughput, which cannot see the food bill.
 */
export function defaultObjective({ consumableCostsKnown = false } = {}) {
  return consumableCostsKnown ? 'effectiveEncountersPerHour' : 'encountersPerHour';
}

/**
 * Sort candidate results best-first.
 *
 * Each entry is `{ id, metrics, conditionCount, changedFromBaseline }`. Both
 * counts are optional; an absent one skips its tie-break rather than being
 * treated as zero — treating it as zero would silently favour whichever entry
 * forgot to set it.
 *
 * IMPLEMENTATION NOTE — WHY CLUSTERING RATHER THAN AN EPSILON IN THE COMPARATOR.
 *
 * The obvious way to write "treat differences under epsilon as ties" is a
 * pairwise test inside the comparator:
 *
 *     if (Math.abs(left - right) / scale > epsilon) return right - left;
 *     ...fall through to tie-breakers...
 *
 * That comparator is NON-TRANSITIVE: A ties B and B ties C while A and C differ
 * by more than epsilon. Array.prototype.sort is only defined for a consistent
 * comparator, so an inconsistent one yields implementation-defined output — in
 * practice a list that is simply not sorted. Observed directly during
 * development: four candidates came back ordered 29.75, 31.37, 32.12, 30.12.
 *
 * The peer fork's comparator (TRIGGER-OPTIMIZER.md §6) has exactly this shape,
 * so its rankings are unreliable whenever three or more candidates fall inside
 * one epsilon of each other — which, given how far its epsilon sits below the
 * noise floor, is most of the time.
 *
 * Quantising onto epsilon-width buckets fixes transitivity but puts the bucket
 * boundary in an arbitrary place, so two values well inside epsilon can still
 * land either side of it. Measured: a 0.03% difference outranked the baseline
 * under a 0.12% significance bar, defeating the whole purpose.
 *
 * So instead: sort STRICTLY by the metric, then walk the sorted list forming
 * clusters greedily — everything within epsilon of the cluster's LEADER joins
 * that cluster. Transitive by construction (a cluster is defined by one
 * reference point, not pairwise), and it expresses what we actually mean:
 * "among the candidates indistinguishable from the best, prefer the simplest".
 * Applied twice, on the objective and then on deaths, after which the remaining
 * tie-breakers are integers and so already a total order.
 *
 * @param {object[]} results
 * @param {object} [opts]
 * @param {string} [opts.objective]
 * @param {number} [opts.epsilon]
 * @returns {object[]} a new array; the input is not mutated
 */
export function rankResults(results, { objective = 'encountersPerHour', epsilon = DEFAULT_RANK_EPSILON } = {}) {
  const objectiveOf = (entry) => Number(entry?.metrics?.[objective]) || 0;
  const deathsOf = (entry) => Number(entry?.metrics?.deathsPerHour) || 0;

  /**
   * Split `list` into runs of entries within `epsilon` (relative) of each run's
   * leader, having first ordered it by `valueOf` in the given direction.
   */
  const cluster = (list, valueOf, direction) => {
    const ordered = [...list].sort(
      (a, b) => direction * (valueOf(b) - valueOf(a)) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    );

    const clusters = [];
    let index = 0;
    while (index < ordered.length) {
      const leader = valueOf(ordered[index]);
      // Floor of 1 stops two near-zero values from dividing their way into a
      // spurious difference; for deaths, an all-zero set collapses to one cluster.
      const scale = Math.max(Math.abs(leader), 1);
      let end = index;
      while (end < ordered.length && Math.abs(leader - valueOf(ordered[end])) / scale <= epsilon) end += 1;
      clusters.push(ordered.slice(index, Math.max(end, index + 1)));
      index = Math.max(end, index + 1);
    }
    return clusters;
  };

  /** Integer tie-breakers: already a total order, so a plain comparator is safe. */
  const byRemainingTieBreakers = (a, b) => {
    const leftCount = a?.conditionCount;
    const rightCount = b?.conditionCount;
    if (Number.isFinite(leftCount) && Number.isFinite(rightCount) && leftCount !== rightCount) {
      return leftCount - rightCount;
    }

    // Prefer leaving thresholds alone when the change buys nothing measurable.
    const leftChanged = a?.changedFromBaseline;
    const rightChanged = b?.changedFromBaseline;
    if (Number.isFinite(leftChanged) && Number.isFinite(rightChanged) && leftChanged !== rightChanged) {
      return leftChanged - rightChanged;
    }

    // Everything material ties. Fall back to the raw objective so the table still
    // reads in a sensible order — without this, `id` can print a lower objective
    // above a higher one inside a cluster, which looks like a sorting bug to the
    // reader even though it is not. Strict comparison inside a cluster, so still
    // a total order.
    const objectiveGap = objectiveOf(b) - objectiveOf(a);
    if (objectiveGap !== 0) return objectiveGap;

    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  };

  const consumablesOf = (entry) => Number(entry?.metrics?.consumablesPerHour) || 0;

  const ranked = [];
  // Objective descending — more is better.
  for (const objectiveCluster of cluster(results || [], objectiveOf, 1)) {
    // Deaths ascending — fewer is better. Same epsilon: see the note above about
    // 0.01 deaths/hour deciding a ranking it has no business deciding.
    for (const deathCluster of cluster(objectiveCluster, deathsOf, -1)) {
      // Consumables ascending — fewer is better. This is the graceful-degradation
      // path for when production times are NOT known: the objective then cannot
      // see the food bill, so at least prefer the cheaper of two configurations
      // that are indistinguishable on throughput. Measured, that is the common
      // case — the throughput on offer for eating constantly was ~0.35%, against a
      // noise floor of ~0.36% on the same zones.
      //
      // Harmless when the objective IS effectiveEncountersPerHour, since cost is
      // already inside it and this only fires within a genuine tie.
      for (const consumableCluster of cluster(deathCluster, consumablesOf, -1)) {
        ranked.push(...consumableCluster.sort(byRemainingTieBreakers));
      }
    }
  }
  return ranked;
}

/**
 * Every swept value that performed indistinguishably from the winner.
 *
 * This is the single most useful thing the optimiser can tell a user. A bare
 * "set it to 4700" invites false precision; "anything from 4200 to 5400 behaves
 * identically" is honest about Monte-Carlo noise and lets the user pick a round
 * number they can remember.
 *
 * @param {Array<{value: number, metrics: object}>} sweep  one parameter's results
 * @param {object} best  the winning entry from that sweep
 * @param {object} [opts]
 * @returns {number[]} ascending, deduplicated, always including the winner
 */
export function insensitiveValues(
  sweep,
  best,
  { objective = 'encountersPerHour', epsilon = DEFAULT_INSENSITIVITY_EPSILON } = {}
) {
  const target = Number(best?.metrics?.[objective]) || 0;
  const scale = Math.abs(target);
  const values = new Set();

  if (Number.isFinite(best?.value)) values.add(best.value);

  for (const entry of sweep || []) {
    const value = Number(entry?.metrics?.[objective]) || 0;
    const close = scale > 1e-9 ? Math.abs(value - target) / scale <= epsilon : Math.abs(value - target) <= 1e-9;
    if (close && Number.isFinite(entry?.value)) values.add(entry.value);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Absolute and relative change of every reported metric against a baseline.
 *
 * @param {object} metrics
 * @param {object} baseline
 * @returns {Record<string, {value: number, pct: number|null}>}
 */
export function computeDeltas(metrics, baseline) {
  const deltas = {};
  for (const key of REPORTED_METRICS) {
    const candidate = Number(metrics?.[key]) || 0;
    const base = Number(baseline?.[key]) || 0;
    const value = candidate - base;
    deltas[key] = { value, pct: Math.abs(base) > 1e-9 ? value / Math.abs(base) : null };
  }
  return deltas;
}
