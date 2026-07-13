import { useState } from 'react';

// =============================================================================
// useGameData — game data is imported straight from the engine's bundled
// JSON (csim/src/combatsimulator/data/), the same snapshot the simulator
// itself falls back to. No API server required.
// =============================================================================
import abilityDetailMap from '../../../src/combatsimulator/data/abilityDetailMap.json';
import itemDetailMap from '../../../src/combatsimulator/data/itemDetailMap.json';
import actionDetailMap from '../../../src/combatsimulator/data/actionDetailMap.json';
import combatMonsterDetailMap from '../../../src/combatsimulator/data/combatMonsterDetailMap.json';
import combatTriggerConditionDetailMap from '../../../src/combatsimulator/data/combatTriggerConditionDetailMap.json';
import combatTriggerComparatorDetailMap from '../../../src/combatsimulator/data/combatTriggerComparatorDetailMap.json';
import combatTriggerDependencyDetailMap from '../../../src/combatsimulator/data/combatTriggerDependencyDetailMap.json';
import houseRoomDetailMap from '../../../src/combatsimulator/data/houseRoomDetailMap.json';
import achievementTierDetailMap from '../../../src/combatsimulator/data/achievementTierDetailMap.json';
import achievementDetailMap from '../../../src/combatsimulator/data/achievementDetailMap.json';
import guildTrialDetailMap from '../../../src/combatsimulator/data/guildTrialDetailMap.json';

// Derive the combat-zone list from actionDetailMap (mirrors the Express
// API's former GET /api/zones logic in api/lib/simulator.js).
function buildZones() {
  const zones = [];
  for (const [hrid, action] of Object.entries(actionDetailMap)) {
    if (action.type === '/action_types/combat' && action.combatZoneInfo) {
      zones.push({
        hrid,
        name: action.name,
        isDungeon: action.combatZoneInfo.isDungeon || false,
        combatLevel: action.levelRequirement?.level || 1
      });
    }
  }
  return zones.sort((a, b) => a.combatLevel - b.combatLevel);
}

// The 5 COMBAT guild trials (skip the skilling entries — they have no monsters
// and are not simulatable). Sorted by the map's own sortIndex.
function buildGuildTrials() {
  return Object.values(guildTrialDetailMap)
    .filter(t => t.kind === 'combat' && Array.isArray(t.monsterHrids) && t.monsterHrids.length > 0)
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0))
    .map(t => ({
      hrid: t.hrid,
      name: t.name,
      monsterHrids: t.monsterHrids,
    }));
}

function buildGameData() {
  return {
    abilities: abilityDetailMap,
    items: itemDetailMap,
    zones: buildZones(),
    monsters: combatMonsterDetailMap,
    triggerConditions: combatTriggerConditionDetailMap,
    triggerComparators: combatTriggerComparatorDetailMap,
    triggerDependencies: combatTriggerDependencyDetailMap,
    houseRooms: houseRoomDetailMap,
    achievementTiers: achievementTierDetailMap,
    achievements: achievementDetailMap,
    guildTrials: buildGuildTrials()
  };
}

export function useGameData() {
  // Data is bundled, so it is available synchronously; the { data, loading,
  // error } shape is preserved for the existing call sites.
  const [data] = useState(buildGameData);
  return { data, loading: false, error: null };
}

// Helper to filter items by type
export function filterItems(items, typeHrid) {
  if (!items) return [];
  return Object.values(items).filter(item => item.itemLocationHrid === typeHrid);
}

// Get equipment items
export function getEquipment(items) {
  if (!items) return {};
  const equipment = {};
  const equipmentTypes = [
    '/equipment_types/head',
    '/equipment_types/body',
    '/equipment_types/legs',
    '/equipment_types/feet',
    '/equipment_types/hands',
    '/equipment_types/main_hand',
    '/equipment_types/two_hand',
    '/equipment_types/off_hand',
    '/equipment_types/pouch',
    '/equipment_types/back'
  ];

  equipmentTypes.forEach(type => {
    equipment[type] = Object.values(items).filter(
      item => item.equipmentDetail?.type === type
    );
  });

  return equipment;
}

// Get food items
export function getFood(items) {
  if (!items) return [];
  return Object.values(items).filter(
    item => item.consumableDetail?.usableInActionTypeMap?.['/action_types/combat'] &&
           item.categoryHrid?.includes('food')
  );
}

// Get drink items
export function getDrinks(items) {
  if (!items) return [];
  return Object.values(items).filter(
    item => item.consumableDetail?.usableInActionTypeMap?.['/action_types/combat'] &&
           item.categoryHrid?.includes('drink')
  );
}

// Get regular combat abilities (not auras)
export function getCombatAbilities(abilities) {
  if (!abilities) return [];
  return Object.values(abilities)
    .filter(ability => !ability.isSpecialAbility)
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
}

// Get auras (special abilities)
export function getAuras(abilities) {
  if (!abilities) return [];
  return Object.values(abilities)
    .filter(ability => ability.isSpecialAbility)
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
}

// Get combat-relevant house rooms (those that apply to combat action type)
export function getCombatHouseRooms(houseRooms) {
  if (!houseRooms) return [];
  return Object.values(houseRooms)
    .filter(room => room.usableInActionTypeMap?.['/action_types/combat'])
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
}

// Get combat-relevant achievement tiers
export function getCombatAchievementTiers(achievementTiers) {
  if (!achievementTiers) return [];
  return Object.values(achievementTiers)
    .filter(tier => tier.usableInActionTypeMap?.['/action_types/combat'])
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
}

// Get all achievement hrids for a specific tier
export function getAchievementsForTier(achievements, tierHrid) {
  if (!achievements) return [];
  return Object.values(achievements)
    .filter(ach => ach.tierHrid === tierHrid)
    .map(ach => ach.hrid);
}
