// =============================================================================
// dataProvider — game-data source for the combat simulator
// -----------------------------------------------------------------------------
// Two callers need this data:
//
//   1. csim standalone (React UI / Express API / webpack bundle).
//      Wants bundled `./data/*.json` baked in — works offline, never
//      out of sync with the simulator code.
//
//   2. MWIX (Tampermonkey) running inside a live game tab.
//      Wants to feed the simulator the game's own `clientData` (already
//      captured by MWIStorage) so the Tampermonkey bundle does not also
//      carry 2-3 MB of duplicate JSON.
//
// Design (chosen for minimum consumer churn):
//
//   - Bundled JSON is imported here once.
//   - Each map is then re-exported as a *mutable copy* (Object.assign-style
//     clone). Consumers `import { itemDetailMap } from "./dataProvider"`
//     and use it exactly like the old bundled import.
//   - `setOverrides(maps)` empties each live export in place and refills
//     it from `maps[name] ?? bundled[name]`. ES modules use live bindings
//     for exports, and the object identity is preserved across consumers,
//     so this propagates everywhere with no further change at the call
//     sites.
//   - `resetOverrides()` returns to bundled.
//
// Call `setOverrides` BEFORE constructing a CombatSimulator. Once a sim
// is running, do not swap data on it — the engine caches references.
// =============================================================================

import _abilityDetailMap from "./data/abilityDetailMap.json";
import _achievementDetailMap from "./data/achievementDetailMap.json";
import _achievementTierDetailMap from "./data/achievementTierDetailMap.json";
import _actionDetailMap from "./data/actionDetailMap.json";
import _combatMonsterDetailMap from "./data/combatMonsterDetailMap.json";
import _combatStyleDetailMap from "./data/combatStyleDetailMap.json";
import _combatTriggerComparatorDetailMap from "./data/combatTriggerComparatorDetailMap.json";
import _combatTriggerConditionDetailMap from "./data/combatTriggerConditionDetailMap.json";
import _combatTriggerDependencyDetailMap from "./data/combatTriggerDependencyDetailMap.json";
import _enhancementLevelTotalMultiplierTable from "./data/enhancementLevelTotalBonusMultiplierTable.json";
import _houseRoomDetailMap from "./data/houseRoomDetailMap.json";
import _itemDetailMap from "./data/itemDetailMap.json";
import _labyrinthCrateDetailMap from "./data/labyrinthCrateDetailMap.json";
import _guildTrialDetailMap from "./data/guildTrialDetailMap.json";

// ---- Bundled (read-only snapshot, for fallback / reset) ---------------------
const _bundled = Object.freeze({
    abilityDetailMap: _abilityDetailMap,
    achievementDetailMap: _achievementDetailMap,
    achievementTierDetailMap: _achievementTierDetailMap,
    actionDetailMap: _actionDetailMap,
    combatMonsterDetailMap: _combatMonsterDetailMap,
    combatStyleDetailMap: _combatStyleDetailMap,
    // Conditions and comparators are not read by the engine itself (trigger.js
    // needs only the dependency map), but the trigger optimiser in
    // api/lib/triggerSearch/ classifies and validates against them, and the UI
    // renders them. Routing them through here rather than importing the JSON
    // directly keeps one data source of record and lets MWIX override them.
    combatTriggerComparatorDetailMap: _combatTriggerComparatorDetailMap,
    combatTriggerConditionDetailMap: _combatTriggerConditionDetailMap,
    combatTriggerDependencyDetailMap: _combatTriggerDependencyDetailMap,
    enhancementLevelTotalMultiplierTable: _enhancementLevelTotalMultiplierTable,
    houseRoomDetailMap: _houseRoomDetailMap,
    itemDetailMap: _itemDetailMap,
    labyrinthCrateDetailMap: _labyrinthCrateDetailMap,
    guildTrialDetailMap: _guildTrialDetailMap,
});

// ---- Mutable copies that consumers import -----------------------------------
// These are pre-seeded from bundled. setOverrides() rewrites their contents
// in place; consumers always see the latest content because they hold the
// same object reference.
export const abilityDetailMap = { ..._abilityDetailMap };
export const achievementDetailMap = { ..._achievementDetailMap };
export const achievementTierDetailMap = { ..._achievementTierDetailMap };
export const actionDetailMap = { ..._actionDetailMap };
export const combatMonsterDetailMap = { ..._combatMonsterDetailMap };
export const combatStyleDetailMap = { ..._combatStyleDetailMap };
export const combatTriggerComparatorDetailMap = { ..._combatTriggerComparatorDetailMap };
export const combatTriggerConditionDetailMap = { ..._combatTriggerConditionDetailMap };
export const combatTriggerDependencyDetailMap = { ..._combatTriggerDependencyDetailMap };
export const enhancementLevelTotalMultiplierTable = [..._enhancementLevelTotalMultiplierTable];
export const houseRoomDetailMap = { ..._houseRoomDetailMap };
export const itemDetailMap = { ..._itemDetailMap };
export const labyrinthCrateDetailMap = { ..._labyrinthCrateDetailMap };
export const guildTrialDetailMap = { ..._guildTrialDetailMap };

// Registry for setOverrides; keys must match `_bundled` keys exactly.
const _live = {
    abilityDetailMap,
    achievementDetailMap,
    achievementTierDetailMap,
    actionDetailMap,
    combatMonsterDetailMap,
    combatStyleDetailMap,
    combatTriggerComparatorDetailMap,
    combatTriggerConditionDetailMap,
    combatTriggerDependencyDetailMap,
    enhancementLevelTotalMultiplierTable,
    houseRoomDetailMap,
    itemDetailMap,
    labyrinthCrateDetailMap,
    guildTrialDetailMap,
};

/**
 * Replace any subset of data maps with externally-provided values. Maps not
 * mentioned in `overrides` are reset to bundled.
 *
 * @param {object|null} overrides - { [mapName]: object|array }. Pass null to
 *   reset every map to bundled.
 */
export function setOverrides(overrides) {
    for (const name of Object.keys(_live)) {
        const target = _live[name];
        const source = (overrides && overrides[name]) || _bundled[name];
        if (Array.isArray(target)) {
            target.length = 0;
            target.push(...source);
        } else {
            for (const k of Object.keys(target)) delete target[k];
            Object.assign(target, source);
        }
    }
}

/** Restore every map to its bundled contents. */
export function resetOverrides() {
    setOverrides(null);
}

/**
 * Lightweight diagnostic: lists keys present in `overrides` that the
 * bundled snapshot does not know about, and vice versa. Useful for sanity-
 * checking that a live `clientData` feed matches the simulator's
 * expectations. Returns an empty diff when everything aligns.
 *
 * @param {object} overrides - same shape as setOverrides
 * @returns {{ extraInOverride: string[][], extraInBundled: string[][] }}
 */
export function diffAgainstBundled(overrides) {
    const out = { extraInOverride: [], extraInBundled: [] };
    if (!overrides) return out;
    for (const name of Object.keys(overrides)) {
        const o = overrides[name];
        const b = _bundled[name];
        if (!o || !b) continue;
        if (Array.isArray(b)) continue;
        const oKeys = new Set(Object.keys(o));
        const bKeys = new Set(Object.keys(b));
        const extraO = [...oKeys].filter((k) => !bKeys.has(k));
        const extraB = [...bKeys].filter((k) => !oKeys.has(k));
        if (extraO.length) out.extraInOverride.push([name, ...extraO]);
        if (extraB.length) out.extraInBundled.push([name, ...extraB]);
    }
    return out;
}
