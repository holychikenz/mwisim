// =============================================================================
// characterToStore — converts a raw MWI character payload (characterData, as
// captured by MWIX / stored by cow/webapp) into a schemaVersion-2 CHARACTER
// carrying EVERY combat loadout the character owns.
//
// This is a port of tampermonkey/src/kernel/csim-dto.js (buildPlayerDTO),
// adapted in three ways:
//   - output uses the UI's internal shape (`itemHrid` keys in equipment /
//     food / drinks) rather than the engine DTO shape (`hrid`); App.jsx does
//     the DTO transform when a simulation starts.
//   - known-item / known-ability / known-house filtering uses the bundled
//     game data (useGameData) instead of MWIX's live setOverrides maps.
//   - it no longer PICKS one loadout and throws the rest away. The character
//     API hands us every loadout the player has built; the old flat model had
//     nowhere to put more than one, and the two-level model does. The queued
//     action still decides which one you land on — it just no longer decides
//     which ones you are allowed to keep.
//
// Source mapping (verified against characters/holychikenz.json):
//   levels        ← characterSkills[i].{skillHrid, level}          CHARACTER
//   abilityLevels ← characterAbilities[i].{abilityHrid, level}     CHARACTER
//   houseRooms    ← characterHouseRoomMap[hrid].level              CHARACTER
//   achievements  ← characterAchievements (array) → { hrid: true } CHARACTER
//   loadouts      ← every COMBAT entry of characterLoadoutMap:     LOADOUT
//     equipment     ← loadout.wearableMap ("charID::loc::itemHrid::enh" refs),
//                       falling back to worn characterItems when the character
//                       has no combat loadouts at all
//     food/drinks   ← loadout.foodItemHrids / drinkItemHrids
//                       + loadout.consumableCombatTriggersMap[hrid]
//     abilities     ← loadout.abilityMap (slot→hrid)
//                       + loadout.abilityCombatTriggersMap[hrid], falling back
//                       to the ability's defaultCombatTriggers
// =============================================================================

import { createCharacter, createLoadout, makeCharacterId } from './characterStore.js';

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

/**
 * Which of the imported loadouts the slot should land on, by NAME.
 *
 * Same precedence as the old pickLoadout — it just returns a name instead of
 * consuming the map, because every loadout now survives the import:
 *
 *   STRONG signal: the queued action's characterLoadoutID is the loadout the
 *   game is actively running — but only if it is a COMBAT loadout. (The queued
 *   action may be skilling, e.g. an enhancing kit whose teas the combat engine
 *   cannot simulate; feeding it those hangs the sim.)
 *
 *   Soft signals: the isDefault combat loadout, else the first one.
 *
 * @param {object} char      raw characterData
 * @param {Array}  imported  [{ name, raw }] in import order, combat only
 */
function pickDefaultLoadoutName(char, imported) {
  if (!imported.length) return null;
  const queue = (char?.characterActions || [])
    .slice()
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const head = queue[0];
  if (head?.characterLoadoutID != null) {
    const byActive = imported.find(l => String(l.raw.id) === String(head.characterLoadoutID));
    if (byActive) return byActive.name;
  }
  return (imported.find(l => l.raw.isDefault) || imported[0]).name;
}

