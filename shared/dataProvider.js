// =============================================================================
// dataProvider — game-data source for the combat simulator
// -----------------------------------------------------------------------------
// The bundled `src/combatsimulator/data/*.json`, imported here once and
// re-exported as *mutable copies* (Object.assign-style clones). Consumers
// `import { itemDetailMap } from "./dataProvider"` and use it exactly like the
// bundled import. Works offline, never out of sync with the simulator code.
// =============================================================================

import _abilityDetailMap from "../src/combatsimulator/data/abilityDetailMap.json";
import _abilitySlotsLevelRequirementList from "../src/combatsimulator/data/abilitySlotsLevelRequirementList.json";
import _achievementDetailMap from "../src/combatsimulator/data/achievementDetailMap.json";
import _achievementTierDetailMap from "../src/combatsimulator/data/achievementTierDetailMap.json";
import _actionDetailMap from "../src/combatsimulator/data/actionDetailMap.json";
import _combatMonsterDetailMap from "../src/combatsimulator/data/combatMonsterDetailMap.json";
import _combatStyleDetailMap from "../src/combatsimulator/data/combatStyleDetailMap.json";
import _combatTriggerComparatorDetailMap from "../src/combatsimulator/data/combatTriggerComparatorDetailMap.json";
import _combatTriggerConditionDetailMap from "../src/combatsimulator/data/combatTriggerConditionDetailMap.json";
import _combatTriggerDependencyDetailMap from "../src/combatsimulator/data/combatTriggerDependencyDetailMap.json";
import _enhancementLevelTotalMultiplierTable from "../src/combatsimulator/data/enhancementLevelTotalBonusMultiplierTable.json";
import _houseRoomDetailMap from "../src/combatsimulator/data/houseRoomDetailMap.json";
import _itemDetailMap from "../src/combatsimulator/data/itemDetailMap.json";
import _labyrinthCrateDetailMap from "../src/combatsimulator/data/labyrinthCrateDetailMap.json";
import _guildTrialDetailMap from "../src/combatsimulator/data/guildTrialDetailMap.json";

// ---- Mutable copies that consumers import -----------------------------------
export const abilityDetailMap = { ..._abilityDetailMap };
export const abilitySlotsLevelRequirementList = [..._abilitySlotsLevelRequirementList];
export const achievementDetailMap = { ..._achievementDetailMap };
export const achievementTierDetailMap = { ..._achievementTierDetailMap };
export const actionDetailMap = { ..._actionDetailMap };
export const combatMonsterDetailMap = { ..._combatMonsterDetailMap };
export const combatStyleDetailMap = { ..._combatStyleDetailMap };
// Conditions and comparators are not read by the engine (trigger.js needs only the dependency map), but the
// trigger optimiser and the UI read them, and routing them through here keeps one data source of record.
export const combatTriggerComparatorDetailMap = { ..._combatTriggerComparatorDetailMap };
export const combatTriggerConditionDetailMap = { ..._combatTriggerConditionDetailMap };
export const combatTriggerDependencyDetailMap = { ..._combatTriggerDependencyDetailMap };
export const enhancementLevelTotalMultiplierTable = [..._enhancementLevelTotalMultiplierTable];
export const houseRoomDetailMap = { ..._houseRoomDetailMap };
export const itemDetailMap = { ..._itemDetailMap };
export const labyrinthCrateDetailMap = { ..._labyrinthCrateDetailMap };
export const guildTrialDetailMap = { ..._guildTrialDetailMap };
