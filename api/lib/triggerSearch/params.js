// =============================================================================
// params — which trigger values can be searched, and what ceiling each gets
//
// Of the 54 entries in combatTriggerConditionDetailMap, only SEVEN carry
// `allowValue: true` on their permitted comparators and therefore have a number
// worth sweeping. The other 47 are buff/status checks compared with
// is_active / is_inactive, and trigger.js reduces those through `!!value` —
// their `value` field is read but its content is discarded, so sweeping it
// would burn simulations to no effect. Fixtures set it to 0 and so do we.
//
// The seven, with the unit trigger.js actually compares them in:
//
//   current_hp, missing_hp        absolute hitpoints   (trigger.js:142-147)
//   current_mp, missing_mp        absolute manapoints  (trigger.js:144-149)
//   lowest_hp_percentage          percentage 0-100     (trigger.js:68-72, *100)
//   number_of_active_units        integer count        (trigger.js:62-64)
//   number_of_dead_units          integer count        (trigger.js:65-67)
//
// VALIDITY. Trigger.isActive dispatches on the *dependency*'s isSingleTarget
// flag (trigger.js:18). A single-target dependency routes to
// isActiveSingleTarget → getDependencyValue, whose switch has no case for the
// three multi-target conditions and ends in `throw new Error("Unknown
// conditionHrid in trigger: …")`. So a single-target dependency demands a
// single-target condition. The UI's TriggerEditor does not enforce this — it
// offers all 54 conditions against all 4 comparators regardless — so it must
// not be used as a validity model, and a candidate generator that trusts it
// will produce configurations that throw mid-simulation.
//
// ADDRESSING. Triggers are anonymous 4-field objects with no id, so a parameter
// is addressed by its position: (playerIndex, slotKind, slotIndex, triggerIndex).
// `slotKind` covers all three trigger-bearing slot arrays on a player DTO —
// `abilities`, `food` and `drinks`. Consumables matter as much as abilities here:
// "eat when missing_hp >= N" is the archetypal tunable absolute threshold, and
// checkTriggersForUnit (combatSimulator.js:1364) evaluates food and drinks on
// exactly the same Trigger machinery.
// =============================================================================

const { combatTriggerConditionDetailMap, combatTriggerComparatorDetailMap, combatTriggerDependencyDetailMap } =
  await import('../../../src/combatsimulator/dataProvider.js');

/**
 * The seven searchable conditions, keyed by hrid.
 *  kind     — which grid family applies (see grids.js)
 *  boundKey — which ceiling to look up (see resolveMaxValue)
 */
export const SEARCHABLE_CONDITIONS = {
  '/combat_trigger_conditions/current_hp': { kind: 'absolute', boundKey: 'hp' },
  '/combat_trigger_conditions/missing_hp': { kind: 'absolute', boundKey: 'hp' },
  '/combat_trigger_conditions/current_mp': { kind: 'absolute', boundKey: 'mp' },
  '/combat_trigger_conditions/missing_mp': { kind: 'absolute', boundKey: 'mp' },
  '/combat_trigger_conditions/lowest_hp_percentage': { kind: 'percentage', boundKey: 'percent' },
  '/combat_trigger_conditions/number_of_active_units': { kind: 'count', boundKey: 'units' },
  '/combat_trigger_conditions/number_of_dead_units': { kind: 'count', boundKey: 'units' },
};

/** @returns {{kind: string, boundKey: string} | null} */
export function classifySearchableCondition(conditionHrid) {
  return SEARCHABLE_CONDITIONS[conditionHrid] || null;
}

/**
 * Is this dependency × condition × comparator triple something the engine can
 * actually evaluate?
 *
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateTriggerShape(dependencyHrid, conditionHrid, comparatorHrid) {
  const dependency = combatTriggerDependencyDetailMap[dependencyHrid];
  if (!dependency) return { valid: false, reason: `unknown dependency ${dependencyHrid}` };

  const condition = combatTriggerConditionDetailMap[conditionHrid];
  if (!condition) return { valid: false, reason: `unknown condition ${conditionHrid}` };

  const comparator = combatTriggerComparatorDetailMap[comparatorHrid];
  if (!comparator) return { valid: false, reason: `unknown comparator ${comparatorHrid}` };

  // trigger.js:18 dispatches on the dependency; the single-target path cannot
  // evaluate a multi-target condition and throws.
  if (dependency.isSingleTarget && !condition.isSingleTarget) {
    return {
      valid: false,
      reason: `${condition.name} is multi-target only and cannot be used with ${dependency.name}`,
    };
  }

  if (!condition.allowedComparatorHrids.includes(comparatorHrid)) {
    return {
      valid: false,
      reason: `${comparator.name} is not permitted for ${condition.name}`,
    };
  }

  return { valid: true };
}

/**
 * Can the value on this trigger be swept?
 *
 * @returns {{searchable: boolean, kind?: string, boundKey?: string, reason?: string}}
 */
