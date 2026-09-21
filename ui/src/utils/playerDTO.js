// =============================================================================
// playerDTO — turns the UI's internal player / master-build object into the
// engine DTO shape the worker's Player.createFromDTO expects.
//
// The internal shape uses `itemHrid` keys (equipment / food / drinks); the
// engine DTO uses `hrid`. This transform is shared by the zone/lab path
// (App.handleStartSimulation) and the guild-trial roster path so the two can
// never drift apart.
// =============================================================================

/**
 * @param {object} player   internal player / master-build object
 * @param {object} opts
 * @param {string} [opts.hrid]              unit hrid (e.g. "player1"); trials
 *   must pass a UNIQUE hrid per roster entry so per-unit death stats don't
 *   collide when several entries share one master build.
 * @param {boolean} [opts.stripConsumables] blank out food/drinks (labyrinth &
 *   guild trials disable consumables; the engine ignores them there anyway).
 * @returns {object} engine DTO
 */
export function toPlayerDTO(player, { hrid, stripConsumables = false } = {}) {
  const equipmentEntries = Object.entries(player.equipment || {})
    .filter(([, value]) => value && value.itemHrid)
    .map(([key, value]) => [
      key,
      { hrid: value.itemHrid, enhancementLevel: value.enhancementLevel || 0 },
    ]);

  const dto = {
    ...player,
    hrid: hrid ?? player.hrid,
    equipment: Object.fromEntries(equipmentEntries),
    food: stripConsumables
      ? [null, null, null]
      : (player.food || []).map(f =>
          f?.itemHrid ? { hrid: f.itemHrid, triggers: f.triggers || [] } : null
        ),
    drinks: stripConsumables
      ? [null, null, null]
      : (player.drinks || []).map(d =>
          d?.itemHrid ? { hrid: d.itemHrid, triggers: d.triggers || [] } : null
        ),
    abilities: (player.abilities || []).map(a =>
      a?.hrid ? { hrid: a.hrid, level: a.level || 1, triggers: a.triggers || [] } : null
    ),
  };

  // `abilityMemory` is UI-only bookkeeping — the level and triggers each ability
  // last had for this player, so that re-slotting one restores them
  // (PlayerConfig.applyAbilities). The engine has never heard of it, and the
  // spread above would otherwise carry a character's ENTIRE trained-ability list
  // into every DTO, including the ones POSTed to the API on each optimiser
  // preview — which re-fires 350ms after every keystroke. Dropped here rather
  // than at the five call sites, so that no future one can forget to.
  delete dto.abilityMemory;

  return dto;
}
