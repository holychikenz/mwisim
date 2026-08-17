// =============================================================================
// poolWorker — a reusable simulation worker for the trigger optimiser
//
// api/lib/simulationWorker.js is a ONE-SHOT script: it reads workerData, runs a
// single simulation, posts the result and exits. That is right for
// POST /api/simulate-stream, but the optimiser runs hundreds of simulations and
// paying the engine's module-load cost each time would dominate the run.
//
// So this is a message loop instead. It loads the engine once, then answers
// `run` messages until told to stop. Two further differences from the one-shot:
//
//   1. Math.random is replaced with a SEEDED generator before every run, so
//      candidates within a sweep face identical spawns. See rng.js for why this
//      lives here rather than in the engine.
//
//   2. It posts back SCORED METRICS, never the SimResult. A 72-hour SimResult
//      carries a large attacks histogram, and structured-cloning hundreds of
//      those across the thread boundary would cost more than the simulations.
//      Scoring in the worker keeps the message a dozen numbers wide.
// =============================================================================

import { parentPort } from 'worker_threads';

const CombatSimulator = (await import('../../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../../src/combatsimulator/player.js')).default;
const Zone = (await import('../../../src/combatsimulator/zone.js')).default;
const Labyrinth = (await import('../../../src/combatsimulator/labyrinth.js')).default;
const { installSeededRandom } = await import('./rng.js');
const { scoreSimResult } = await import('./score.js');

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
 * api/lib/simulationWorker.js.
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
    player.extraBuffs = extraBuffs;
    players.push(player);
  }

  return new CombatSimulator(players, zone, labyrinth, { enableHpMpVisualization: false });
}

async function runOne(job) {
  // Reinstalled per run: a fresh generator from the same seed gives every
  // candidate in a sweep the identical random stream, which is the whole point.
  const restoreRandom = installSeededRandom(job.seed);
  try {
    const simulator = buildRun(job);
    const simResult = await simulator.simulate(job.simulationTimeLimit);
    return { metrics: scoreSimResult(simResult, { consumableCosts: job.consumableCosts }) };
  } finally {
    restoreRandom();
  }
}

parentPort.on('message', async (message) => {
  if (message?.type === 'stop') {
    parentPort.close();
    return;
  }
  if (message?.type !== 'run') return;

  try {
    const { metrics } = await runOne(message.job);
    parentPort.postMessage({ type: 'result', id: message.job.id, metrics });
  } catch (error) {
    // A candidate that throws (an invalid trigger shape, MAX_TICKS exceeded)
    // must not take the run down with it — report and let it not compete.
    parentPort.postMessage({ type: 'result', id: message.job.id, error: error?.message || String(error) });
  }
});

parentPort.postMessage({ type: 'ready' });
