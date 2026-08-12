// =============================================================================
// candidates — which equipped pieces are worth simulating, and what "+6" means
//
// The trigger optimiser SEARCHES: it has a space of threshold combinations and
// hunts for the best one. This does not. Every equipped piece gets measured and
// every piece gets reported, because the question is not "what is the best
// build" but "where is the next enhancement level worth spending". A funnel that
// discarded the losers would throw away exactly the answer being asked for.
//
// So the only job here is deciding which slots CANNOT move the needle, and
// saying why. Three reasons, in increasing subtlety:
//
//   1. The item is already at the cap. enhancementLevelTotalMultiplierTable has
//      21 entries, so +20 is the ceiling; there is no +21 to measure. Worse, the
//      engine does not guard the lookup — an over-cap level yields an undefined
//      multiplier, hence NaN stats, hence a simulation that neither throws nor
//      means anything. Clamping is not a nicety.
//
//   2. The item has no enhancement bonuses at all. Trinkets (task badges) carry
//      combat stats but no combatEnhancementBonuses; ~60 of the 102 charms are
//      skilling charms with no combat stats whatever, as are all eleven skilling
//      tool types. Enhancing these is a guaranteed no-op and simulating them
//      would spend real time proving zero.
//
//   3. The item has bonuses, but none on a stat it actually carries. This falls
//      out of Equipment.getCombatStat, which gates on the truthiness of the BASE
//      stat before consulting the bonus:
//
//        if (this.gameItem.equipmentDetail.combatStats[combatStat]) {
//            let bonus = ...combatEnhancementBonuses[combatStat] || 0;
//
//      A bonus on a stat whose base is 0 or absent is therefore dead weight in
//      the engine. No bundled item is affected today, so this is a latent case
//      rather than a live one — but the predicate here mirrors the engine's rule
//      exactly rather than approximating it, so the two cannot drift apart.
//
// The step is clamped per item, not per run. An item at +17 asked for +6 gets +3,
// and the row records what it actually got, because the caller divides by the
// step to report a per-level figure and dividing by the requested 6 would
// understate that item by half.
// =============================================================================

const { itemDetailMap, enhancementLevelTotalMultiplierTable } = await import(
  '../../../src/combatsimulator/dataProvider.js'
);

/**
 * Highest enhancement level the engine can evaluate.
 *
 * Derived from the multiplier table rather than hard-coded, so a game patch that
 * extends enhancement past +20 lifts this automatically. The UI's own clamp
 * (PlayerConfig.jsx) is a separate literal 20; this one is the authority for the
 * scan because it is the one the engine will actually index.
 */
export const MAX_ENHANCEMENT_LEVEL = Math.max(0, enhancementLevelTotalMultiplierTable.length - 1);

/**
 * Default probe size.
 *
 * A single +1 on one piece moves encounters/hour by well under the Monte-Carlo
 * noise floor on any zone worth optimising for, so measuring it directly means
 * measuring nothing. Six levels lifts the signal clear of the floor; the result
 * is then divided by six and reported per level, which assumes the response is
 * locally linear in the multiplier. It is not exactly — the multiplier table is
 * convex (1, 2.1, 3.3, 4.6, 6, 7.5, ...), so six levels buys somewhat more than
 * six times one level's multiplier — and `multiplierRatio` on each row records
 * by how much, so the assumption is visible rather than buried.
 */
export const DEFAULT_STEP = 6;

/**
 * Stats the engine models in a way that flatters an enhancement figure.
 *
 * Only one entry, and it earns its place. `taskDamage` is applied to EVERY damage
 * roll in the engine — combatUtilities.js multiplies by
 * `1 + source.combatDetails.combatStats.taskDamage` unconditionally, with no test
 * that the target is on the player's task list. In the game it applies only to
 * task monsters. So a task badge reads to the simulator as a flat global damage
 * multiplier, and on a first real run an Expert Task Badge duly came out ranked
 * first, at 1.35% per level — ahead of the weapon.
 *
 * That is the engine's behaviour, not this module's, and `src/combatsimulator/`
 * is upstream-tracked: correcting it here would be a divergence to re-resolve on
 * every sync, for a question the scan is not the right place to answer. So the
 * row is measured and reported like any other and carries a caveat saying what
 * the number assumes. A silent exclusion would be worse — the figure is exactly
 * right for a player who is always on task.
 */
export const CAVEATED_STATS = Object.freeze({
  taskDamage:
    'the simulator applies task damage to every encounter, so this figure holds only while you are on task',
});

