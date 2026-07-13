// =============================================================================
// labStats — compute the simulator's lab-scaled stats (player + monster) so a
// parity harness can diff them against numbers recorded from the live game.
//
// Both computations reproduce exactly what the engine uses in a labyrinth run:
//   - Monster: spawned and scaled by room level (deterministic; no loadout).
//   - Player:  built from a DTO, given the crate buffs (zoneBuffs) + lab-shop
//     upgrade buffs (extraBuffs) exactly as src/worker.js does, then reset
//     (clearBuffs → updateCombatDetails) — the same path processCombatStartEvent
//     drives, so the result matches SimResult.playerStats.
// =============================================================================

const Player = (await import('../../src/combatsimulator/player.js')).default;
const Monster = (await import('../../src/combatsimulator/monster.js')).default;
const { abilityDetailMap, labyrinthCrateDetailMap } =
  await import('../../src/combatsimulator/dataProvider.js');

function round(v) {
  return typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;
}

// Top-level combatDetails holds the DERIVED stats (totalArmor, resistances,
// accuracy/damage/evasion ratings, levels, max HP/MP, ...) — what the game's
// sheet shows. The nested combatStats object holds the *base* inputs; we skip
// it here, but surface the one derived combatStat worth tracking.
const TRANSIENT = new Set(['currentHitpoints', 'currentManapoints']);

function extractDerived(combatDetails) {
  const derived = {};
  for (const [k, v] of Object.entries(combatDetails)) {
    if (TRANSIENT.has(k)) continue; // combat state, not a stat-sheet value
    if (v === null || typeof v !== 'object') derived[k] = round(v);
  }
  // attackInterval is stored in nanoseconds; surface seconds to match the game.
  derived.attackIntervalSeconds = round(combatDetails.combatStats.attackInterval / 1e9);
  return derived;
}

export function computeLabMonsterStats(monsterHrid, roomLevel) {
  const m = new Monster(monsterHrid, 0, roomLevel);
  m.updateCombatDetails(); // re-copies base then scales; idempotent.
  return {
    monsterHrid,
    roomLevel,
    derived: extractDerived(m.combatDetails),
    abilities: (m.abilities || []).filter(Boolean).map((a) => ({
      hrid: a.hrid,
      name: abilityDetailMap[a.hrid]?.name,
      level: a.level,
    })),
  };
}

// Mirror of src/worker.js's labyrinth lab-shop upgrade block: each purchased
// upgrade level is +1% (ratio) or a flat boost. Keep in sync with worker.js.
const LAB_UPGRADE_RATIO_STEP = 0.01;
const LAB_UPGRADE_DEFS = [
  ['combatDamage', 'combat_damage', '/buff_types/damage', 'ratioBoost'],
  ['attackSpeed', 'attack_speed', '/buff_types/attack_speed', 'ratioBoost'],
  ['castSpeed', 'cast_speed', '/buff_types/cast_speed', 'flatBoost'],
  ['criticalRate', 'critical_rate', '/buff_types/critical_rate', 'flatBoost'],
];

function buildLabUpgradeBuffs(labUpgrades = {}) {
  const buffs = [];
  for (const [field, key, typeHrid, valueKey] of LAB_UPGRADE_DEFS) {
    const lv = Math.max(0, Math.floor(Number(labUpgrades[field]) || 0));
    if (lv <= 0) continue;
    buffs.push({
      uniqueHrid: `/buff_uniques/labyrinth_upgrade_${key}`,
      typeHrid,
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0,
      flatBoostLevelBonus: 0,
      [valueKey]: lv * LAB_UPGRADE_RATIO_STEP,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    });
  }
  return buffs;
}

export function computeLabPlayerStats(dto, { crates = [], labUpgrades = {} } = {}) {
  const player = Player.createFromDTO(structuredClone(dto));

  // Crate buffs → zoneBuffs (mirror Labyrinth's blind concat, but drop
  // unknown crate hrids so an undefined doesn't poison the list).
  let crateBuffs = [];
  for (const c of crates) {
    crateBuffs = crateBuffs.concat(labyrinthCrateDetailMap[c] || []);
  }
  player.zoneBuffs = crateBuffs;
  player.extraBuffs = buildLabUpgradeBuffs(labUpgrades);

  player.generatePermanentBuffs();
  player.reset(); // reset(0) → clearBuffs → updateCombatDetails (combat-start state)

  return {
    baseLevels: {
      stamina: player.staminaLevel,
      intelligence: player.intelligenceLevel,
      attack: player.attackLevel,
      melee: player.meleeLevel,
      defense: player.defenseLevel,
      ranged: player.rangedLevel,
      magic: player.magicLevel,
    },
    // The combat style the sim's loadout resolves to (from the main-hand
    // weapon). The parity harness compares this to the recorded game style to
    // detect a fixture captured with a mismatched loadout.
    combatStyleHrid: player.combatDetails.combatStats.combatStyleHrid,
    derived: extractDerived(player.combatDetails),
  };
}
