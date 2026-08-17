// =============================================================================
// target — what an optimiser run is fought against: a zone, or a labyrinth room
//
// Until now both optimisers took a `zone` and nothing else, and every layer
// below them said `zoneConfig` because there was only ever one kind of fight.
// The labyrinth is the second kind, and it differs in four ways that reach all
// the way down to the worker:
//
//   1. ONE MONSTER, SCALED BY ROOM LEVEL — not a spawn table with a strength
//      budget. So the trigger optimiser's enemy ceilings come from a single
//      Monster instance rather than an enumeration (see bounds.js).
//
//   2. NO CONSUMABLES. The game confiscates food, drinks and teas at the door;
//      supply crates are the only nutrition inside. Both the browser worker and
//      MWIX's labyrinth-sim enforce this, and the old webpack UI does not —
//      which is exactly why its predicted clear rates are too high. An API run
//      that let the build eat would be wrong in the same direction, so the
//      stripping happens HERE, on the server, rather than being left to the
//      caller to remember.
//
//   3. TWO EXTRA BUFF SOURCES. Supply crates become zoneBuffs; the lab-shop
//      combat upgrades become extraBuffs. Both are labyrinth-only.
//
//   4. A 120 s ROOM TIMER. Nothing to configure — the engine schedules it — but
//      it is why a labyrinth run has *attempts* as well as clears, and therefore
//      why it has a clear rate at all.
//
// Everything the two kinds of target have in common lives here, so a route, a
// bounds derivation and a pool worker cannot disagree about what was asked for.
// =============================================================================

const { labyrinthCrateDetailMap, combatMonsterDetailMap } =
  await import('../../src/combatsimulator/dataProvider.js');

/** Room levels the UI offers. Clamped rather than rejected — see normaliseTarget. */
export const MIN_ROOM_LEVEL = 1;
export const MAX_ROOM_LEVEL = 500;

/** Lab-shop upgrade levels are bounded by the shop, not by us; this is a guard. */
export const MAX_LAB_UPGRADE_LEVEL = 40;

/**
 * Lab-shop combat upgrades: each purchased level is +1%, as a ratio boost on
 * damage and attack speed and a flat boost on cast speed and critical rate.
 *
 * MIRROR of src/worker.js buildLabUpgradeBuffs (and formerly of a private copy
 * in labStats.js, which now imports this one). Keep the three in step: the
 * browser worker's copy is the reference, because it is what a normal labyrinth
 * simulation runs, and an optimiser that buffed differently would be tuning a
 * build the user cannot actually field.
 */
const LAB_UPGRADE_RATIO_STEP = 0.01;
const LAB_UPGRADE_DEFS = [
  ['combatDamage', 'combat_damage', '/buff_types/damage', 'ratioBoost'],
  ['attackSpeed', 'attack_speed', '/buff_types/attack_speed', 'ratioBoost'],
  ['castSpeed', 'cast_speed', '/buff_types/cast_speed', 'flatBoost'],
  ['criticalRate', 'critical_rate', '/buff_types/critical_rate', 'flatBoost'],
];

/**
 * @param {object} [labUpgrades]  { combatDamage, attackSpeed, castSpeed, criticalRate }
 * @returns {object[]} buff objects, empty when nothing is purchased
 */
export function buildLabUpgradeBuffs(labUpgrades = {}) {
  const buffs = [];
  for (const [field, key, typeHrid, valueKey] of LAB_UPGRADE_DEFS) {
    const level = Math.max(0, Math.floor(Number(labUpgrades?.[field]) || 0));
    if (level <= 0) continue;
    buffs.push({
      uniqueHrid: `/buff_uniques/labyrinth_upgrade_${key}`,
      typeHrid,
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0,
      flatBoostLevelBonus: 0,
      [valueKey]: Math.min(MAX_LAB_UPGRADE_LEVEL, level) * LAB_UPGRADE_RATIO_STEP,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    });
  }
  return buffs;
}

/**
 * Supply-crate buffs, dropping unknown crate hrids.
 *
 * The engine's Labyrinth constructor concatenates blindly, so an unrecognised
 * crate puts `undefined` into the buff list and the first buff walk throws. A
 * request handler must not be able to be crashed by a typo in a POST body.
 *
 * @param {string[]} [crates]
 * @returns {object[]}
 */
export function buildCrateBuffs(crates = []) {
  let buffs = [];
  for (const crate of crates || []) {
    const crateBuffs = labyrinthCrateDetailMap[crate];
    if (crateBuffs) buffs = buffs.concat(crateBuffs);
  }
  return buffs;
}

