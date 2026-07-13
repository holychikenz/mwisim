// =============================================================================
// characterToPlayer — converts a raw MWI character payload (characterData, as
// captured by MWIX / stored by cow/webapp) into the React UI's internal
// player state.
//
// This is a port of tampermonkey/src/kernel/csim-dto.js (buildPlayerDTO),
// adapted in two ways:
//   - output uses the UI's internal shape (`itemHrid` keys in equipment /
//     food / drinks) rather than the engine DTO shape (`hrid`); App.jsx does
//     the DTO transform when a simulation starts.
//   - known-item / known-ability / known-house filtering uses the bundled
//     game data (useGameData) instead of MWIX's live setOverrides maps.
//
// Source mapping (verified against characters/holychikenz.json):
//   levels        ← characterSkills[i].{skillHrid, level}
//   loadout       ← characterLoadoutMap: queued action's characterLoadoutID,
//                     else isDefault combat loadout, else first combat loadout
//   equipment     ← loadout.wearableMap ("charID::loc::itemHrid::enh" refs),
//                     falling back to worn characterItems
//   food/drinks   ← loadout.foodItemHrids / drinkItemHrids
//                     + loadout.consumableCombatTriggersMap[hrid]
//   abilities     ← loadout.abilityMap (slot→hrid) + characterAbilities level
//                     + loadout.abilityCombatTriggersMap[hrid], falling back
//                     to the ability's defaultCombatTriggers
//   houseRooms    ← characterHouseRoomMap[hrid].level
//   achievements  ← characterAchievements (array) → { hrid: true } map
// =============================================================================

const LEVEL_MAP = {
  staminaLevel: '/skills/stamina',
  intelligenceLevel: '/skills/intelligence',
  attackLevel: '/skills/attack',
  meleeLevel: '/skills/melee',
  defenseLevel: '/skills/defense',
  rangedLevel: '/skills/ranged',
  magicLevel: '/skills/magic'
};

function indexBy(arr, key) {
  const m = new Map();
  for (const x of arr || []) if (x && x[key] != null) m.set(x[key], x);
  return m;
}

function pickLoadout(loadoutMap, char) {
  if (!loadoutMap) return null;
  const all = Object.values(loadoutMap);
  if (!all.length) return null;

  // STRONG signal: the queued action's characterLoadoutID is the loadout
  // the game is actively running — but only if it is a COMBAT loadout.
  // (The queued action may be skilling — e.g. an enhancing kit whose teas
  // the combat engine cannot simulate; feeding it those hangs the sim.)
  const queue = (char?.characterActions || [])
    .slice()
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const head = queue[0];
  if (head?.characterLoadoutID != null) {
    const byActive = all.find(l => String(l.id) === String(head.characterLoadoutID));
    if (byActive && byActive.actionTypeHrid === '/action_types/combat') return byActive;
  }

  // Soft signals.
  const combat = all.filter(l => l.actionTypeHrid === '/action_types/combat');
  if (combat.length === 0) return all[0];
  return combat.find(l => l.isDefault) || combat[0];
}

/**
 * @param {object} char - raw characterData
 * @param {object} gameData - the bundled game data from useGameData
 * @param {number} playerId - target player slot (1-5)
 * @returns {{player: object, skipped: object, loadoutName: string|null}}
 */
