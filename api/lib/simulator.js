import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the simulation source files
const SRC_PATH = join(__dirname, '../../src/combatsimulator');

// Dynamic import the simulation classes (for non-worker simulation)
const CombatSimulator = (await import('../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../src/combatsimulator/player.js')).default;
const Zone = (await import('../../src/combatsimulator/zone.js')).default;
const GuildTrial = (await import('../../src/combatsimulator/guildTrial.js')).default;
const { aggregateTrialResults } = await import('../../src/combatsimulator/guildTrialStats.js');
const { runDungeonRunsSerial, addRunIdleTime, DEFAULT_MAX_RUN_HOURS, ONE_HOUR_NS } = await import('../../shared/dungeonRuns.js');
const { buildCommunityBuffs } = await import('../../shared/communityBuffs.js');
const { runTrialIterations } = await import('../../shared/guildTrialRuns.js');

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
    const runDurationNs = maxRunDurationNs ?? DEFAULT_MAX_RUN_HOURS * ONE_HOUR_NS;
    const merged = await runDungeonRunsSerial({
      totalRuns: maxRuns,
      maxRunDurationNs: runDurationNs,
      runBatch: (n) => simulateOnMainThread(args, { maxRuns: n, maxRunDurationNs: runDurationNs }),
      onProgress: onProgress && ((progress) => onProgress({ type: 'progress', progress })),
    });
    return addRunIdleTime(merged);
  }

  return simulateOnMainThread(args);
}

/** One simulate() on a fresh Zone and fresh players — runSimulation's main-thread body. */
async function simulateOnMainThread({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra = {}, guildBuffs = [] }, runLimits) {
  // Main thread (faster for small simulations)
  // Guild SHRINE buffs are permanent character buffs and apply to every fight,
  // not just guild trials — mirrors the same concat in src/worker.js. Guild
  // BUILDING buffs are excluded here: those are trial-only.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs);

  // Create Zone
  const zone = new Zone(zoneConfig.zoneHrid, zoneConfig.difficultyTier);

  // Create Player objects from DTOs
  const players = [];
  for (let i = 0; i < playersData.length; i++) {
    const currentPlayer = Player.createFromDTO(structuredClone(playersData[i]));
    currentPlayer.zoneBuffs = zone.buffs;
    // Shared buffs first, this unit's own tail after. Shrines are bought per
    // guild member and seals are equipped per character, so the UI resolves
    // both per player and hangs them off the DTO — the same concat src/worker.js
    // does in its `start_simulation` and `start_guild_trial` cases (named rather
    // than cited by line, so this reference cannot rot). A DTO without
    // `extraBuffs` yields the old behaviour exactly; Player.createFromDTO
    // ignores the field, so it reaches this line only via the DTO itself.
    currentPlayer.extraBuffs = extraBuffs.concat(playersData[i].extraBuffs || []);
    players.push(currentPlayer);
  }

  // `labyrinth` is the third positional arg: pass null explicitly. Omitting it
  // made `this.labyrinth` truthy, and startNewEncounter() calls
  // this.labyrinth.getMonster() unconditionally, throwing on the first encounter.
  const combatSimulator = new CombatSimulator(players, zone, null);

  // Run simulation
  const simResult = await combatSimulator.simulate(simulationTimeLimit, runLimits);

  return simResult;
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
  startTier = GuildTrial.START_TIER,
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
        combatLevel: action.levelRequirement?.level || 1
      });
    }
  }

  return zones.sort((a, b) => a.combatLevel - b.combatLevel);
}
