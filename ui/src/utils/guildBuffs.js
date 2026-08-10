// =============================================================================
// guildBuffs — the 5 COMBAT guild (shrine) buffs and their level resolver.
// -----------------------------------------------------------------------------
// The base buff definitions below are lifted verbatim from
// milkyway_client_info.json → guildBuffDetailMap (the `isCombat` entries).
// guildBuffDetailMap is NOT bundled into the engine data, and its source dump
// lives outside the csim repo root (so it cannot be imported into the Vite
// build), hence the relevant combat entries are inlined here.
//
// Each buff carries per-level bonus fields (ratioBoostLevelBonus /
// flatBoostLevelBonus). The engine does NOT read those: worker.js hands the
// finished objects straight to CombatUnit.addPermanentBuff, which consumes the
// finished `ratioBoost` / `flatBoost` values directly (it never constructs a
// levelled Buff). So the UI must fold the shrine level into finished values
// before shipping them in guildBuffs[]:
//
//   finalRatio = ratioBoost + (level - 1) * ratioBoostLevelBonus
//   finalFlat  = flatBoost  + (level - 1) * flatBoostLevelBonus
//
// The (level - 1) is deliberate and matches both the game server and the
// engine's own Buff class (src/combatsimulator/buff.js): level 1 yields the
// BASE value, not base + one bonus step. Verified against server-resolved
// `guildActionTypeBuffsMap["/action_types/combat"]`, which for a character with
// force_combat at level 2 reports damage ratioBoost 0.006 — i.e.
// 0.003 + 0.003 * (2 - 1) — not 0.009. Using `level` here overstates every
// shrine by one full level step.
//
// A level of 0 means the buff is switched off (omitted entirely).
// =============================================================================

export const GUILD_COMBAT_BUFFS = [
  {
    hrid: '/guild_buffs/force_combat',
    name: 'Force',
    effect: 'Damage',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/damage_guild_buff',
        typeHrid: '/buff_types/damage',
        ratioBoost: 0.003,
        ratioBoostLevelBonus: 0.003,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
      },
    ],
  },
  {
    hrid: '/guild_buffs/rarity_combat',
    name: 'Rarity',
    effect: 'Rare Find',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/rare_find_guild_buff',
        typeHrid: '/buff_types/rare_find',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.01,
        flatBoostLevelBonus: 0.01,
      },
    ],
  },
  {
    hrid: '/guild_buffs/scholar_combat',
    name: 'Scholar',
    effect: 'Wisdom',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/wisdom_guild_buff',
        typeHrid: '/buff_types/wisdom',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.005,
        flatBoostLevelBonus: 0.005,
      },
    ],
  },
  {
    hrid: '/guild_buffs/spirit_combat',
    name: 'Spirit',
    effect: 'Max HP / MP',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/max_hitpoints_guild_buff',
        typeHrid: '/buff_types/max_hitpoints',
        ratioBoost: 0.01,
        ratioBoostLevelBonus: 0.01,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
      },
      {
        uniqueHrid: '/buff_uniques/max_manapoints_guild_buff',
        typeHrid: '/buff_types/max_manapoints',
        ratioBoost: 0.01,
        ratioBoostLevelBonus: 0.01,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
      },
    ],
  },
  {
    hrid: '/guild_buffs/tempo_combat',
    name: 'Tempo',
    effect: 'Attack / Cast Speed',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/attack_speed_guild_buff',
        typeHrid: '/buff_types/attack_speed',
        ratioBoost: 0.004,
        ratioBoostLevelBonus: 0.004,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
      },
      {
        uniqueHrid: '/buff_uniques/cast_speed_guild_buff',
        typeHrid: '/buff_types/cast_speed',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.004,
        flatBoostLevelBonus: 0.004,
      },
    ],
  },
];

// =============================================================================
// GUILD BUILDINGS — trial-only.
// -----------------------------------------------------------------------------
// Lifted from guildBuildingDetailMap. Unlike shrines, guild building buffs do
// NOT apply to ordinary combat: they take effect inside guild trials only.
// Keep them out of the zone/labyrinth path (see App.jsx — the normal
// runSimulation call ships shrine buffs alone).
//
// Only the COMBAT-relevant buildings are listed. The other 12 buff-bearing
// buildings raise skilling levels (brewing, milking, cooking, …) which the
// combat engine does not read. Every building is flat-boost only, base 2 and
// +2/level, so level 20 = +40 to that combat level; the two regen buildings
// add flat 0.003 +0.003/level (6% at level 20).
//
// All seven buff types below are already consumed by CombatUnit:
// *_level at combatUnit.js (the stamina/intelligence/attack/... loop), and
// hp_regen / mp_regen further down the same method.
// =============================================================================