/** Crate hrids the engine knows about, for validation and for the tests. */
export function knownCrates() {
  return Object.keys(labyrinthCrateDetailMap);
}

/**
 * Blank every food and drink slot.
 *
 * Returns a fresh array; the caller's DTOs are never mutated, because the same
 * baseline set is used for the trigger enumeration (which must still SEE the
 * consumables, in order to explain why it is not offering them).
 *
 * @param {object[]} playerDTOs
 * @returns {object[]}
 */
export function stripConsumables(playerDTOs) {
  return (playerDTOs || []).map((dto) => ({
    ...dto,
    food: [null, null, null],
    drinks: [null, null, null],
  }));
}

/**
 * Resolve `body.zone` / `body.labyrinth` into one validated target.
 *
 * A body carrying both is rejected rather than silently preferring one: the two
 * produce different objectives and different bounds, and guessing which the user
 * meant is precisely the sort of quiet decision that makes a number untrustworthy.
 *
 * @param {object} body
 * @returns {{kind: 'zone'|'labyrinth', zone: object|null, labyrinth: object|null, error: string|null}}
 */
export function normaliseTarget(body = {}) {
  const zone = body.zone && body.zone.zoneHrid ? body.zone : null;
  const labyrinth = body.labyrinth && body.labyrinth.labyrinthHrid ? body.labyrinth : null;

  if (zone && labyrinth) {
    return { kind: 'zone', zone: null, labyrinth: null, error: 'Send either a zone or a labyrinth, not both' };
  }
  if (!zone && !labyrinth) {
    return { kind: 'zone', zone: null, labyrinth: null, error: 'Zone or labyrinth configuration is required' };
  }

  if (zone) {
    return {
      kind: 'zone',
      zone: { zoneHrid: String(zone.zoneHrid), difficultyTier: Number(zone.difficultyTier) || 0 },
      labyrinth: null,
      error: null,
    };
  }

  const monsterHrid = String(labyrinth.labyrinthHrid);
  const monster = combatMonsterDetailMap[monsterHrid];
  if (!monster) {
    return { kind: 'labyrinth', zone: null, labyrinth: null, error: `Unknown labyrinth monster ${monsterHrid}` };
  }
  if (!monster.isLabyrinthMonster) {
    // Not pedantry: Monster's room-level scaling path is only meaningful for the
    // ten labyrinth monsters, and a zone monster fed through it produces a
    // creature that exists nowhere in the game.
    return { kind: 'labyrinth', zone: null, labyrinth: null, error: `${monster.name} is not a labyrinth monster` };
  }

  const roomLevel = Math.min(
    MAX_ROOM_LEVEL,
    Math.max(MIN_ROOM_LEVEL, Math.floor(Number(labyrinth.roomLevel) || 0) || MIN_ROOM_LEVEL)
  );

  // Crates arrive as an array of hrids (the UI's three categories, nulls
  // filtered). Unknown ones are dropped here as well as in buildCrateBuffs, so
  // the echoed-back target tells the user what was actually applied.
  const crates = (Array.isArray(labyrinth.crates) ? labyrinth.crates : [])
    .map(String)
    .filter((crate) => !!labyrinthCrateDetailMap[crate]);

  const upgrades = {};
  for (const [field] of LAB_UPGRADE_DEFS) {
    upgrades[field] = Math.min(
      MAX_LAB_UPGRADE_LEVEL,
      Math.max(0, Math.floor(Number(labyrinth.upgrades?.[field]) || 0))
    );
  }

  return {
    kind: 'labyrinth',
    zone: null,
    labyrinth: { labyrinthHrid: monsterHrid, roomLevel, crates, upgrades },
    error: null,
  };
}

/**
 * The buffs a target adds on top of the caller's community / seal / guild ones.
 *
 * Zone buffs are read by the worker from the Zone itself, so only the labyrinth
 * contributes here — its lab-shop upgrades, which are character upgrades and
 * therefore extraBuffs rather than zoneBuffs.
 *
 * @param {{kind: string, labyrinth: object|null}} target
 * @returns {object[]}
 */
export function targetExtraBuffs(target) {
  if (target?.kind !== 'labyrinth') return [];
  return buildLabUpgradeBuffs(target.labyrinth?.upgrades);
}

/**
 * The player DTOs a target should actually be simulated with.
 *
 * @param {object[]} playerDTOs
 * @param {{kind: string}} target
 * @returns {object[]}
 */
export function targetPlayerDTOs(playerDTOs, target) {
  return target?.kind === 'labyrinth' ? stripConsumables(playerDTOs) : playerDTOs;
}
