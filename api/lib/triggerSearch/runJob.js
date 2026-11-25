// =============================================================================
// runJob — one optimiser pool job, the same in every pool: seed Math.random,
// simulate on the Rust twin backend, score in the worker. Run by
// api/lib/triggerSearch/poolWorker.js (worker_threads) and
// ui/src/workers/optimizerSim.js (browser Web Workers). Why the seed and the
// in-worker scoring: see poolWorker.js.
// =============================================================================

const { installSeededRandom } = await import('./rng.js');
const { scoreSimResult } = await import('./score.js');
const { runTwin, twinRunRequest } = await import('../../../shared/twinEngine.js');

/**
 * Exactly one of `zoneConfig` / `labyrinthConfig` is set; the route guarantees
 * it (api/lib/target.js normaliseTarget). The request builders apply zone/crate
 * buffs and the per-player extraBuffs tail: the candidate DTOs are deep clones
 * of the baseline (triggerSearch/params.js applyValues), so each still carries
 * its own shrines and seals. The lab-shop upgrades arrive folded into
 * extraBuffs by the route (target.js targetExtraBuffs).
 */
function twinRun(twin, { playersData: players, zoneConfig: zone, labyrinthConfig, extraBuffs: partyBuffs, simulationTimeLimit }) {
  const labyrinth = labyrinthConfig && { ...labyrinthConfig, crates: labyrinthConfig.crates || [] };
  return runTwin(twin, twinRunRequest({ players, partyBuffs, zone, labyrinth, simulationTimeLimit }));
}

/** One pool job, seeded and scored, on the twin backend `twin` ({ run }). */
export async function runJob(job, twin) {
  // Reinstalled per run: a fresh generator from the same seed gives every
  // candidate in a sweep the identical random stream, which is the whole point.
  const restoreRandom = installSeededRandom(job.seed);
  try {
    const simResult = await twinRun(twin, job);
    return { metrics: scoreSimResult(simResult, { consumableCosts: job.consumableCosts, dropCreditCosts: job.dropCreditCosts }) };
  } finally {
    restoreRandom();
  }
}
