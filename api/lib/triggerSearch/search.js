// =============================================================================
// search — the four-stage, escalating-fidelity trigger threshold search
//
// WHY NOT A STRAIGHT PORT. The peer fork's funnel (TRIGGER-OPTIMIZER.md §5)
// narrows a *candidate pool*: it starts from a cross-product of ability sets and
// hand-authored trigger presets, screens ~hundreds down to 20, then 8, then 5.
// Our scope is thresholds only, so there is exactly ONE starting configuration
// and their stage one would screen it against itself.
//
// So the funnel here escalates fidelity over threshold COMBINATIONS instead,
// which preserves the actual virtue — cheap simulations prune, expensive ones
// decide — and repairs the peer's main weakness along the way:
//
//   Stage 1  screen   6h   sweep each parameter alone over its coarse grid from
//                          the baseline; keep the best K VALUES per parameter.
//                          Cost: sum of coarse grid sizes.
//
//   Stage 2  beam    12h   beam search over the surviving values, one parameter
//                          at a time, carrying the best W COMBINATIONS forward.
//                          Cost: params x W x K.
//
//   Stage 3  fine    24h   one fine coordinate-descent pass over each of the
//                          top few combinations. Cost: keep x sum of fine grids.
//
//   Stage 4  verify  72h   re-run finalists and baseline on one pinned seed.
//
// The beam is the improvement. The peer runs greedy coordinate descent, taking
// only the single best value for each parameter before moving to the next — so
// two thresholds that only pay off together are invisible to it. They partly
// compensate by repeating the descent until a pass changes nothing; a beam of
// width W explores W such paths at once for the same asymptotic cost.
//
// SEEDS. One seed per stage, incremented between stages. Within a stage every
// candidate meets an identical spawn sequence, which is what makes a 0.1%
// ranking epsilon defensible at all. Between stages the sequence changes, so a
// threshold that only beat one particular sequence is found out at the next.
// =============================================================================

import { gridFor, coarseGridSize } from './grids.js';
import { applyValues, countConditions, readValues } from './params.js';
import {
  DEFAULT_INSENSITIVITY_EPSILON,
  DEFAULT_RANK_EPSILON,
  ONE_HOUR_NS,
  coefficientOfVariation,
  computeDeltas,
  insensitiveValues,
  noiseAwareEpsilons,
  rankResults,
} from './score.js';

/** Stage defaults. Hours mirror the peer's 6 / 12 / 24 / 72. */
export const DEFAULT_STAGES = {
  // Repeats of the baseline, at `initial.hours`, on distinct seeds, used to
  // measure this build-and-zone's Monte-Carlo noise. Epsilons for every stage are
  // then derived from it via the 1/sqrt(t) scaling law (score.js). Set to 0 or 1
  // to skip and fall back to the peer's asserted fixed epsilons — which measured
  // 57x too small on a hard zone, so do not.
  calibration: { repeats: 5 },
  initial: { hours: 6, keepPerParam: 3 },
  coarse: { hours: 12, beamWidth: 8 },
  fine: { hours: 24, keep: 5 },
  verify: { hours: 72 },
};

/** "Stable mode" — the peer's 120h verification. */
export const STABLE_VERIFY_HOURS = 120;

const PHASE_ORDER = ['initial', 'coarse', 'fine'];