export function characterToPlayer(char, gameData, playerId) {
  if (!char || typeof char !== 'object') {
    throw new Error('Character data is empty');
  }

  const knownItem = (h) => !gameData?.items || gameData.items[h];
  const knownAbility = (h) => !gameData?.abilities || gameData.abilities[h];
  const knownHouse = (h) => !gameData?.houseRooms || gameData.houseRooms[h];
  // Consumables must be usable in combat: handing the engine a skilling
  // tea (e.g. /items/wisdom_tea) hangs the simulation rather than erroring.
  const combatConsumable = (h) => {
    if (!gameData?.items) return true;
    return !!gameData.items[h]?.consumableDetail?.usableInActionTypeMap?.['/action_types/combat'];
  };

  const skills = indexBy(char.characterSkills || [], 'skillHrid');
  const lvl = (hrid) => skills.get(hrid)?.level ?? 1;

  const player = {
    hrid: `player${playerId}`,
    equipment: {},
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: {},
    achievements: {},
    debuffOnLevelGap: 0
  };
  for (const [field, hrid] of Object.entries(LEVEL_MAP)) {
    player[field] = lvl(hrid);
  }

  const skipped = { equipment: [], abilities: [], food: [], drinks: [], houseRooms: [] };
  const loadout = pickLoadout(char.characterLoadoutMap, char);

  // ---- Equipment ------------------------------------------------------
  function recordEquipment(slotLocation, itemHrid, enhancementLevel) {
    if (!slotLocation || !itemHrid) return;
    if (!knownItem(itemHrid)) {
      skipped.equipment.push(itemHrid);
      return;
    }
    const slot = slotLocation.replace('/item_locations/', '/equipment_types/');
    player.equipment[slot] = {
      itemHrid,
      enhancementLevel: Math.max(0, Math.floor(Number(enhancementLevel) || 0))
    };
  }

  if (loadout && loadout.wearableMap && typeof loadout.wearableMap === 'object') {
    // Loadout-driven equipment. Parse "::"-joined wearable refs.
    for (const [slotLocation, rawRef] of Object.entries(loadout.wearableMap)) {
      if (!rawRef) continue;
      const parts = String(rawRef).split('::');
      if (parts.length < 4) continue;
      recordEquipment(slotLocation, parts[2], Number(parts[3]) || 0);
    }
  } else {
    // No loadout: fall back to whatever's currently worn.
    for (const item of char.characterItems || []) {
      const loc = item?.itemLocationHrid;
      if (!loc || loc === '/item_locations/inventory') continue;
      if (!(item.count > 0)) continue;
      recordEquipment(loc, item.itemHrid, item.enhancementLevel);
    }
  }

  // ---- Food / drinks / abilities ---------------------------------------
  if (loadout) {
    (loadout.foodItemHrids || []).slice(0, 3).forEach((h, i) => {
      if (!h) return;
      if (!knownItem(h) || !combatConsumable(h)) { skipped.food.push(h); return; }
      player.food[i] = { itemHrid: h, triggers: loadout.consumableCombatTriggersMap?.[h] || [] };
    });
    (loadout.drinkItemHrids || []).slice(0, 3).forEach((h, i) => {
      if (!h) return;
      if (!knownItem(h) || !combatConsumable(h)) { skipped.drinks.push(h); return; }
      player.drinks[i] = { itemHrid: h, triggers: loadout.consumableCombatTriggersMap?.[h] || [] };
    });

    // Ability triggers: a loadout with its own trigger config wins; a
    // loadout with no trigger config at all falls back to the ability's
    // defaultCombatTriggers from the bundled game data.
    const loadoutTriggerMap = loadout.abilityCombatTriggersMap;
    const loadoutHasTriggers =
      loadoutTriggerMap && typeof loadoutTriggerMap === 'object' &&
      Object.keys(loadoutTriggerMap).length > 0;

    const abilityLevels = indexBy(char.characterAbilities || [], 'abilityHrid');
    const slots = Object.keys(loadout.abilityMap || {}).sort((a, b) => Number(a) - Number(b));
    slots.slice(0, 5).forEach((slot, i) => {
      const h = loadout.abilityMap[slot];
      if (!h) return;
      if (!knownAbility(h)) { skipped.abilities.push(h); return; }
      const level = abilityLevels.get(h)?.level ?? 1;
      let triggers;
      if (loadoutHasTriggers) {
        triggers = Array.isArray(loadoutTriggerMap[h]) ? loadoutTriggerMap[h] : [];
      } else {
        const def = gameData?.abilities?.[h]?.defaultCombatTriggers;
        triggers = Array.isArray(def) ? def : [];
      }
      player.abilities[i] = { hrid: h, level, triggers };
    });
  }

  // ---- House rooms ------------------------------------------------------
  for (const [hrid, entry] of Object.entries(char.characterHouseRoomMap || {})) {
    const level = typeof entry === 'number' ? entry : (entry?.level || 0);
    if (level <= 0) continue;
    if (!knownHouse(hrid)) { skipped.houseRooms.push(hrid); continue; }
    player.houseRooms[hrid] = level;
  }

  // ---- Achievements -------------------------------------------------------
  // characterAchievements is an array of {achievementHrid, isCompleted};
  // both the UI and the engine's Achievement class want a {hrid: true} map.
  for (const ach of char.characterAchievements || []) {
    if (ach?.isCompleted && ach.achievementHrid) {
      player.achievements[ach.achievementHrid] = true;
    }
  }

  player.debuffOnLevelGap = char.characterSetting?.debuffOnLevelGap ? 1 : 0;

  return { player, skipped, loadoutName: loadout?.name || null };
}
