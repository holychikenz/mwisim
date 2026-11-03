// Lab-shop combat upgrade buffs (labyrinth only). Shared by the browser worker
// and the API; dependency-free so the worker bundle can import it.

/** Lab-shop upgrade levels are bounded by the shop, not by us; this is a guard. */
export const MAX_LAB_UPGRADE_LEVEL = 40;

/**
 * Lab-shop combat upgrades: each purchased level is +1%, as a ratio boost on
 * damage and attack speed and a flat boost on cast speed and critical rate.
 * The ONE copy: the browser worker (src/worker.js), api/lib/target.js and
 * labStats.js all use it, so an optimiser cannot buff differently from the
 * simulation the user runs. Labyrinth-only; the caller gates it.
 */
const LAB_UPGRADE_RATIO_STEP = 0.01;
export const LAB_UPGRADE_DEFS = [
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