export class AbortError extends Error {
  constructor(message = 'Trigger optimisation cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}

function mergeStages(overrides = {}) {
  return {
    calibration: { ...DEFAULT_STAGES.calibration, ...(overrides.calibration || {}) },
    initial: { ...DEFAULT_STAGES.initial, ...(overrides.initial || {}) },
    coarse: { ...DEFAULT_STAGES.coarse, ...(overrides.coarse || {}) },
    fine: { ...DEFAULT_STAGES.fine, ...(overrides.fine || {}) },
    verify: { ...DEFAULT_STAGES.verify, ...(overrides.verify || {}) },
  };
}

/** Stable identity for a value vector, so identical combinations run once. */
function vectorKey(values) {
  return values.join('|');
}

/**
 * Estimate the total number of simulations a run will cost.
 *
 * Reported to the UI before the user commits, because a 72-hour verification
 * stage is not something to discover halfway through. Deliberately an upper
 * bound: de-duplication and beam collapse only ever reduce it.
 *
 * @param {object[]} params
 * @param {object} [stageOverrides]
 * @returns {{initial: number, coarse: number, fine: number, verify: number, total: number}}
 */
export function estimateWorkload(params, stageOverrides = {}) {
  const stages = mergeStages(stageOverrides);
  const count = params.length;
  const calibration = stages.calibration.repeats >= 2 ? stages.calibration.repeats : 0;
  if (count === 0) {
    return { calibration, initial: 0, coarse: 0, fine: 0, verify: 1, total: calibration + 1 };
  }

  const initial = coarseGridSize(params) + 1; // + baseline
  const perParamValues = Math.max(1, stages.initial.keepPerParam);
  const coarse = count * stages.coarse.beamWidth * perParamValues + 1;
  const fineGridTotal = params.reduce(
    (total, param) => total + gridFor(param, { fine: true, current: param.initialValue }).length,
    0
  );
  const fine = stages.fine.keep * fineGridTotal + 1;
  const verify = stages.fine.keep + 1;

  return {
    calibration,
    initial,
    coarse,
    fine,
    verify,
    total: calibration + initial + coarse + fine + verify,
  };
}

/**
 * Run the search.
 *
 * `evaluate` is injected so this module stays free of worker_threads and can be
 * unit-tested against a synthetic scoring function.
 *
 * @param {object} args
 * @param {object[]} args.playerDTOs            baseline configuration
 * @param {object[]} args.params                 from collectSearchParams
 * @param {(jobs: object[], meta: object) => Promise<object[]>} args.evaluate
 *        jobs are `{ id, playerDTOs, simulationTimeLimit, seed }`; must resolve
 *        to `{ id, metrics }` in any order.
 * @param {string}  [args.objective]
 * @param {object}  [args.stages]
 * @param {number}  [args.seedBase]
 * @param {object}  [args.epsilons]              { rank, insensitivity }
 * @param {object}  [args.resumeCheckpoint]
 * @param {(p: object) => void} [args.onProgress]
 * @param {(c: object) => void} [args.onCheckpoint]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} the result document
 */
export async function optimizeTriggers({
  playerDTOs,
  params,
  evaluate,
  objective = 'encountersPerHour',
  stages: stageOverrides = {},
  seedBase = 20260811,
  epsilons = {},
  resumeCheckpoint = null,
  onProgress = null,
  onCheckpoint = null,
  signal = null,
}) {
  const stages = mergeStages(stageOverrides);

  // `epsilons` supplies FLOORS, not fixed values. The working epsilon for each
  // stage is derived from measured noise (see calibrateNoise below) and can only
  // ever be wider than the floor — never narrower, so we are never less
  // discriminating than the peer on a zone quiet enough for their numbers to hold.
  const rankFloor = Number.isFinite(epsilons.rank) ? epsilons.rank : DEFAULT_RANK_EPSILON;
  const insensitivityFloor = Number.isFinite(epsilons.insensitivity)
    ? epsilons.insensitivity
    : DEFAULT_INSENSITIVITY_EPSILON;

  const baselineValues = readValues(playerDTOs, params);
  const conditionCount = countConditions(playerDTOs);
  const estimate = estimateWorkload(params, stageOverrides);

  let completed = 0;
  const report = (stage, label) => {
    onProgress?.({
      stage,
      label,
      completed,
      total: estimate.total,
      progress: estimate.total > 0 ? Math.min(1, completed / estimate.total) : 0,
    });
  };

  /**
   * Simulate a set of value-vectors, de-duplicating identical ones.
   * Returns entries in the same order as `vectors`, each `{ id, values,
   * metrics, conditionCount }`.
   */
  async function evaluateVectors(vectors, { hours, seed, stage, label, idPrefix }) {
    throwIfAborted(signal);

    const unique = new Map();
    for (const values of vectors) {
      const key = vectorKey(values);
      if (!unique.has(key)) unique.set(key, { key, values, id: `${idPrefix}:${unique.size}` });
    }

    const jobs = [...unique.values()].map((entry) => ({
      id: entry.id,
      playerDTOs: applyValues(playerDTOs, params, entry.values),
      simulationTimeLimit: hours * ONE_HOUR_NS,
      seed,
    }));

    report(stage, label);
    const raw = await evaluate(jobs, { stage, label, hours, seed });
    throwIfAborted(signal);

    completed += jobs.length;
    report(stage, label);

    const byId = new Map((raw || []).filter(Boolean).map((entry) => [entry.id, entry]));
    const byKey = new Map();
    for (const entry of unique.values()) {
      const scored = byId.get(entry.id);
      if (!scored?.metrics) continue; // a failed simulation simply does not compete
      byKey.set(entry.key, {
        id: entry.id,
        values: entry.values,
        metrics: scored.metrics,
        conditionCount,
        // Feeds the "prefer the incumbent on a tie" tie-break in score.js. The
        // baseline vector scores 0 here, so it wins every tie it takes part in —
        // which is the correct default: if nothing measurably beats the current
        // set-up, the honest recommendation is to change nothing.
        changedFromBaseline: entry.values.reduce(
          (total, value, i) => total + (value === baselineValues[i] ? 0 : 1),
          0
        ),
      });
    }

    return vectors.map((values) => byKey.get(vectorKey(values)) || null).filter(Boolean);
  }

  /** Baseline at a given fidelity, so deltas are always like-for-like. */
  async function evaluateBaseline({ hours, seed, stage }) {
    const [result] = await evaluateVectors([baselineValues], {
      hours,
      seed,
      stage,
      label: `${stage} baseline`,
      idPrefix: `${stage}-baseline`,
    });
    return result?.metrics || null;
  }

  // ---------------------------------------------------------------------------
  // Noise calibration. Run the SAME baseline configuration several times on
  // DIFFERENT seeds and measure the spread of the objective. That spread is the
  // floor below which no ranking is meaningful, and every stage's epsilons are
  // derived from it. Cannot go through evaluateVectors, which de-duplicates by
  // value-vector and would collapse the repeats into one job.
  // ---------------------------------------------------------------------------
  async function calibrateNoise() {
    const repeats = Math.floor(stages.calibration.repeats) || 0;
    if (repeats < 2) return { cv: 0, sd: 0, mean: 0, samples: 0, calibrated: false };

    const hours = stages.initial.hours;
    // Seeds below seedBase, so they cannot collide with any stage's seed
    // (seedBase .. seedBase+3) and calibration never accidentally reuses a
    // stage's random stream.
    const jobs = Array.from({ length: repeats }, (_, i) => ({
      id: `calibrate-${i}`,
      playerDTOs: applyValues(playerDTOs, params, baselineValues),
      simulationTimeLimit: hours * ONE_HOUR_NS,
      seed: seedBase - 1 - i,
    }));

    report('calibration', `measuring noise: ${repeats} baseline runs at ${hours}h`);
    const raw = await evaluate(jobs, { stage: 'calibration', hours, repeats });
    throwIfAborted(signal);
    completed += jobs.length;
    report('calibration', `measuring noise: ${repeats} baseline runs at ${hours}h`);

    const samples = (raw || [])
      .filter((entry) => entry?.metrics)
      .map((entry) => Number(entry.metrics[objective]) || 0);

    const stats = coefficientOfVariation(samples);
    return { ...stats, hours, calibrated: stats.samples >= 2 };
  }

  const noise = await calibrateNoise();

  /** Epsilons for a stage, widened to the measured noise at that fidelity. */
  const epsilonsFor = (hours) =>
    noise.calibrated
      ? noiseAwareEpsilons({
          cv: noise.cv,
          fromHours: noise.hours,
          toHours: hours,
          rankFloor,
          insensitivityFloor,
        })
      : { rank: rankFloor, insensitivity: insensitivityFloor, cvAtStage: 0 };

  const stageEpsilons = {
    initial: epsilonsFor(stages.initial.hours),
    coarse: epsilonsFor(stages.coarse.hours),
    fine: epsilonsFor(stages.fine.hours),
    verify: epsilonsFor(stages.verify.hours),
  };

  const rankAt = (stage, results) =>
    rankResults(results, { objective, epsilon: stageEpsilons[stage].rank });

  // ---------------------------------------------------------------------------
  // Resume support. The phase gate is an index, exactly as the peer's is.
  // ---------------------------------------------------------------------------
  const resumedPhase = resumeCheckpoint?.completedPhase;
  const resumeIndex = PHASE_ORDER.indexOf(resumedPhase) + 1; // 0 when absent
  const stageBaselines = { ...(resumeCheckpoint?.stageBaselines || {}) };
  const screening = { ...(resumeCheckpoint?.screening || {}) };
  const insensitivity = params.map((_, i) => resumeCheckpoint?.insensitivity?.[i] || null);

  const emitCheckpoint = (phase, payload) => {
    onCheckpoint?.({
      completedPhase: phase,
      screening: { ...screening },
      stageBaselines: { ...stageBaselines },
      insensitivity: insensitivity.map((band) => (band ? [...band] : null)),
      ...payload,
    });
  };

  // ---------------------------------------------------------------------------
  // Stage 1 — per-parameter coarse screen. Establishes which values are even
  // worth carrying, and a provisional insensitivity band for each parameter.
  // ---------------------------------------------------------------------------
  let survivingValues;
  if (resumeIndex >= 1 && Array.isArray(resumeCheckpoint?.survivingValues)) {
    survivingValues = resumeCheckpoint.survivingValues.map((values) => [...values]);
  } else if (params.length === 0) {
    survivingValues = [];
    stageBaselines.initial = await evaluateBaseline({ hours: stages.initial.hours, seed: seedBase, stage: 'initial' });
  } else {
    stageBaselines.initial = await evaluateBaseline({ hours: stages.initial.hours, seed: seedBase, stage: 'initial' });

    survivingValues = [];
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      const grid = gridFor(param, { fine: false, current: baselineValues[i] });

      // Only parameter i moves; the rest stay at baseline. This measures each
      // threshold's solo contribution, which is the right question for pruning
      // even though it cannot see interactions — that is stage 2's job.
      const vectors = grid.map((value) => {
        const values = [...baselineValues];
        values[i] = value;
        return values;
      });

      const results = await evaluateVectors(vectors, {
        hours: stages.initial.hours,
        seed: seedBase,
        stage: 'initial',
        label: `screen ${param.slotHrid} ${param.conditionName} (${i + 1}/${params.length})`,
        idPrefix: `initial-p${i}`,
      });

      const withValue = results.map((entry) => ({ ...entry, value: entry.values[i] }));
      const ranked = rankAt('initial', withValue);
      const best = ranked[0];

      if (!best) {
        // Every simulation for this parameter failed; keep the baseline value so
        // the parameter is still represented rather than silently dropped.
        survivingValues.push([baselineValues[i]]);
        continue;
      }

      insensitivity[i] = insensitiveValues(withValue, best, {
        objective,
        epsilon: stageEpsilons.initial.insensitivity,
      });

      const keep = Math.max(1, stages.initial.keepPerParam);
      const kept = new Set(ranked.slice(0, keep).map((entry) => entry.value));
      // Always keep the incumbent: the search must never be able to return
      // something worse than what the user already had.
      kept.add(baselineValues[i]);
      survivingValues.push([...kept].sort((a, b) => a - b));
    }

    screening.initial = survivingValues.reduce((total, values) => total + values.length, 0);
    emitCheckpoint('initial', { survivingValues: survivingValues.map((v) => [...v]) });
  }

  // ---------------------------------------------------------------------------
  // Stage 2 — beam search over the surviving values.
  // ---------------------------------------------------------------------------
  let beam;
  if (resumeIndex >= 2 && Array.isArray(resumeCheckpoint?.beam)) {
    beam = resumeCheckpoint.beam.map((values) => [...values]);
  } else if (params.length === 0) {
    beam = [baselineValues];
  } else {
    stageBaselines.coarse = await evaluateBaseline({
      hours: stages.coarse.hours,
      seed: seedBase + 1,
      stage: 'coarse',
    });

    const width = Math.max(1, stages.coarse.beamWidth);
    beam = [baselineValues];

    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      const expanded = [];
      const seen = new Set();
      for (const member of beam) {
        for (const value of survivingValues[i]) {
          const values = [...member];
          values[i] = value;
          const key = vectorKey(values);
          if (seen.has(key)) continue;
          seen.add(key);
          expanded.push(values);
        }
      }

      const results = await evaluateVectors(expanded, {
        hours: stages.coarse.hours,
        seed: seedBase + 1,
        stage: 'coarse',
        label: `beam ${param.slotHrid} ${param.conditionName} (${i + 1}/${params.length})`,
        idPrefix: `coarse-p${i}`,
      });

      const ranked = rankAt('coarse', results);
      if (ranked.length) beam = ranked.slice(0, width).map((entry) => entry.values);
    }

    screening.coarse = beam.length;
    emitCheckpoint('coarse', { survivingValues: survivingValues.map((v) => [...v]), beam: beam.map((v) => [...v]) });
  }

