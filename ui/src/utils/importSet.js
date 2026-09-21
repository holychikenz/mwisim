// =============================================================================
// importSet — conversions between the UI's internal player state and the
// import/export "set" format shared with the old webpack UI and upstream
// users. Consumed by ImportExport.jsx (clipboard) and mwixBridge.js
// (in-game "Open in csim" hash payloads).
// =============================================================================

// Convert internal player state to export format (compatible with old UI)
export function playerToExportFormat(player, zone, difficultyTier, duration) {
  const equipmentArray = [];
  for (const [slotKey, value] of Object.entries(player.equipment)) {
    if (value != null) {
      // Convert equipment_types to item_locations for compatibility
      const itemLocationHrid = slotKey.replace('equipment_types', 'item_locations');
      equipmentArray.push({
        itemLocationHrid,
        itemHrid: value.itemHrid,
        enhancementLevel: value.enhancementLevel || 0
      });
    }
  }

  const playerData = {
    attackLevel: player.attackLevel,
    magicLevel: player.magicLevel,
    meleeLevel: player.meleeLevel,
    rangedLevel: player.rangedLevel,
    defenseLevel: player.defenseLevel,
    staminaLevel: player.staminaLevel,
    intelligenceLevel: player.intelligenceLevel,
    equipment: equipmentArray
  };

  const abilitiesArray = player.abilities.map(a => ({
    abilityHrid: a?.hrid || '',
    level: a?.level || 1
  }));

  const drinksArray = player.drinks
    .filter(d => d != null)
    .map(d => ({ itemHrid: d.itemHrid }));

  const foodArray = player.food
    .filter(f => f != null)
    .map(f => ({ itemHrid: f.itemHrid }));

  // Build triggerMap from food, drinks, and abilities
  const triggerMap = {};

  // Add food triggers
  player.food.forEach(f => {
    if (f?.itemHrid && f.triggers?.length > 0) {
      triggerMap[f.itemHrid] = f.triggers;
    }
  });

  // Add drink triggers
  player.drinks.forEach(d => {
    if (d?.itemHrid && d.triggers?.length > 0) {
      triggerMap[d.itemHrid] = d.triggers;
    }
  });

  // Add ability triggers
  player.abilities.forEach(a => {
    if (a?.hrid && a.triggers?.length > 0) {
      triggerMap[a.hrid] = a.triggers;
    }
  });

  return {
    player: playerData,
    food: { '/action_types/combat': foodArray },
    drinks: { '/action_types/combat': drinksArray },
    abilities: abilitiesArray,
    triggerMap,
    zone: zone,
    difficultyTier: difficultyTier,
    simulationTime: duration,
    houseRooms: player.houseRooms || {},
    achievements: player.achievements || {},
    // Per-character fields, carried at the same trust level as houseRooms and
    // achievements above — written back verbatim, validated nowhere. They are
    // additive keys, so a set exported here still loads in the old webpack UI
    // and an older set still loads here (the reader defaults them).
    //
    // `abilityMemory` travels too, even though only five abilities are slotted:
    // it is what makes swapping an ability back restore the level and triggers
    // it had, and a set that dropped it would quietly forget everything the
    // moment it made a round trip through the clipboard.
    guildShrines: player.guildShrines || {},
    personalBuffs: player.personalBuffs || [],
    abilityMemory: player.abilityMemory || {}
  };
}

// Convert export format back to internal player state
export function exportFormatToPlayer(data, playerId) {
  const triggerMap = data.triggerMap || {};

  const player = {
    hrid: `player${playerId}`,
    staminaLevel: data.player?.staminaLevel || 1,
    intelligenceLevel: data.player?.intelligenceLevel || 1,
    attackLevel: data.player?.attackLevel || 1,
    meleeLevel: data.player?.meleeLevel || data.player?.powerLevel || 1,
    defenseLevel: data.player?.defenseLevel || 1,
    rangedLevel: data.player?.rangedLevel || 1,
    magicLevel: data.player?.magicLevel || 1,
    equipment: {},
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: data.houseRooms || {},
    achievements: data.achievements || {},
    personalBuffs: data.personalBuffs || [],
    abilityMemory: data.abilityMemory || {},
    debuffOnLevelGap: 0
  };

  // `guildShrines` is spread in ONLY when the set actually carried it, because
  // for this one field ABSENT and `{}` are different answers. utils/guildBuffs.js
  // `ownsShrines` reads `{}` as "we captured this member's shrines and they own
  // none" and no key at all as "defer to the party-wide knobs"; manufacturing
  // `{}` here would make the fallback unreachable, so a pre-branch set imported
  // into a guild-trial roster would simulate that seat with zero shrines while
  // the trial header's levels sat there being ignored.
  //
  // `personalBuffs` and `abilityMemory` above are NOT treated this way, and
  // deliberately: nothing falls back for either, so an absent key and an empty
  // one mean the same thing and a default costs nothing.
  if (data.guildShrines && typeof data.guildShrines === 'object') {
    player.guildShrines = data.guildShrines;
  }

  // Parse equipment
  if (data.player?.equipment && Array.isArray(data.player.equipment)) {
    for (const item of data.player.equipment) {
      // Skip items without valid itemHrid
      if (!item?.itemHrid) continue;

      // Convert item_locations back to equipment_types
      let slotKey = item.itemLocationHrid?.replace('item_locations', 'equipment_types');
      if (slotKey) {
        player.equipment[slotKey] = {
          itemHrid: item.itemHrid,
          enhancementLevel: item.enhancementLevel || 0
        };
      }
    }
  }

  // Parse food with triggers from triggerMap
  const foodData = data.food?.['/action_types/combat'] || [];
  for (let i = 0; i < 3 && i < foodData.length; i++) {
    const itemHrid = foodData[i]?.itemHrid;
    if (itemHrid && itemHrid.trim()) {
      const triggers = triggerMap[itemHrid] || [];
      player.food[i] = { itemHrid, triggers };
    }
  }

  // Parse drinks with triggers from triggerMap
  const drinksData = data.drinks?.['/action_types/combat'] || [];
  for (let i = 0; i < 3 && i < drinksData.length; i++) {
    const itemHrid = drinksData[i]?.itemHrid;
    if (itemHrid && itemHrid.trim()) {
      // Handle legacy 'power' -> 'melee' conversion
      const convertedHrid = itemHrid.replace('power', 'melee');
      const triggers = triggerMap[itemHrid] || triggerMap[convertedHrid] || [];
      player.drinks[i] = { itemHrid: convertedHrid, triggers };
    }
  }

  // Parse abilities with triggers from triggerMap
  if (data.abilities && Array.isArray(data.abilities)) {
    for (let i = 0; i < 5 && i < data.abilities.length; i++) {
      const abilityHrid = data.abilities[i]?.abilityHrid;
      // Skip empty abilities (null, undefined, or empty string)
      if (abilityHrid && abilityHrid.trim()) {
        const triggers = triggerMap[abilityHrid] || [];
        player.abilities[i] = {
          hrid: abilityHrid,
          level: Number(data.abilities[i].level) || 1,
          triggers
        };
      }
    }
  }

  return player;
}
