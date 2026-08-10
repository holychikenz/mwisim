import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { Worker } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the simulation source files
const SRC_PATH = join(__dirname, '../../src/combatsimulator');

// Dynamic import the simulation classes (for non-worker simulation)
const CombatSimulator = (await import('../../src/combatsimulator/combatSimulator.js')).default;
const Player = (await import('../../src/combatsimulator/player.js')).default;
const Zone = (await import('../../src/combatsimulator/zone.js')).default;
const GuildTrial = (await import('../../src/combatsimulator/guildTrial.js')).default;
const { extractTrialSummary, aggregateTrialResults } =
  await import('../../src/combatsimulator/guildTrialStats.js');

/**
 * Build extra buffs based on options
 */
function buildExtraBuffs(extra = {}) {
  const extraBuffs = [];

  if (extra.mooPass) {
    extraBuffs.push({
      "uniqueHrid": "/buff_uniques/experience_moo_pass_buff",
      "typeHrid": "/buff_types/wisdom",
      "ratioBoost": 0,
      "ratioBoostLevelBonus": 0,
      "flatBoost": 0.05,
      "flatBoostLevelBonus": 0,
      "startTime": "0001-01-01T00:00:00Z",
      "duration": 0
    });
  }

  if (extra.comExp > 0) {
    extraBuffs.push({
      "uniqueHrid": "/buff_uniques/experience_community_buff",
      "typeHrid": "/buff_types/wisdom",
      "ratioBoost": 0,
      "ratioBoostLevelBonus": 0,
      "flatBoost": 0.005 * (extra.comExp - 1) + 0.2,
      "flatBoostLevelBonus": 0,
      "startTime": "0001-01-01T00:00:00Z",
      "duration": 0
    });
  }

  if (extra.comDrop > 0) {
    extraBuffs.push({
      "uniqueHrid": "/buff_uniques/combat_community_buff",
      "typeHrid": "/buff_types/combat_drop_quantity",
      "ratioBoost": 0,
      "ratioBoostLevelBonus": 0,
      "flatBoost": 0.005 * (extra.comDrop - 1) + 0.2,
      "flatBoostLevelBonus": 0,
      "startTime": "0001-01-01T00:00:00Z",
      "duration": 0
    });
  }

  return extraBuffs;
}

/**
 * Run a combat simulation using worker thread (supports progress)
 */
export function runSimulationWithWorker({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra = {}, guildBuffs = [] }, onProgress = null) {
  return new Promise((resolve, reject) => {
    // Shrine buffs apply to all combat — see runSimulation / src/worker.js.
    const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs);
    const workerPath = join(__dirname, 'simulationWorker.js');

    const worker = new Worker(workerPath, {
      workerData: {
        playersData,
        zoneConfig,
        simulationTimeLimit,
        extraBuffs
      }
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg);
      } else if (msg.type === 'result') {
        resolve(msg.result);
      } else if (msg.type === 'error') {
        reject(new Error(msg.error));
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

/**
 * Run a combat simulation (main thread, no progress)
 */
export async function runSimulation({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra = {}, guildBuffs = [] }, onProgress = null) {
  // If progress callback is provided, use worker thread
  if (onProgress) {
    return runSimulationWithWorker({ players: playersData, zone: zoneConfig, simulationTimeLimit, extra, guildBuffs }, onProgress);
  }

  // Otherwise run on main thread (faster for small simulations)
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
    currentPlayer.extraBuffs = extraBuffs;
    players.push(currentPlayer);
  }

  // Create simulator
  const enableHpMpVisualization = extra.enableHpMpVisualization || false;
  const combatSimulator = new CombatSimulator(players, zone, { enableHpMpVisualization });

  // Run simulation
  const simResult = await combatSimulator.simulate(simulationTimeLimit);

  return simResult;
}

/**
 * Run a guild-trial simulation headlessly (main thread, no worker).
 *
 * @param {object} args
 *   players[]        - player DTOs
 *   trialHrid        - e.g. "/guild_combat/badger"
 *   startTier        - default 100
 *   participantCount - default players.length; drives +1% HP scaling
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
  const communityBuffs = buildExtraBuffs(extra);
  const trialExtraBuffs = communityBuffs.concat(guildBuffs);

  const summaries = [];
  for (let it = 0; it < iterations; it++) {
    const players = [];
    for (let i = 0; i < playersData.length; i++) {
      const p = Player.createFromDTO(structuredClone(playersData[i]));
      p.zoneBuffs = []; // no labyrinth crates in trials
      p.extraBuffs = trialExtraBuffs;
      players.push(p);
    }
    const pc = participantCount ?? players.length;
    const guildTrial = new GuildTrial(trialHrid, startTier, pc, trialOptions);
    const combatSimulator = new CombatSimulator(players, null, null, { guildTrial });
    const simResult = await combatSimulator.simulate(GuildTrial.TRIAL_DURATION_NS);
    summaries.push(extractTrialSummary(simResult));
  }

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