  // ---------------------------------------------------------------------------
  // Stage 3 — fine coordinate descent on the best combinations. One pass:
  // the beam has already explored breadth, so this is about resolution, and the
  // fine grid always contains the incumbent (see grids.fineAbsoluteGrid) so a
  // pass cannot regress.
  // ---------------------------------------------------------------------------
  let finalists;
  if (resumeIndex >= 3 && Array.isArray(resumeCheckpoint?.finalists)) {
    finalists = resumeCheckpoint.finalists.map((values) => [...values]);
  } else if (params.length === 0) {
    finalists = [baselineValues];
  } else {
    stageBaselines.fine = await evaluateBaseline({ hours: stages.fine.hours, seed: seedBase + 2, stage: 'fine' });

    const seeds = beam.slice(0, Math.max(1, stages.fine.keep));
    const refined = [];

    for (let s = 0; s < seeds.length; s += 1) {
      let current = [...seeds[s]];
      let bestEntry = null;

      for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        const grid = gridFor(param, { fine: true, current: current[i] });
        const vectors = grid.map((value) => {
          const values = [...current];
          values[i] = value;
          return values;
        });

        const results = await evaluateVectors(vectors, {
          hours: stages.fine.hours,
          seed: seedBase + 2,
          stage: 'fine',
          label: `refine ${s + 1}/${seeds.length} · ${param.conditionName} (${i + 1}/${params.length})`,
          idPrefix: `fine-s${s}-p${i}`,
        });

        const withValue = results.map((entry) => ({ ...entry, value: entry.values[i] }));
        const ranked = rankAt('fine', withValue);
        const best = ranked[0];
        if (!best) continue;

        current = [...best.values];
        bestEntry = best;

        // The fine sweep is a better measurement than stage 1's, so let it
        // supersede the provisional band — but only from the leading seed,
        // whose neighbourhood is the one we are actually going to recommend.
        if (s === 0) {
          insensitivity[i] = insensitiveValues(withValue, best, {
            objective,
            epsilon: stageEpsilons.fine.insensitivity,
          });
        }
      }

      if (bestEntry) refined.push({ ...bestEntry, values: current });
    }

