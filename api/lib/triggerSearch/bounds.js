// =============================================================================
// bounds — derive real ceilings for absolute thresholds from the zone and party
//
// An absolute threshold like `current_hp >= N` needs a sensible upper bound for
// N, and guessing wastes the search: too low and the optimum lies outside the
// grid, too high and most grid points are behaviourally identical. So we read
// the ceilings out of the game data.
//
// Enemy side — enumerate every spawn combination the zone permits within its
// maxSpawnCount / maxTotalStrength budget, instantiate each monster to read its
// combat details, and keep the largest achievable total (for `all_enemies`) and
// the largest single monster (for `targeted_enemy`). Boss waves and every
// dungeon wave are folded in the same way, since a threshold has to hold for
// the whole run, not just the common encounter.
//
// Party side — build each Player from its DTO exactly as the simulator will
// (zoneBuffs + extraBuffs, generatePermanentBuffs, reset), then read
// maxHitpoints / maxManapoints. This is the same path api/lib/labStats.js
// takes, and it matters: a `self` + `current_hp` ceiling is the *player's*
// maximum, not the enemy's. The peer fork gets this wrong.
// =============================================================================

const Monster = (await import('../../../src/combatsimulator/monster.js')).default;
const Player = (await import('../../../src/combatsimulator/player.js')).default;
const { actionDetailMap } = await import('../../../src/combatsimulator/dataProvider.js');

/** Fallback when a zone cannot be resolved. Matches the peer's 10000. */
const FALLBACK_HP = 10000;

/**
 * Guard against combinatorial blow-up. The enumeration is
 * O(spawns ^ maxSpawnCount); with eight spawn types and six slots that is
 * ~260k nodes of trivial arithmetic, which is fine — but game data can change,
 * and a request handler must not be allowed to spin.
 */
const MAX_ENUMERATION_NODES = 500_000;

/**
 * Monster combat details are pure functions of (hrid, difficultyTier), and the
 * enumeration revisits the same pairs constantly. Constructing a Monster and
 * calling updateCombatDetails is not cheap, so memoise.
 */
const monsterCache = new Map();

function monsterVitals(monsterHrid, difficultyTier) {
  const key = `${monsterHrid}|${difficultyTier}`;
  const cached = monsterCache.get(key);
  if (cached) return cached;

  let vitals = { maxHitpoints: 1, maxManapoints: 1 };
  try {
    const monster = new Monster(String(monsterHrid), Number(difficultyTier) || 0);
    monster.updateCombatDetails();
    vitals = {
      maxHitpoints: Math.max(1, Number(monster.combatDetails?.maxHitpoints) || 1),
      maxManapoints: Math.max(1, Number(monster.combatDetails?.maxManapoints) || 1),
    };
  } catch {
    // An unknown monster hrid in the spawn table: fall through with the
    // conservative 1 rather than aborting the whole bounds computation.
  }

  monsterCache.set(key, vitals);
  return vitals;
}

/** Zero-valued accumulator for a wave that contributes nothing. */
function emptyWave() {
  return { totalHitpoints: 1, totalManapoints: 1, targetHitpoints: 1, targetManapoints: 1, maxSpawnCount: 1 };
}

function mergeWave(into, wave) {
  return {
    totalHitpoints: Math.max(into.totalHitpoints, wave.totalHitpoints),
    totalManapoints: Math.max(into.totalManapoints, wave.totalManapoints),
    targetHitpoints: Math.max(into.targetHitpoints, wave.targetHitpoints),
    targetManapoints: Math.max(into.targetManapoints, wave.targetManapoints),
    maxSpawnCount: Math.max(into.maxSpawnCount, wave.maxSpawnCount),
  };
}

/**
 * Largest achievable wave from a randomSpawnInfo block.
 *
 * @param {object} spawnInfo  { maxSpawnCount, maxTotalStrength, spawns[] }
 * @param {number} difficultyTier  zone tier, added to each spawn's own tier
 */