/** Dedupe a loadout name within the set built so far ("tank", "tank (2)"). */
function uniqueName(base, taken) {
  const name = String(base || '').trim();
  if (!name) return null;
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/**
 * @param {object} char - raw characterData
 * @param {object} gameData - the bundled game data from useGameData
 * @param {string} [displayName] - what to call the character (the cow/webapp
 *   character name); falls back to the payload's own name.
 * @returns {{character: object, defaultLoadoutName: string|null, skipped: object}}
 */
export function characterToCharacter(char, gameData, displayName) {
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

  const name = displayName || char.name || 'Imported character';
  const character = {
    ...createCharacter({ name, id: makeCharacterId(name) }),
    houseRooms: {},
    achievements: {},
    // The character API carries no guild or seal information, so these start
    // empty and the user fills them in. They are present rather than absent on
    // purpose: an absent `guildShrines` means "defer to the party-wide knobs"
    // to resolveUnitShrineBuffs (utils/guildBuffs.js), and an imported
    // character deferring to someone else's shrines would be a lie. The
    // reasoning is stronger now than it was: a LOADOUT cannot carry a shrine at
    // all, so this is the only place the question can be answered.
    guildShrines: {},
    personalBuffs: [],
    abilityLevels: {},
    loadouts: {}
  };

  // Ability LEVELS, seeded from every ability the character has actually
  // trained — not merely the five a loadout slots. This was always character
  // data: the old flat model kept it in `abilityMemory` so that swapping a slot
  // did not forget a level, which is the same fact wearing a worse hat.
  for (const ability of char.characterAbilities || []) {
    const hrid = ability?.abilityHrid;
    if (!hrid || !knownAbility(hrid)) continue;
    character.abilityLevels[hrid] = Number(ability.level) || 1;
  }
  for (const [field, hrid] of Object.entries(LEVEL_MAP)) {
    character[field] = lvl(hrid);
  }

  const skipped = { equipment: [], abilities: [], food: [], drinks: [], houseRooms: [] };

  // ---- House rooms ------------------------------------------------------
  for (const [hrid, entry] of Object.entries(char.characterHouseRoomMap || {})) {
    const level = typeof entry === 'number' ? entry : (entry?.level || 0);
    if (level <= 0) continue;
    if (!knownHouse(hrid)) { skipped.houseRooms.push(hrid); continue; }
    character.houseRooms[hrid] = level;
  }

  // ---- Achievements -------------------------------------------------------
  // characterAchievements is an array of {achievementHrid, isCompleted};
  // both the UI and the engine's Achievement class want a {hrid: true} map.
  for (const ach of char.characterAchievements || []) {
    if (ach?.isCompleted && ach.achievementHrid) {
      character.achievements[ach.achievementHrid] = true;
    }
  }

  character.debuffOnLevelGap = char.characterSetting?.debuffOnLevelGap ? 1 : 0;

  // ---- Equipment --------------------------------------------------------
  function recordEquipment(target, slotLocation, itemHrid, enhancementLevel) {
    if (!slotLocation || !itemHrid) return;
    if (!knownItem(itemHrid)) {
      skipped.equipment.push(itemHrid);
      return;
    }
    const slot = slotLocation.replace('/item_locations/', '/equipment_types/');
    target[slot] = {
      itemHrid,
      enhancementLevel: Math.max(0, Math.floor(Number(enhancementLevel) || 0))
    };
  }

  /** One raw game loadout → one stored loadout (gear, slots, consumables). */
  function convertLoadout(raw) {
    const out = createLoadout();

    if (raw.wearableMap && typeof raw.wearableMap === 'object') {
      // Parse "::"-joined wearable refs.
      for (const [slotLocation, rawRef] of Object.entries(raw.wearableMap)) {
        if (!rawRef) continue;
        const parts = String(rawRef).split('::');
        if (parts.length < 4) continue;
        recordEquipment(out.equipment, slotLocation, parts[2], Number(parts[3]) || 0);
      }
    }

    (raw.foodItemHrids || []).slice(0, 3).forEach((h, i) => {
      if (!h) return;
      if (!knownItem(h) || !combatConsumable(h)) { skipped.food.push(h); return; }
      out.food[i] = { itemHrid: h, triggers: raw.consumableCombatTriggersMap?.[h] || [] };
    });
    (raw.drinkItemHrids || []).slice(0, 3).forEach((h, i) => {
      if (!h) return;
      if (!knownItem(h) || !combatConsumable(h)) { skipped.drinks.push(h); return; }
      out.drinks[i] = { itemHrid: h, triggers: raw.consumableCombatTriggersMap?.[h] || [] };
    });

    // Ability triggers: a loadout with its own trigger config wins; a
    // loadout with no trigger config at all falls back to the ability's
    // defaultCombatTriggers from the bundled game data.
    const loadoutTriggerMap = raw.abilityCombatTriggersMap;
    const loadoutHasTriggers =
      loadoutTriggerMap && typeof loadoutTriggerMap === 'object' &&
      Object.keys(loadoutTriggerMap).length > 0;

    const slots = Object.keys(raw.abilityMap || {}).sort((a, b) => Number(a) - Number(b));
    slots.slice(0, 5).forEach((slot, i) => {
      const h = raw.abilityMap[slot];
      if (!h) return;
      if (!knownAbility(h)) { skipped.abilities.push(h); return; }
      let triggers;
      if (loadoutHasTriggers) {
        triggers = Array.isArray(loadoutTriggerMap[h]) ? loadoutTriggerMap[h] : [];
      } else {
        const def = gameData?.abilities?.[h]?.defaultCombatTriggers;
        triggers = Array.isArray(def) ? def : [];
      }
      // NO `level` on the slot: an ability's level belongs to the character
      // (abilityLevels above) and is stamped in by resolvePlayer. Storing it
      // here is exactly the second copy this model exists to make impossible.
      out.abilities[i] = { hrid: h, triggers };
      out.triggerMemory[h] = triggers;
    });

    return out;
  }

  // ---- Every combat loadout ---------------------------------------------
  const combat = Object.values(char.characterLoadoutMap || {})
    .filter(l => l && l.actionTypeHrid === '/action_types/combat');

  const taken = new Set();
  const imported = [];
  for (const raw of combat) {
    const name = uniqueName(raw.name, taken) || uniqueName(`loadout ${raw.id}`, taken);
    if (!name) continue;
    taken.add(name);
    character.loadouts[name] = convertLoadout(raw);
    imported.push({ name, raw });
  }

  let defaultLoadoutName = pickDefaultLoadoutName(char, imported);

  if (!imported.length) {
    // No combat loadouts at all: fall back to whatever is currently worn, as
    // one loadout named `worn`. This is the ONLY case the worn-items path
    // covers — a character with loadouts is described by them.
    const worn = createLoadout();
    for (const item of char.characterItems || []) {
      const loc = item?.itemLocationHrid;
      if (!loc || loc === '/item_locations/inventory') continue;
      if (!(item.count > 0)) continue;
      recordEquipment(worn.equipment, loc, item.itemHrid, item.enhancementLevel);
    }
    character.loadouts.worn = worn;
    defaultLoadoutName = 'worn';
  }

  return { character, defaultLoadoutName, skipped };
}