    const ranked = rankAt('fine', refined);
    finalists = ranked.slice(0, Math.max(1, stages.fine.keep)).map((entry) => entry.values);
    if (!finalists.length) finalists = [baselineValues];

    screening.fine = finalists.length;
    emitCheckpoint('fine', {
      survivingValues: survivingValues.map((v) => [...v]),
      beam: beam.map((v) => [...v]),
      finalists: finalists.map((v) => [...v]),
    });
  }

  // ---------------------------------------------------------------------------
  // Stage 4 — verification. Finalists and the baseline together, on one seed at
  // full fidelity, so the headline numbers and their deltas come from a single
  // fair comparison rather than being stitched across stages.
  // ---------------------------------------------------------------------------
  throwIfAborted(signal);
  const verifySeed = seedBase + 3;
  const verifyHours = stages.verify.hours;

  // Deduplicate against the baseline and each other: the beam can converge two
  // finalists onto the same vector, and a finalist may BE the baseline. Left
  // unchecked those become duplicate rows in the ranked table, which reads as two
  // separate recommendations that happen to be identical.
  const verifyVectors = [];
  const verifySeen = new Set();
  for (const values of [baselineValues, ...finalists]) {
    const key = vectorKey(values);
    if (verifySeen.has(key)) continue;
    verifySeen.add(key);
    verifyVectors.push(values);
  }

  const verified = await evaluateVectors(verifyVectors, {
    hours: verifyHours,
    seed: verifySeed,
    stage: 'verify',
    label: `verify ${finalists.length} finalist${finalists.length === 1 ? '' : 's'} at ${verifyHours}h`,
    idPrefix: 'verify',
  });

  const baselineKey = vectorKey(baselineValues);
  const baselineEntry = verified.find((entry) => vectorKey(entry.values) === baselineKey);
  const baseline = baselineEntry?.metrics || stageBaselines.fine || stageBaselines.coarse || stageBaselines.initial || {};

  // The baseline competes on merit: if no threshold change beat leaving things
  // alone, the honest answer is to say so, and rank #1 will be the baseline.
  const ranked = rankAt('verify', verified);

  // The bar a margin must clear to be worth reporting as an improvement: the
  // verification stage's own rank epsilon, which is 1.5 standard deviations of
  // this build-and-zone's measured noise at that fidelity.
  const significanceBar = stageEpsilons.verify.rank;

  const rows = ranked.map((entry, index) => {
    const deltas = computeDeltas(entry.metrics, baseline);
    const marginPct = deltas[objective]?.pct;
    const isBaseline = vectorKey(entry.values) === baselineKey;

    return {
      rank: index + 1,
      id: entry.id,
      isBaseline,
      // Whether this row's advantage over the baseline is larger than the noise.
      // A false here means "we cannot tell these apart" — and the UI must say so
      // rather than presenting a +0.4% delta as though it were a finding.
      significant: !isBaseline && Number.isFinite(marginPct) && Math.abs(marginPct) > significanceBar,
      marginPct: Number.isFinite(marginPct) ? marginPct : null,
      changedCount: entry.values.reduce(
        (total, value, i) => total + (value === baselineValues[i] ? 0 : 1),
        0
      ),
      values: entry.values,
      triggers: params.map((param, i) => ({
        playerIndex: param.playerIndex,
        slotKind: param.slotKind,
        slotIndex: param.slotIndex,
        triggerIndex: param.triggerIndex,
        playerHrid: param.playerHrid,
        slotHrid: param.slotHrid,
        dependencyName: param.dependencyName,
        conditionName: param.conditionName,
        comparatorName: param.comparatorName,
        kind: param.kind,
        maxValue: param.maxValue,
        initialValue: param.initialValue,
        unreachable: !!param.unreachable,
        value: entry.values[i],
        changed: entry.values[i] !== baselineValues[i],
        insensitiveValues: insensitivity[i] || null,
      })),
      metrics: entry.metrics,
      deltas,
    };
  });

  return {
    objective,
    baseline,
    rows,
    params: params.map((param, i) => ({ ...param, insensitiveValues: insensitivity[i] || null })),
    screening: { ...screening, final: rows.length },
    stageBaselines,
    stages,
    seedBase,
    verifyHours,
    // Surfaced so the UI can be candid: if the measured noise at the verification
    // stage is comparable to the winner's margin over the baseline, the "winner"
    // has not really been shown to be better, and the user should be told that
    // rather than left to infer it from a suspiciously small delta.
    noise: {
      calibrated: noise.calibrated,
      samples: noise.samples,
      measuredAtHours: noise.hours ?? null,
      coefficientOfVariation: noise.cv,
      standardDeviation: noise.sd,
      mean: noise.mean,
    },
    epsilons: {
      floors: { rank: rankFloor, insensitivity: insensitivityFloor },
      byStage: stageEpsilons,
      significanceBar,
    },
    // True when no candidate beat the baseline by more than the noise. The
    // correct advice then is "change nothing" — and saying so plainly is more
    // useful than presenting a ranked table that implies otherwise.
    inconclusive: !rows.some((row) => row.significant && (row.deltas[objective]?.value || 0) > 0),
    simulationsRun: completed,
    estimatedSimulations: estimate.total,
  };
}