export function describeSearchability(trigger) {
  const shape = validateTriggerShape(trigger.dependencyHrid, trigger.conditionHrid, trigger.comparatorHrid);
  if (!shape.valid) return { searchable: false, reason: shape.reason };

  const comparator = combatTriggerComparatorDetailMap[trigger.comparatorHrid];
  if (!comparator.allowValue) {
    return { searchable: false, reason: `${comparator.name} ignores the value` };
  }

  const classified = classifySearchableCondition(trigger.conditionHrid);
  if (!classified) {
    // Belt and braces: every allowValue comparator pairs only with the seven,
    // so reaching here means the game data has changed under us.
    return { searchable: false, reason: `${trigger.conditionHrid} carries no searchable unit` };
  }

  return { searchable: true, ...classified };
}

/**
 * Resolve the ceiling for a searchable trigger from the derived bounds.
 *
 * The peer fork defaults anything that is neither `targeted_enemy` nor
 * `all_allies` to the enemy's total hitpoints — which is wrong for
 * `self` + `current_hp`, where the ceiling is the *player's* own maximum.
 * We resolve on the dependency and the unit together.
 *
 * @param {string} dependencyHrid
 * @param {string} boundKey  'hp' | 'mp' | 'percent' | 'units'
 * @param {object} bounds    see bounds.js deriveBounds()
 * @param {number} playerIndex  which player owns the trigger (for `self`)
 * @returns {number}
 */
export function resolveMaxValue(dependencyHrid, boundKey, bounds, playerIndex = 0) {
  if (boundKey === 'percent') return 100;

  const self = bounds.players?.[playerIndex] || bounds.players?.[0] || {};
  const party = bounds.party || {};
  const enemies = bounds.enemies || {};

  switch (dependencyHrid) {
    case '/combat_trigger_dependencies/self':
      // `units` cannot reach here — the count conditions are multi-target only
      // and validateTriggerShape rejects them against `self`.
      return boundKey === 'mp' ? self.maxManapoints : self.maxHitpoints;

    case '/combat_trigger_dependencies/targeted_enemy':
      return boundKey === 'mp' ? enemies.targetManapoints : enemies.targetHitpoints;

    case '/combat_trigger_dependencies/all_allies':
      if (boundKey === 'units') return party.size;
      return boundKey === 'mp' ? party.maxManapoints : party.maxHitpoints;

    case '/combat_trigger_dependencies/all_enemies':
      if (boundKey === 'units') return enemies.maxSpawnCount;
      return boundKey === 'mp' ? enemies.totalManapoints : enemies.totalHitpoints;

    default:
      return 1;
  }
}

/** The three trigger-bearing slot arrays on a player DTO. */
export const SLOT_KINDS = ['abilities', 'food', 'drinks'];

/** Resolve a (playerIndex, slotKind, slotIndex, triggerIndex) address. */
function resolveAddress(playerDTOs, { playerIndex, slotKind, slotIndex, triggerIndex }) {
  if (!SLOT_KINDS.includes(slotKind)) return {};
  const player = playerDTOs?.[playerIndex];
  const slot = player?.[slotKind]?.[slotIndex];
  const trigger = slot?.triggers?.[triggerIndex];
  return { player, slot, trigger };
}

/**
 * Walk the player DTOs and turn the user's selection into concrete search
 * parameters with ceilings attached.
 *
 * @param {object[]} playerDTOs
 * @param {Array<{playerIndex: number, slotKind: string, slotIndex: number, triggerIndex: number}>} selection
 * @param {object} bounds
 * @returns {{params: object[], rejected: object[]}}
 */