export const GUILD_COMBAT_BUILDINGS = [
  {
    hrid: '/guild_buildings/dojo',
    name: 'Dojo',
    effect: 'Attack Level',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_attack_level',
        typeHrid: '/buff_types/attack_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
    ],
  },
  {
    hrid: '/guild_buildings/armory',
    name: 'Armory',
    effect: 'Defense Level',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_defense_level',
        typeHrid: '/buff_types/defense_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
    ],
  },
  {
    hrid: '/guild_buildings/gym',
    name: 'Gym',
    effect: 'Melee Level',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_melee_level',
        typeHrid: '/buff_types/melee_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
    ],
  },
  {
    hrid: '/guild_buildings/archery_range',
    name: 'Archery Range',
    effect: 'Ranged Level',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_ranged_level',
        typeHrid: '/buff_types/ranged_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
    ],
  },
  {
    hrid: '/guild_buildings/mystical_study',
    name: 'Mystical Study',
    effect: 'Magic Level',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_magic_level',
        typeHrid: '/buff_types/magic_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
    ],
  },
  {
    hrid: '/guild_buildings/dining_room',
    name: 'Dining Room',
    effect: 'Stamina Level + HP Regen',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_stamina_level',
        typeHrid: '/buff_types/stamina_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
      {
        uniqueHrid: '/buff_uniques/guild_building_hp_regen',
        typeHrid: '/buff_types/hp_regen',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.003,
        flatBoostLevelBonus: 0.003,
      },
    ],
  },
  {
    hrid: '/guild_buildings/library',
    name: 'Library',
    effect: 'Intelligence Level + MP Regen',
    buffs: [
      {
        uniqueHrid: '/buff_uniques/guild_building_intelligence_level',
        typeHrid: '/buff_types/intelligence_level',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 2,
        flatBoostLevelBonus: 2,
      },
      {
        uniqueHrid: '/buff_uniques/guild_building_mp_regen',
        typeHrid: '/buff_types/mp_regen',
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.003,
        flatBoostLevelBonus: 0.003,
      },
    ],
  },
];

// Highest shrine level the UI lets you pick (0 = off). The game's shrines climb
// well past this, but the input is a level knob, not a hard cap.
export const MAX_GUILD_BUFF_LEVEL = 20;

// Guild buildings cap at level 20 in the game data (maxLevel: 20).
export const MAX_GUILD_BUILDING_LEVEL = 20;

/**
 * Fold level knobs into finished buff objects (the shape
 * CombatUnit.addPermanentBuff consumes). Level 0 ⇒ the entry is omitted.
 * Shared by shrines and buildings so the two can never drift apart.
 * @param {Array<object>} defs    definition list (shrines or buildings)
 * @param {Record<string, number>} levels  { [defHrid]: level }
 * @param {number} maxLevel       clamp ceiling
 * @returns {Array<object>} finished buff objects for guildBuffs[]
 */
function resolveLevelledBuffs(defs, levels = {}, maxLevel = 20) {
  const resolved = [];
  for (const def of defs) {
    const raw = Math.floor(Number(levels?.[def.hrid]) || 0);
    const level = Math.max(0, Math.min(maxLevel, raw));
    if (level <= 0) continue;
    for (const b of def.buffs) {
      resolved.push({
        uniqueHrid: b.uniqueHrid,
        typeHrid: b.typeHrid,
        ratioBoost: b.ratioBoost + (level - 1) * b.ratioBoostLevelBonus,
        flatBoost: b.flatBoost + (level - 1) * b.flatBoostLevelBonus,
        // Zero the per-level bonus fields so nothing double-counts the level if
        // this object is ever fed through the engine's Buff constructor.
        ratioBoostLevelBonus: 0,
        flatBoostLevelBonus: 0,
        startTime: '0001-01-01T00:00:00Z',
        duration: 0,
      });
    }
  }
  return resolved;
}

/**
 * Guild SHRINE buffs. These apply to every fight — zone, labyrinth and trial.
 * @param {Record<string, number>} levels  { [buffHrid]: level }
 */
export function resolveGuildBuffs(levels = {}) {
  return resolveLevelledBuffs(GUILD_COMBAT_BUFFS, levels, MAX_GUILD_BUFF_LEVEL);
}

/**
 * Guild BUILDING buffs. TRIAL ONLY — never ship these on the zone/labyrinth
 * path. Returns only the combat-relevant buildings (see GUILD_COMBAT_BUILDINGS).
 * @param {Record<string, number>} levels  { [buildingHrid]: level }
 */
export function resolveGuildBuildingBuffs(levels = {}) {
  return resolveLevelledBuffs(GUILD_COMBAT_BUILDINGS, levels, MAX_GUILD_BUILDING_LEVEL);
}
