// =============================================================================
// descent — what the Abilities and Swaps tools share beyond rankCandidates:
// one change at a time or a best-combination coordinate descent, the descent
// confirmed on fresh seeds, and the cap that refuses an oversized pass. What a
// coordinate offers is the tool's (abilitySearch.js, swapSearch.js).
// =============================================================================
import { estimateWorkload, rankCandidates } from './equipmentScan/scan.js';

/** One change at a time tries at most this many; a character who owns everything offers ~200. The rest are reported as skipped. */
export const MAX_CANDIDATES = 150;
/**
 * A best-combination pass may simulate, per replicate, no more than one change at a time
 * can (MAX_CANDIDATES and the baseline). A bigger one is refused, not trimmed, so the user
 * picks what to drop.
 */
export const MAX_PASS_SIMULATIONS = MAX_CANDIDATES + 1;
/** Fresh seeds for re-measuring a descent's winner: on the seeds it was chosen on, it would look better than it is. */
export const CONFIRM_SEED_OFFSET = 1_000_000;

/** One change at a time, or the descent with its workload (estimate(passes)) and its refusal; `untick` says how to fit it. */
export function planSearch(body, all, scan, estimate, untick) {
  const best = body.search === 'best';
  const passes = Math.min(3, Math.max(1, Math.floor(Number(body.passes)) || 2));
  const candidates = best ? all : all.slice(0, MAX_CANDIDATES);
  const workload = best ? estimate(passes) : estimateWorkload(candidates.length, scan);
  return {
    best, passes, candidates, workload,
    refusal: best && workload.candidates > MAX_PASS_SIMULATIONS
      ? `One pass of the best-combination search would simulate up to ${workload.candidates} setups per replicate; the limit is ${MAX_PASS_SIMULATIONS}, as for one change at a time. ${untick}`
      : null,
    echo: { search: best ? 'best' : 'swaps', passes, skipped: all.length - candidates.length },
  };
}

/** estimateWorkload's shape for a descent: `perPass` setups per replicate per pass (an upper bound, baselines included), plus the confirmation's two. */
export function descentWorkload(perPass, passes, { hours, replicates }) {
  const perReplicate = perPass * passes + 2;
  const total = perReplicate * replicates;
  return { candidates: perPass, replicates, perReplicate, total, simulatedHours: total * hours };
}

/**
 * Coordinate descent: each pass visits every coordinate, ranks what it offers
 * against the current best, and moves only on a family-wise significant gain;
 * a descent that followed noise would wander. Stops after a pass that moves
 * nothing, or after `passes`. `rank(state, candidates, label)` is
 * rankCandidates against `state`; `stateOf(row)` reads a row's state.
 */
export async function descend({ start, coordinates, passes, rank, candidatesAt, labelOf, stateOf }) {
  let state = start;
  const steps = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    let moved = false;
    for (const coordinate of coordinates) {
      const candidates = candidatesAt(state, coordinate);
      if (!candidates.length) continue;
      const label = labelOf(coordinate);
      const [best] = (await rank(state, candidates, `pass ${pass} · ${label}`)).rows;
      const taken = best.significantFamilywise && best.delta > 0;
      steps.push({ pass, coordinate, label, tried: candidates.length, best: best.label, deltaPct: best.deltaPct, taken });
      if (taken) { state = stateOf(best); moved = true; }
    }
    if (!moved) break;
  }
  return { state, steps };
}

/**
 * A subject tool's run: rankCandidates over p.candidates, or descend from `start`
 * and re-measure bestOf(end) against `start` on fresh seeds. The result counts the whole search; a descent that ended
 * where it started offers no row. `patch(dto, state)` puts a state on the subject's DTO; `stateOf(row)` reads a row's.
 */
export async function searchSubject(p, { evaluate, signal, onProgress, seedBase, cancelMessage }, { start, patch, stateOf, candidatesAt, labelOf, bestOf }) {
  const k = p.subjectIndex;
  const withState = (state) => p.simPlayers.map((dto, i) => (i === k ? patch(dto, state) : dto));
  const shared = { evaluate, signal, cancelMessage, objective: p.objective, ...p.scan,
    applyCandidate: (dtos, row) => dtos.map((dto, i) => (i === k ? patch(dto, stateOf(row)) : dto)) };
  if (!p.best) return rankCandidates({ ...shared, playerDTOs: p.simPlayers, candidates: p.candidates, seedBase, onProgress });

  let done = 0;
  let last = null;
  const rank = async (state, candidates, label, seed = seedBase) => {
    last = await rankCandidates({ ...shared, candidates, seedBase: seed, playerDTOs: withState(state),
      onProgress: (x) => onProgress({ ...x, stage: 'descent', label: `${label} · ${x.label}`,
        completed: done + x.completed, total: p.workload.total, progress: Math.min(1, (done + x.completed) / p.workload.total) }) });
    done += last.simulationsRun;
    return last;
  };
  const { state, steps } = await descend({ start, coordinates: p.coordinates, passes: p.passes, rank, candidatesAt, labelOf, stateOf });
  const best = bestOf(state);
  // Ended where it started: nothing to confirm or apply. The last ranking measured the start on the run's own seeds.
  const result = best ? await rank(start, [best], 'confirming', seedBase + CONFIRM_SEED_OFFSET) : { ...last, rows: [] };
  // The whole search, not only its last ranking.
  return { ...result, steps, simulationsRun: done, estimatedSimulations: p.workload.total };
}