export function boundsFromSpawnInfo(spawnInfo, difficultyTier = 0) {
  if (!spawnInfo || !Array.isArray(spawnInfo.spawns) || spawnInfo.spawns.length === 0) {
    return emptyWave();
  }

  const slots = Math.max(1, Math.floor(Number(spawnInfo.maxSpawnCount) || 1));
  const strengthBudget = Number.isFinite(Number(spawnInfo.maxTotalStrength))
    ? Math.max(0, Number(spawnInfo.maxTotalStrength))
    : Infinity;

  let bestTotalHp = 1;
  let bestTotalMp = 1;
  let bestSingleHp = 1;
  let bestSingleMp = 1;
  let bestCount = 1;
  let nodes = 0;

  // Depth-first over "how many more monsters can I add within budget", keeping
  // the maximum accumulated hitpoints seen. Not a knapsack solve — strength and
  // hitpoints are only loosely correlated in the data, so exhaustive is both
  // simpler and exact.
  const walk = (depth, strengthUsed, accumulatedHp, accumulatedMp, count) => {
    if (nodes++ > MAX_ENUMERATION_NODES) return;
    bestTotalHp = Math.max(bestTotalHp, accumulatedHp);
    bestTotalMp = Math.max(bestTotalMp, accumulatedMp);
    bestCount = Math.max(bestCount, count);
    if (depth >= slots) return;

    for (const spawn of spawnInfo.spawns) {
      const nextStrength = strengthUsed + Math.max(0, Number(spawn.strength) || 0);
      if (nextStrength > strengthBudget) continue;
      const vitals = monsterVitals(spawn.combatMonsterHrid, difficultyTier + (Number(spawn.difficultyTier) || 0));
      bestSingleHp = Math.max(bestSingleHp, vitals.maxHitpoints);
      bestSingleMp = Math.max(bestSingleMp, vitals.maxManapoints);
      walk(depth + 1, nextStrength, accumulatedHp + vitals.maxHitpoints, accumulatedMp + vitals.maxManapoints, count + 1);
    }
  };
  walk(0, 0, 0, 0, 0);

  return {
    totalHitpoints: bestTotalHp,
    totalManapoints: bestTotalMp,
    targetHitpoints: bestSingleHp,
    targetManapoints: bestSingleMp,
    maxSpawnCount: bestCount,
  };
}

/** A fixed list of spawns forming one encounter (boss wave, dungeon wave). */
function boundsFromFixedSpawns(spawns, difficultyTier = 0) {
  if (!Array.isArray(spawns) || spawns.length === 0) return emptyWave();
  let totalHp = 0;
  let totalMp = 0;
  let singleHp = 1;
  let singleMp = 1;
  for (const spawn of spawns) {
    const vitals = monsterVitals(spawn.combatMonsterHrid, difficultyTier + (Number(spawn.difficultyTier) || 0));
    totalHp += vitals.maxHitpoints;
    totalMp += vitals.maxManapoints;
    singleHp = Math.max(singleHp, vitals.maxHitpoints);
    singleMp = Math.max(singleMp, vitals.maxManapoints);
  }
  return {
    totalHitpoints: Math.max(1, totalHp),
    totalManapoints: Math.max(1, totalMp),
    targetHitpoints: singleHp,
    targetManapoints: singleMp,
    maxSpawnCount: Math.max(1, spawns.length),
  };
}

/**
 * Enemy-side ceilings for a whole zone, across common encounters, boss waves
 * and (for dungeons) every fixed and random wave.
 *
 * @param {string} zoneHrid
 * @param {number} difficultyTier
 */