/** Pretty-print `/equipment_types/main_hand` as `Main hand`. */
function slotLabel(slotKey) {
  const tail = String(slotKey || '').split('/').pop() || '';
  const words = tail.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Does enhancing this item change any stat the engine will read?
 *
 * Mirrors Equipment.getCombatStat: a stat contributes only when its BASE value
 * is truthy and its enhancement bonus is non-zero.
 *
 * @param {object} gameItem  an itemDetailMap entry
 * @returns {boolean}
 */
export function liveEnhancementStats(gameItem) {
  const detail = gameItem?.equipmentDetail;
  if (!detail) return [];
  const stats = detail.combatStats || {};
  const bonuses = detail.combatEnhancementBonuses || {};
  return Object.keys(bonuses).filter((stat) => bonuses[stat] && stats[stat]);
}

export function hasLiveEnhancementBonus(gameItem) {
  return liveEnhancementStats(gameItem).length > 0;
}

/**
 * A caveat when EVERY stat this item gains is one the engine overstates.
 *
 * All-or-nothing on purpose. An item that gains task damage alongside four
 * ordinary stats is measured fairly enough that a warning would be noise; an
 * item whose only gain is task damage is measuring something the engine applies
 * more broadly than the game does, and the reader has to be told.
 *
 * @param {string[]} statNames
 * @returns {string|null}
 */
export function caveatFor(statNames) {
  if (!statNames.length) return null;
  if (!statNames.every((stat) => CAVEATED_STATS[stat])) return null;
  return CAVEATED_STATS[statNames[0]];
}

/**
 * Ratio of the multiplier actually gained to `step` single-level steps at the
 * current level, i.e. how far from linear the divide-by-step assumption is.
 *
 * 1 means perfectly linear. Above 1 means the six-level probe bought more per
 * level than the next single level will, so the reported per-level figure is
 * optimistic; below 1, pessimistic.
 *
 * @param {number} from   current enhancement level
 * @param {number} to     probed enhancement level
 * @returns {number|null} null when the next single level is off the table
 */
export function multiplierRatio(from, to) {
  const table = enhancementLevelTotalMultiplierTable;
  const base = Number(table[from]);
  const probed = Number(table[to]);
  const nextSingle = Number(table[from + 1]);
  if (!Number.isFinite(base) || !Number.isFinite(probed) || !Number.isFinite(nextSingle)) return null;
  const singleGain = nextSingle - base;
  const steps = to - from;
  if (!(steps > 0) || !(Math.abs(singleGain) > 1e-9)) return null;
  return (probed - base) / steps / singleGain;
}

/**
 * Enumerate every equipped piece across the party, scannable or not.
 *
 * Iterates the DTO's equipment map rather than a fixed slot list: Player seeds
 * only ten keys but createFromDTO happily adds any others, and updateCombatDetails
 * iterates the values, so neck/earrings/ring/charm do count even though the
 * class does not pre-declare them. A hard-coded list would silently omit them.
 *
 * @param {object[]} playerDTOs
 * @param {object} [opts]
 * @param {number} [opts.step]  requested probe size, clamped per item
 * @returns {Array<object>} one row per equipped slot, `scannable` and `reason` set
 */
export function enumerateEquipment(playerDTOs, { step = DEFAULT_STEP } = {}) {
  const requested = Math.max(1, Math.floor(Number(step)) || DEFAULT_STEP);
  const rows = [];

  (playerDTOs || []).forEach((player, playerIndex) => {
    const equipment = player?.equipment || {};
    for (const [slotKey, entry] of Object.entries(equipment)) {
      if (!entry || !entry.hrid) continue;

      const itemHrid = entry.hrid;
      const gameItem = itemDetailMap[itemHrid];
      const currentLevel = Math.max(0, Math.floor(Number(entry.enhancementLevel) || 0));

      const row = {
        id: `${playerIndex}:${slotKey}`,
        playerIndex,
        playerHrid: player?.hrid ?? `player${playerIndex + 1}`,
        slotKey,
        slotName: slotLabel(slotKey),
        itemHrid,
        itemName: gameItem?.name || itemHrid.split('/').pop().replace(/_/g, ' '),
        currentLevel,
        requestedStep: requested,
        step: 0,
        targetLevel: currentLevel,
        multiplierRatio: null,
        scannable: false,
        reason: null,
        gainedStats: [],
        caveat: null,
      };

      if (!gameItem) {
        row.reason = 'unknown item';
        rows.push(row);
        continue;
      }
      if (!gameItem.equipmentDetail) {
        row.reason = 'not equipment';
        rows.push(row);
        continue;
      }
      if (currentLevel >= MAX_ENHANCEMENT_LEVEL) {
        row.reason = `already at +${MAX_ENHANCEMENT_LEVEL}`;
        rows.push(row);
        continue;
      }
      const gainedStats = liveEnhancementStats(gameItem);
      if (!gainedStats.length) {
        row.reason = 'no combat stat gains from enhancing';
        rows.push(row);
        continue;
      }
      row.gainedStats = gainedStats;
      row.caveat = caveatFor(gainedStats);

      // Clamped here, not by the caller: an item near the cap gets a shorter
      // probe and the row must carry the step that was actually used, because
      // the per-level figure divides by it.
      row.step = Math.min(requested, MAX_ENHANCEMENT_LEVEL - currentLevel);
      row.targetLevel = currentLevel + row.step;
      row.multiplierRatio = multiplierRatio(currentLevel, row.targetLevel);
      row.scannable = true;
      rows.push(row);
    }
  });

  return rows;
}

/**
 * Deep-clone the party and raise one slot to its probed level.
 *
 * The clone is not optional. Player.createFromDTO builds live objects carrying
 * per-run state, so a DTO shared between two candidate runs is a correctness bug
 * rather than a memory saving — the same reasoning as triggerSearch/params.js
 * applyValues, which says so at greater length.
 *
 * @param {object[]} playerDTOs
 * @param {{playerIndex: number, slotKey: string, targetLevel: number}} candidate
 * @returns {object[]}
 */
export function applyEnhancement(playerDTOs, candidate) {
  const clone = structuredClone(playerDTOs);
  const slot = clone?.[candidate.playerIndex]?.equipment?.[candidate.slotKey];
  if (!slot) {
    throw new Error(
      `Cannot apply enhancement: player ${candidate.playerIndex} has nothing in ${candidate.slotKey}`
    );
  }
  slot.enhancementLevel = Math.min(MAX_ENHANCEMENT_LEVEL, Math.max(0, candidate.targetLevel));
  return clone;
}
