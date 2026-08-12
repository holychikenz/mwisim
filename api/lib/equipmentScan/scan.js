// =============================================================================
// scan — measure what one enhancement level is worth, slot by slot
//
// Deliberately NOT a search. The trigger optimiser narrows a candidate pool
// through escalating fidelity because it wants one winner; this wants a COMPLETE
// TABLE, because the question is "where should the next levels go" and a slot
// that screens out is still an answer. Every candidate therefore gets the same
// fidelity, and every candidate is reported.
//
// THE PROBE. A single +1 is beneath the Monte-Carlo noise on any zone worth
// optimising for, so each slot is probed at +6 (clamped near the cap) and the
// measured gain divided by the step. That assumes local linearity in the
// multiplier table, which is convex — 1, 2.1, 3.3, 4.6, 6, 7.5 — so six levels
// buy rather more than six times the next single level. `multiplierRatio` on each
// row is exactly that overstatement, computed from the table, so a reader can
// deflate the figure instead of taking it on faith.
//
// THE SHAPE OF THE RUN. Replicates are the outer loop and candidates the inner,
// so every candidate meets seed N before any candidate meets seed N+1. Two
// reasons, one statistical and one practical:
//
//   * Statistical — it is what makes the comparison PAIRED. Baseline and variant
//     share a seed, so the per-seed difference cancels whatever that seed did to
//     both. See stats.js for why this can only help.
//
//   * Practical — a batch is one seed's worth of work, which is (candidates + 1)
//     simulations. That is comfortably more than a worker pool, so the pool stays
//     saturated, and finishing a batch is a natural, monotone progress tick. The
//     tail of each batch wastes a fraction of a round; on a scan that costs
//     seconds that is a price worth paying for progress the user can read.
//
// WHAT IS NOT DONE HERE. No pricing, no enhancement costs, no return on
// investment. This module answers "what does the level buy", full stop. What the
// level COSTS is a question about the player's situation — their enhancing level,
// their tool, their teas — and is answered elsewhere, against the cow webapp's
// enhancement simulator, exactly as consumable production times already are.
// =============================================================================

import { REPORTED_METRICS, coefficientOfVariation, computeDeltas } from '../triggerSearch/score.js';
import { pairedComparison } from './stats.js';

/** One simulated hour, in the nanoseconds the engine counts in. */
const ONE_HOUR_NS = 60 * 60 * 1e9;

/**
 * Defaults.
 *
 * 24 hours because the measured coefficient of variation at that fidelity is
 * 0.077% on a quiet zone and 2.942% on a loud one, and six replicates of the
 * latter give a standard error on the paired difference of roughly 1.7% before
 * any benefit from pairing — enough to resolve a +6 that is worth having.
 *
 * Six replicates rather than more because the marginal value of a replicate
 * falls as 1/sqrt(n) while its cost is linear, and because five degrees of
 * freedom is where Student-t stops being punitive.
 */
export const DEFAULT_SCAN = Object.freeze({
  hours: 24,
  replicates: 6,
  step: 6,
  alpha: 0.05,
});

/** Seed the run starts from when the caller does not pick one. */
export const DEFAULT_SEED_BASE = 20260812;

/**
 * Simulation count and simulated hours for a configuration.
 *
 * @param {number} candidateCount
 * @param {{hours: number, replicates: number}} scan
 * @returns {{candidates: number, replicates: number, perReplicate: number, total: number, simulatedHours: number}}
 */
export function estimateWorkload(candidateCount, { hours, replicates } = DEFAULT_SCAN) {
  const candidates = Math.max(0, Math.floor(Number(candidateCount) || 0));
  const reps = Math.max(1, Math.floor(Number(replicates) || DEFAULT_SCAN.replicates));
  const perHour = Number(hours) || DEFAULT_SCAN.hours;
  // +1 for the baseline, which is re-run at every seed rather than once: it is
  // both the reference and, through its own spread, the noise measurement.
  const perReplicate = candidates + 1;
  const total = perReplicate * reps;
  return {
    candidates,
    replicates: reps,
    perReplicate,
    total,
    simulatedHours: total * perHour,
  };
}