export function collectSearchParams(playerDTOs, selection, bounds) {
  const params = [];
  const rejected = [];

  for (const address of selection || []) {
    const { playerIndex, slotKind, slotIndex, triggerIndex } = address;
    const { player, slot, trigger } = resolveAddress(playerDTOs, address);
    const slotHrid = slot?.hrid;

    if (!trigger) {
      rejected.push({ ...address, reason: 'no trigger at that position' });
      continue;
    }

    const searchability = describeSearchability(trigger);
    if (!searchability.searchable) {
      rejected.push({ ...address, reason: searchability.reason });
      continue;
    }

    const maxValue = resolveMaxValue(
      trigger.dependencyHrid,
      searchability.boundKey,
      bounds,
      playerIndex
    );

    if (!(maxValue > 0)) {
      rejected.push({ ...address, reason: 'derived ceiling was zero' });
      continue;
    }

    params.push({
      playerIndex,
      slotKind,
      slotIndex,
      triggerIndex,
      playerHrid: player.hrid,
      slotHrid,
      dependencyHrid: trigger.dependencyHrid,
      conditionHrid: trigger.conditionHrid,
      comparatorHrid: trigger.comparatorHrid,
      conditionName: combatTriggerConditionDetailMap[trigger.conditionHrid]?.name || trigger.conditionHrid,
      dependencyName: combatTriggerDependencyDetailMap[trigger.dependencyHrid]?.name || trigger.dependencyHrid,
      comparatorName: combatTriggerComparatorDetailMap[trigger.comparatorHrid]?.name || trigger.comparatorHrid,
      kind: searchability.kind,
      boundKey: searchability.boundKey,
      maxValue,
      initialValue: Number(trigger.value) || 0,
      // A `>=` threshold set above the largest value the zone can ever produce
      // never fires — e.g. "when 2+ enemies are active" in a single-spawn zone,
      // or "when missing HP >= 5000" on a build with 2000 maximum. Worth telling
      // the user plainly: it is a dead trigger, not a tuning problem, and no
      // amount of searching will make it useful here.
      unreachable:
        trigger.comparatorHrid === '/combat_trigger_comparators/greater_than_equal' &&
        (Number(trigger.value) || 0) > maxValue,
    });
  }

  return { params, rejected };
}

/**
 * Every trigger across every player's abilities, food and drinks, annotated with
 * whether its value can be swept. Feeds the UI's selection list so a user is
 * shown *why* a given threshold is not offered rather than simply not seeing it.
 *
 * @param {object[]} playerDTOs
 * @returns {object[]}
 */
export function enumerateTriggers(playerDTOs) {
  const rows = [];
  (playerDTOs || []).forEach((player, playerIndex) => {
    for (const slotKind of SLOT_KINDS) {
      (player?.[slotKind] || []).forEach((slot, slotIndex) => {
        if (!slot?.hrid) return; // empty consumable / ability slot
        (slot.triggers || []).forEach((trigger, triggerIndex) => {
          const searchability = describeSearchability(trigger);
          rows.push({
            playerIndex,
            slotKind,
            slotIndex,
            triggerIndex,
            playerHrid: player.hrid,
            slotHrid: slot.hrid,
            dependencyHrid: trigger.dependencyHrid,
            conditionHrid: trigger.conditionHrid,
            comparatorHrid: trigger.comparatorHrid,
            value: Number(trigger.value) || 0,
            dependencyName: combatTriggerDependencyDetailMap[trigger.dependencyHrid]?.name || trigger.dependencyHrid,
            conditionName: combatTriggerConditionDetailMap[trigger.conditionHrid]?.name || trigger.conditionHrid,
            comparatorName: combatTriggerComparatorDetailMap[trigger.comparatorHrid]?.name || trigger.comparatorHrid,
            searchable: searchability.searchable,
            kind: searchability.kind || null,
            reason: searchability.reason || null,
          });
        });
      });
    }
  });
  return rows;
}

/**
 * Produce a fresh set of player DTOs with `values[i]` written into `params[i]`.
 *
 * Always a deep clone: Player.createFromDTO → Ability.createFromDTO builds live
 * objects carrying `lastUsed` and buff state, so a DTO must never be shared
 * between two candidate runs.
 *
 * @param {object[]} playerDTOs  baseline
 * @param {object[]} params
 * @param {number[]} values      index-aligned with params
 * @returns {object[]}
 */
export function applyValues(playerDTOs, params, values) {
  const clone = structuredClone(playerDTOs);
  params.forEach((param, i) => {
    const value = values[i];
    if (!Number.isFinite(value)) return;
    const { trigger } = resolveAddress(clone, param);
    if (trigger) trigger.value = value;
  });
  return clone;
}

/** Total trigger conditions across every player — the ranking tie-breaker. */
export function countConditions(playerDTOs) {
  let total = 0;
  for (const player of playerDTOs || []) {
    for (const slotKind of SLOT_KINDS) {
      for (const slot of player?.[slotKind] || []) {
        if (!slot?.hrid) continue;
        total += (slot.triggers || []).length;
      }
    }
  }
  return total;
}

/** Read the current values of `params` out of a DTO set. */
export function readValues(playerDTOs, params) {
  return params.map((param) => {
    const { trigger } = resolveAddress(playerDTOs, param);
    return Number(trigger?.value) || 0;
  });
}
