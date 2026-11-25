// =============================================================================
// runJob — one optimiser pool job, the same in every pool: seed Math.random,
// simulate (JS engine, or the Rust twin when a backend is given), score in the
// worker. Run by api/lib/triggerSearch/poolWorker.js (worker_threads) and
// ui/src/workers/optimizerSim.js (browser Web Workers). Why the seed and the
// in-worker scoring: see poolWorker.js.
// =============================================================================

const CombatSimulator = (await import('../../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../../src/combatsimulator/player.js')).default;
const Zone = (await import('../../../src/combatsimulator/zone.js')).default;
const Labyrinth = (await import('../../../src/combatsimulator/labyrinth.js')).default;
const { installSeededRandom } = await import('./rng.js');
const { scoreSimResult } = await import('./score.js');
const { runTwin, twinRunRequest } = await import('../../../shared/twinEngine.js');

/**
 * Zone and Labyrinth construction are both pure in their arguments, but each
 * carries mutable per-run state — encountersKilled / dungeonsCompleted on one,
 * attemptCount and the room's start time on the other — so every simulation
 * needs its own. Nothing to cache here; noted so nobody "optimises" it into a
 * shared instance.
 *
 * Exactly one of `zoneConfig` / `labyrinthConfig` is set; the route guarantees
 * it (api/lib/target.js normaliseTarget). Whichever is absent must be passed as
 * an explicit null: omitting the labyrinth argument puts the options object in
 * its slot, and startNewEncounter() then calls this.labyrinth.getMonster() and
 * throws on the first encounter. Same trap documented in
 * api/lib/simulator.js simulateOnMainThread.
 */
function buildRun({ playersData, zoneConfig, labyrinthConfig, extraBuffs }) {
  const zone = zoneConfig ? new Zone(zoneConfig.zoneHrid, zoneConfig.difficultyTier) : null;
  // Supply crates become the labyrinth's buffs, exactly as src/worker.js does.
  // The lab-shop upgrades are NOT here: they are character upgrades and arrive
  // folded into extraBuffs by the route (target.js targetExtraBuffs).
  const labyrinth = labyrinthConfig
    ? new Labyrinth(labyrinthConfig.labyrinthHrid, labyrinthConfig.roomLevel, labyrinthConfig.crates || [])
    : null;

  const players = [];
  for (let i = 0; i < playersData.length; i += 1) {
    const player = Player.createFromDTO(structuredClone(playersData[i]));
    player.zoneBuffs = zone?.buffs || labyrinth?.buffs || [];
    // Per-player tail after the shared list — the candidate DTOs are deep
    // clones of the baseline (triggerSearch/params.js applyValues), so each one
    // still carries its own shrines and seals. Without this concat the search
    // would tune thresholds against an unbuffed character.
    player.extraBuffs = extraBuffs.concat(playersData[i].extraBuffs || []);
    players.push(player);
  }

  return new CombatSimulator(players, zone, labyrinth);
}

/** The same run on the twin: the request builders apply zone/crate buffs and the per-player extraBuffs tail. */
function twinRun(twin, { playersData: players, zoneConfig: zone, labyrinthConfig, extraBuffs: partyBuffs, simulationTimeLimit }) {
  // `crates || []` is buildRun's; absent or null crates are none on the twin as well, so it changes nothing.
  const labyrinth = labyrinthConfig && { ...labyrinthConfig, crates: labyrinthConfig.crates || [] };
  return runTwin(twin, twinRunRequest({ players, partyBuffs, zone, labyrinth, simulationTimeLimit }));
}

/** One pool job, seeded and scored: on the twin backend `twin` ({ run }), or on the JS engine when null. */
export async function runJob(job, twin) {
  // Reinstalled per run: a fresh generator from the same seed gives every
  // candidate in a sweep the identical random stream, which is the whole point.
  const restoreRandom = installSeededRandom(job.seed);
  try {
    const simResult = twin ? await twinRun(twin, job) : await buildRun(job).simulate(job.simulationTimeLimit);
    return { metrics: scoreSimResult(simResult, { consumableCosts: job.consumableCosts, dropCreditCosts: job.dropCreditCosts }) };
  } finally {
    restoreRandom();
  }
}