/** Mean of each reported metric across replicates, so a row can show a table. */
function averageMetrics(metricsList) {
  const list = (metricsList || []).filter(Boolean);
  if (!list.length) return {};
  const out = {};
  for (const key of REPORTED_METRICS) {
    const values = list.map((m) => Number(m?.[key])).filter(Number.isFinite);
    out[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }
  // Carried through unaveraged: these are run properties, not rates.
  out.consumableCostsKnown = !!list[0]?.consumableCostsKnown;
  out.ranOutOfMana = list.some((m) => m?.ranOutOfMana);
  return out;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Equipment scan cancelled');
  error.name = 'AbortError';
  throw error;
}

/**
 * Measure the marginal value of enhancement, slot by slot.
 *
 * @param {object} args
 * @param {object[]} args.playerDTOs
 * @param {object[]} args.candidates          scannable rows from enumerateEquipment
 * @param {(jobs: object[], meta: object) => Promise<object[]>} args.evaluate
 * @param {(dtos: object[], candidate: object) => object[]} args.applyCandidate
 * @param {string} args.objective             metric name to rank on
 * @param {number} [args.hours]
 * @param {number} [args.replicates]
 * @param {number} [args.alpha]
 * @param {number} [args.seedBase]
 * @param {AbortSignal} [args.signal]
 * @param {(progress: object) => void} [args.onProgress]
 * @returns {Promise<object>} the result document
 */
export async function scanEquipment({
  playerDTOs,
  candidates,
  evaluate,
  applyCandidate,
  objective = 'encountersPerHour',
  hours = DEFAULT_SCAN.hours,
  replicates = DEFAULT_SCAN.replicates,
  alpha = DEFAULT_SCAN.alpha,
  seedBase = DEFAULT_SEED_BASE,
  signal = null,
  onProgress = null,
}) {
  const scannable = (candidates || []).filter((row) => row.scannable);
  if (!scannable.length) throw new Error('No scannable equipment in the selection');

  const reps = Math.max(1, Math.floor(Number(replicates) || DEFAULT_SCAN.replicates));
  const simulationTimeLimit = hours * ONE_HOUR_NS;
  const workload = estimateWorkload(scannable.length, { hours, replicates: reps });

  // id -> array indexed by replicate. Holes are failed simulations and are
  // dropped pairwise later rather than being coerced to zero, which would read
  // as "this build scored nothing" instead of "this build was not measured".
  const baselineRuns = [];
  const candidateRuns = new Map(scannable.map((row) => [row.id, []]));

  let completed = 0;
  const report = (label) => {
    onProgress?.({
      stage: 'scan',
      label,
      completed,
      total: workload.total,
      progress: workload.total ? completed / workload.total : 0,
    });
  };

  report('preparing');

  for (let replicate = 0; replicate < reps; replicate += 1) {
    throwIfAborted(signal);
    const seed = seedBase + replicate;

    const jobs = [
      {
        id: `baseline#${replicate}`,
        playerDTOs,
        simulationTimeLimit,
        seed,
      },
      ...scannable.map((row) => ({
        id: `${row.id}#${replicate}`,
        playerDTOs: applyCandidate(playerDTOs, row),
        simulationTimeLimit,
        seed,
      })),
    ];

    report(`replicate ${replicate + 1} of ${reps}`);
    const results = await evaluate(jobs, { stage: 'scan', replicate });
    completed += jobs.length;

    for (const result of results) {
      const [id] = String(result.id).split('#');
      const metrics = result.error ? null : result.metrics;
      if (id === 'baseline') baselineRuns[replicate] = metrics;
      else candidateRuns.get(id)[replicate] = metrics;
    }

    report(`replicate ${replicate + 1} of ${reps}`);
  }

  const baselineSamples = baselineRuns.map((m) => (m ? Number(m[objective]) : NaN));
  const usableBaseline = baselineSamples.filter(Number.isFinite);
  if (usableBaseline.length === 0) {
    throw new Error('Every baseline simulation failed; nothing to compare against');
  }

  const baselineMetrics = averageMetrics(baselineRuns);
  const noise = coefficientOfVariation(usableBaseline);

  const rows = scannable.map((row) => {
    const runs = candidateRuns.get(row.id) || [];
    const samples = runs.map((m) => (m ? Number(m[objective]) : NaN));
    const comparison = pairedComparison(samples, baselineSamples, {
      alpha,
      familySize: scannable.length,
    });
    const metrics = averageMetrics(runs);

    const step = row.step || 1;
    const scale = Math.abs(comparison.baselineMean) > 1e-9 ? Math.abs(comparison.baselineMean) : null;

    // The headline figures. `perLevel` divides the measured gain by the step
    // ACTUALLY used, which is not always the requested six — an item at +17 was
    // probed three levels and dividing it by six would halve its true worth.
    const perLevel = comparison.deltaMean / step;
    const marginPerLevel =
      comparison.marginOfError == null ? null : comparison.marginOfError / step;
    const marginPerLevelFamilywise =
      comparison.marginOfErrorFamilywise == null
        ? null
        : comparison.marginOfErrorFamilywise / step;

    return {
      ...row,
      objective,
      metrics,
      deltas: computeDeltas(metrics, baselineMetrics),
      samples,
      // Whole-probe figures: what the full +step bought.
      probeDelta: comparison.deltaMean,
      probeDeltaPct: scale == null ? null : comparison.deltaMean / scale,
      // Per-level figures: the answer the caller actually asked for.
      perLevel,
      perLevelPct: scale == null ? null : perLevel / scale,
      perLevelMargin: marginPerLevel,
      perLevelMarginPct: scale == null || marginPerLevel == null ? null : marginPerLevel / scale,
      perLevelMarginFamilywisePct:
        scale == null || marginPerLevelFamilywise == null ? null : marginPerLevelFamilywise / scale,
      // The full statistical picture, so a caller can second-guess the verdict.
      statistics: comparison,
      significant: comparison.significant,
      significantFamilywise: comparison.significantFamilywise,
    };
  });

  // Ranked on the per-level percentage, which is the comparable quantity across
  // slots. Ties broken by the tighter interval (a better-measured equal is the
  // safer recommendation) and then by id, so the order is deterministic.
  rows.sort((left, right) => {
    const a = left.perLevelPct ?? -Infinity;
    const b = right.perLevelPct ?? -Infinity;
    if (a !== b) return b - a;
    const ma = left.perLevelMarginPct ?? Infinity;
    const mb = right.perLevelMarginPct ?? Infinity;
    if (ma !== mb) return ma - mb;
    return String(left.id).localeCompare(String(right.id));
  });
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });

  const pairingEfficiencies = rows
    .map((row) => row.statistics.pairingEfficiency)
    .filter((value) => Number.isFinite(value));

  return {
    objective,
    hours,
    replicates: reps,
    seedBase,
    alpha,
    step: rows[0]?.requestedStep ?? DEFAULT_SCAN.step,
    baseline: {
      metrics: baselineMetrics,
      samples: baselineSamples,
      mean: noise.mean,
      standardDeviation: noise.sd,
      coefficientOfVariation: noise.cv,
      usableSamples: usableBaseline.length,
    },
    rows,
    noise: {
      calibrated: usableBaseline.length >= 2,
      samples: usableBaseline.length,
      measuredAtHours: hours,
      coefficientOfVariation: noise.cv,
      standardDeviation: noise.sd,
      mean: noise.mean,
    },
    // Reported rather than assumed: how much variance sharing seeds actually
    // removed. Near zero means the paired design bought nothing on this zone and
    // the run is effectively an unpaired one — worth knowing, not worth hiding.
    pairingEfficiency: pairingEfficiencies.length
      ? pairingEfficiencies.reduce((a, b) => a + b, 0) / pairingEfficiencies.length
      : null,
    familySize: scannable.length,
    simulationsRun: completed,
    estimatedSimulations: workload.total,
    // "Nothing here is distinguishable from noise" is a real and useful answer,
    // and far better than ranking a table of accidents with a straight face.
    inconclusive: !rows.some((row) => row.significant),
  };
}
