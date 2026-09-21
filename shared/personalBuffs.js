// =============================================================================
// personalBuffs — the seven combat SEALS ("personal buffs") and their resolver.
// -----------------------------------------------------------------------------
// A seal is an item the character equips in their seal slot. It is therefore a
// property of the CHARACTER, not of the account and not of the party — which is
// why, as of this change, the new Vite UI resolves seals per player (in the
// per-character "Houses, Achievements & Buffs" panel) and folds the finished
// buff objects into that player's DTO `extraBuffs`. It no longer sends
// `extra.personalBuffs` at all.
//
// WHY THIS DIRECTORY. The definitions had drifted into two places that had no
// way of knowing about each other: the `personalBuffs` map inside
// src/worker.js's buildCommunityBuffs, and the display list `SEAL_OPTIONS` in
// ui/src/components/HeaderControls.jsx. The numbers lived in one, the labels in
// the other, and nothing held them together. `shared/` is the established home
// for things both products must agree on (see shared/consumableCost.js's own
// header for why it is emphatically not src/combatsimulator/): it is reachable
// from the Vite build, from the webpack bundle and from api/ alike.
//
// The buff objects below are lifted VERBATIM from the map that used to live in
// src/worker.js — same uniqueHrid, typeHrid, ratioBoost/flatBoost, startTime and
// duration — so that moving them cannot move a number. They are already
// finished objects in the shape CombatUnit.addPermanentBuff consumes; unlike
// guild shrines (ui/src/utils/guildBuffs.js) seals have no level, so there is
// nothing to fold in.
//
// `extra.personalBuffs` still exists on the worker's side and still works: the
// LEGACY webpack UI (src/main.js) sends seals party-wide and has no per-player
// notion to send them with. That branch reads these same definitions, so the
// two UIs cannot disagree about what a seal is worth.
// =============================================================================

export const SEAL_DEFS = {
  '/items/seal_of_attack_speed': {
    label: 'Attack Speed (+15%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_attack_speed',
      typeHrid: '/buff_types/attack_speed',
      ratioBoost: 0.15,
      ratioBoostLevelBonus: 0,
      flatBoost: 0,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_cast_speed': {
    label: 'Cast Speed (+15%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_cast_speed',
      typeHrid: '/buff_types/cast_speed',
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0.15,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_combat_drop': {
    label: 'Combat Drop (+15%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_combat_drop',
      typeHrid: '/buff_types/combat_drop_quantity',
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0.15,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_critical_rate': {
    label: 'Critical Rate (+10%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_critical_rate',
      typeHrid: '/buff_types/critical_rate',
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0.1,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_damage': {
    label: 'Damage (+8%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_damage',
      typeHrid: '/buff_types/damage',
      ratioBoost: 0.08,
      ratioBoostLevelBonus: 0,
      flatBoost: 0,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_rare_find': {
    label: 'Rare Find (+60%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_rare_find',
      typeHrid: '/buff_types/rare_find',
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0.6,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
  '/items/seal_of_wisdom': {
    label: 'Wisdom (+20%)',
    buff: {
      uniqueHrid: '/buff_uniques/personal_wisdom',
      typeHrid: '/buff_types/wisdom',
      ratioBoost: 0,
      ratioBoostLevelBonus: 0,
      flatBoost: 0.2,
      flatBoostLevelBonus: 0,
      startTime: '0001-01-01T00:00:00Z',
      duration: 0,
    },
  },
};

/**
 * Display order for the seal checkboxes. Object key order happens to match, but
 * relying on that would make the UI's ordering an accident of the literal above;
 * this list is the stated one, and it is the order the header popover used
 * before the seals moved into the per-player panel.
 */
export const SEAL_OPTIONS = [
  { value: '/items/seal_of_attack_speed', label: SEAL_DEFS['/items/seal_of_attack_speed'].label },
  { value: '/items/seal_of_cast_speed', label: SEAL_DEFS['/items/seal_of_cast_speed'].label },
  { value: '/items/seal_of_combat_drop', label: SEAL_DEFS['/items/seal_of_combat_drop'].label },
  { value: '/items/seal_of_critical_rate', label: SEAL_DEFS['/items/seal_of_critical_rate'].label },
  { value: '/items/seal_of_damage', label: SEAL_DEFS['/items/seal_of_damage'].label },
  { value: '/items/seal_of_rare_find', label: SEAL_DEFS['/items/seal_of_rare_find'].label },
  { value: '/items/seal_of_wisdom', label: SEAL_DEFS['/items/seal_of_wisdom'].label },
];

/**
 * Finished buff objects for a list of seal item hrids.
 *
 * Unknown hrids are skipped rather than throwing: this list arrives from a
 * persisted session, an exported build or an MWIX payload, and a seal the game
 * has added since is not a reason to refuse to simulate. Skipping matches what
 * the old inline `if (personalBuffs[buff])` guard in src/worker.js did.
 *
 * @param {string[]} [hrids]
 * @returns {Array<object>} buff objects for extraBuffs[]
 */
export function resolveSealBuffs(hrids = []) {
  const resolved = [];
  for (const hrid of hrids || []) {
    const def = SEAL_DEFS[hrid];
    if (def) resolved.push(def.buff);
  }
  return resolved;
}