export function deriveEnemyBounds(zoneHrid, difficultyTier = 0) {
  const zone = actionDetailMap[zoneHrid];
  const info = zone?.combatZoneInfo;
  if (!info) {
    return {
      totalHitpoints: FALLBACK_HP,
      totalManapoints: FALLBACK_HP,
      targetHitpoints: FALLBACK_HP,
      targetManapoints: FALLBACK_HP,
      maxSpawnCount: 1,
      resolved: false,
    };
  }

  let merged = emptyWave();

  const fight = info.fightInfo || {};
  merged = mergeWave(merged, boundsFromSpawnInfo(fight.randomSpawnInfo, difficultyTier));
  if (Array.isArray(fight.bossSpawns) && fight.bossSpawns.length) {
    merged = mergeWave(merged, boundsFromFixedSpawns(fight.bossSpawns, difficultyTier));
  }

  const dungeon = info.dungeonInfo || {};
  if (dungeon.fixedSpawnsMap && typeof dungeon.fixedSpawnsMap === 'object') {
    for (const spawns of Object.values(dungeon.fixedSpawnsMap)) {
      merged = mergeWave(merged, boundsFromFixedSpawns(spawns, difficultyTier));
    }
  }
  if (dungeon.randomSpawnInfoMap && typeof dungeon.randomSpawnInfoMap === 'object') {
    for (const spawnInfo of Object.values(dungeon.randomSpawnInfoMap)) {
      merged = mergeWave(merged, boundsFromSpawnInfo(spawnInfo, difficultyTier));
    }
  }

  return { ...merged, resolved: true };
}

/**
 * Party-side ceilings. Mirrors api/lib/labStats.js computeLabPlayerStats: build
 * the Player, hand it the same buffs the simulator will, generate permanent
 * buffs, reset to combat-start state, then read the derived maxima.
 *
 * @param {object[]} playerDTOs
 * @param {object} [opts]
 * @param {object[]} [opts.zoneBuffs]
 * @param {object[]} [opts.extraBuffs]
 */
export function derivePlayerBounds(playerDTOs, { zoneBuffs = [], extraBuffs = [] } = {}) {
  const players = (playerDTOs || []).map((dto) => {
    try {
      const player = Player.createFromDTO(structuredClone(dto));
      player.zoneBuffs = zoneBuffs;
      player.extraBuffs = extraBuffs;
      player.generatePermanentBuffs();
      player.reset();
      return {
        hrid: dto.hrid,
        maxHitpoints: Math.max(1, Number(player.combatDetails?.maxHitpoints) || 1),
        maxManapoints: Math.max(1, Number(player.combatDetails?.maxManapoints) || 1),
      };
    } catch {
      // A malformed DTO would throw later in the simulation anyway; give it a
      // usable ceiling so bounds derivation is not the thing that fails.
      return { hrid: dto?.hrid, maxHitpoints: FALLBACK_HP, maxManapoints: FALLBACK_HP };
    }
  });

  const party = players.reduce(
    (acc, player) => ({
      maxHitpoints: acc.maxHitpoints + player.maxHitpoints,
      maxManapoints: acc.maxManapoints + player.maxManapoints,
      size: acc.size + 1,
    }),
    { maxHitpoints: 0, maxManapoints: 0, size: 0 }
  );

  return {
    players,
    party: {
      maxHitpoints: Math.max(1, party.maxHitpoints),
      maxManapoints: Math.max(1, party.maxManapoints),
      size: Math.max(1, party.size),
    },
  };
}

/**
 * Everything resolveMaxValue needs, in one object.
 *
 * @param {object} args
 * @param {object[]} args.playerDTOs
 * @param {{zoneHrid: string, difficultyTier?: number}} args.zone
 * @param {object[]} [args.extraBuffs]
 * @returns {{players: object[], party: object, enemies: object}}
 */
export function deriveBounds({ playerDTOs, zone, extraBuffs = [] }) {
  const zoneData = actionDetailMap[zone?.zoneHrid];
  // Zone buffs affect max HP/MP, so they must be applied before reading maxima
  // — exactly as runSimulation does at api/lib/simulator.js:123.
  const zoneBuffs = zoneData?.buffs || [];

  return {
    ...derivePlayerBounds(playerDTOs, { zoneBuffs, extraBuffs }),
    enemies: deriveEnemyBounds(zone?.zoneHrid, Number(zone?.difficultyTier) || 0),
  };
}

/** Testing seam — the monster cache is process-lifetime by design. */
export function clearMonsterCache() {
  monsterCache.clear();
}
