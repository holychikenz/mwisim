import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the simulation source files
const SRC_PATH = join(__dirname, '../../src/combatsimulator');

const { TRIAL_START_TIER } = await import('../../shared/trialLadder.js');
const { aggregateTrialResults } = await import('../../shared/guildTrialStats.js');
const { runDungeonRunsSerial, addRunIdleTime, DEFAULT_MAX_RUN_HOURS, ONE_HOUR_NS } = await import('../../shared/dungeonRuns.js');
const { buildCommunityBuffs } = await import('../../shared/communityBuffs.js');
const { runTrialIterations } = await import('../../shared/guildTrialRuns.js');
const { getTwinBackend, runTwin, twinZoneRequest } = await import('../../shared/twinEngine.js');
// CSIM_ENGINE (native|wasm; unset: native if built, else wasm) picks the Rust twin backend.
await (await import('./twin/index.mjs')).selectTwinFromEnv();

/**
 * Build extra buffs based on options
 *
 * Exported so the trigger optimiser (api/lib/triggerSearch/) resolves `extra`
 * to buffs exactly once, up front, and hands the resulting array to every
 * candidate simulation — rather than re-deriving it per run, or worse, deriving
 * it differently and scoring candidates against a subtly different build.
 */
export const buildExtraBuffs = buildCommunityBuffs;

/**
 * Run a combat simulation (main thread, no progress)
 *
 * With `maxRuns` (a dungeon only), the dungeon is simulated as that many runs,
 * each failed if still going after `maxRunDurationNs` (default 3 h), in
 * batches on the main thread and merged — see shared/dungeonRuns.js — and the
 * idle between runs is added once, to the merged total. Progress, if asked
 * for (runs mode only), is reported as { type: 'progress', progress }.
 */
export async function runSimulation({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra = {}, guildBuffs = [], maxRuns, maxRunDurationNs }, onProgress = null) {
  const args = { players: playersData, zone: zoneConfig, simulationTimeLimit, extra, guildBuffs };

  if (maxRuns != null) {
    if (!Number.isInteger(maxRuns) || maxRuns < 1) {
      throw new RangeError(`maxRuns must be a positive integer, got ${maxRuns}`);
    }
    const runDurationNs = maxRunDurationNs ?? DEFAULT_MAX_RUN_HOURS * ONE_HOUR_NS;
    if (!(runDurationNs > 0)) {
      throw new RangeError(`maxRunDurationNs must be greater than 0, got ${maxRunDurationNs}`);
    }
    const merged = await runDungeonRunsSerial({
      totalRuns: maxRuns,
      maxRunDurationNs: runDurationNs,
      runBatch: (n) => simulateOnMainThread(args, { maxRuns: n, maxRunDurationNs: runDurationNs }),
      onProgress: onProgress && ((progress) => onProgress({ type: 'progress', progress })),
    });
    return addRunIdleTime(merged);
  }

  // An hours-mode run with no positive limit simulates nothing (or forever).
  if (!(simulationTimeLimit > 0)) {
    throw new RangeError(`simulationTimeLimit must be greater than 0, got ${simulationTimeLimit}`);
  }
  return simulateOnMainThread(args);
}

/** One twin run — runSimulation's body. */
async function simulateOnMainThread({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra = {}, guildBuffs = [] }, runLimits) {
  // Guild SHRINE buffs are permanent character buffs and apply to every fight,
  // not just guild trials — mirrors the same concat in src/worker.js. Guild
  // BUILDING buffs are excluded here: those are trial-only.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs);

  return runTwin(getTwinBackend(), twinZoneRequest({ players: playersData, partyBuffs: extraBuffs, zone: zoneConfig, simulationTimeLimit, runLimits }));
}

/**
 * Run a guild-trial simulation headlessly (main thread, no worker).
 *
 * @param {object} args
 *   players[]        - player DTOs
 *   trialHrid        - e.g. "/guild_combat/badger"
 *   startTier        - default 100
 *   participantCount - default players.length; drives monster HP/speed/haste scaling
 *   iterations       - default 100
 *   trialOptions     - { bonusHpRegenRatio?, bonusMpRegenRatio?, enemyScale? }
 *                      enemyScale (default 1, clamped 0.05..5): debug knob that
 *                      scales the monsters' effective level (tier × scale);
 *                      ladder/rewards/reporting still use the true tier.
 *   guildBuffs[]     - guild shrine buff objects (applied as player extraBuffs)
 *   extra            - community/seal buff flags (see buildExtraBuffs)
 *   aggregateOptions - { buildersHallBonus?, treasuryBonus? } for reward calc
 * @returns { aggregate, summaries }
 */
export async function runGuildTrialSimulation({
  players: playersData,
  trialHrid,
  startTier = TRIAL_START_TIER,
  participantCount,
  iterations = 100,
  trialOptions = {},
  guildBuffs = [],
  extra = {},
  aggregateOptions = {},
} = {}) {
  // 0 used to return an all-zero aggregate here while the browser ran 1000.
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  }
  const summaries = await runTrialIterations({
    players: playersData,
    // Same contract as the browser worker: party-wide buffs plus each member's
    // own shrine/seal buffs, which callers keep on the DTOs.
    partyBuffs: buildExtraBuffs(extra).concat(guildBuffs),
    trialHrid,
    startTier,
    participantCount,
    trialOptions,
    iterations,
  });

  const aggregate = aggregateTrialResults(summaries, { startTier, ...aggregateOptions });
  return { aggregate, summaries };
}

/**
 * Load game data from JSON files
 */
export function loadGameData(dataName) {
  const validDataFiles = [
    'abilityDetailMap',
    'abilitySlotsLevelRequirementList',
    'achievementDetailMap',
    'achievementTierDetailMap',
    'actionDetailMap',
    'combatMonsterDetailMap',
    'combatStyleDetailMap',
    'combatTriggerComparatorDetailMap',
    'combatTriggerConditionDetailMap',
    'combatTriggerDependencyDetailMap',
    'damageTypeDetailMap',
    'enhancementLevelTotalBonusMultiplierTable',
    'guildTrialDetailMap',
    'houseRoomDetailMap',
    'itemDetailMap',
    'openableLootDropMap'
  ];

  if (!validDataFiles.includes(dataName)) {
    throw new Error(`Invalid data file: ${dataName}`);
  }

  const filePath = join(SRC_PATH, 'data', `${dataName}.json`);
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  return data;
}

/**
 * Get list of available zones from actionDetailMap
 */
export function getZones() {
  const actionDetailMap = loadGameData('actionDetailMap');
  const zones = [];

  for (const [hrid, action] of Object.entries(actionDetailMap)) {
    if (action.type === '/action_types/combat' && action.combatZoneInfo) {
      zones.push({
        hrid: hrid,
        name: action.name,
        isDungeon: action.combatZoneInfo.isDungeon || false,
        maxDifficulty: action.maxDifficulty ?? 5,
        combatLevel: action.levelRequirement?.level || 1
      });
    }
  }

  return zones.sort((a, b) => a.combatLevel - b.combatLevel);
}
