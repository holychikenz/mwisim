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
//   finalRatio = ratioBoost + level * ratioBoostLevelBonus
//   finalFlat  = flatBoost  + level * flatBoostLevelBonus
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

// Highest shrine level the UI lets you pick (0 = off). The game's shrines climb
// well past this, but the input is a level knob, not a hard cap.
export const MAX_GUILD_BUFF_LEVEL = 20;

/**
 * Fold the per-shrine level knobs into finished buff objects (the shape
 * CombatUnit.addPermanentBuff consumes). Level 0 ⇒ the buff is omitted.
 * @param {Record<string, number>} levels  { [buffHrid]: level }
 * @returns {Array<object>} finished buff objects for guildBuffs[]
 */
export function resolveGuildBuffs(levels = {}) {
  const resolved = [];
  for (const def of GUILD_COMBAT_BUFFS) {
    const level = Math.max(0, Math.floor(Number(levels[def.hrid]) || 0));
    if (level <= 0) continue;
    for (const b of def.buffs) {
      resolved.push({
        uniqueHrid: b.uniqueHrid,
        typeHrid: b.typeHrid,
        ratioBoost: b.ratioBoost + level * b.ratioBoostLevelBonus,
        flatBoost: b.flatBoost + level * b.flatBoostLevelBonus,
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
