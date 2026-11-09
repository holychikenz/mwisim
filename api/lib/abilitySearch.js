// =============================================================================
// abilitySearch — the ability changes the Abilities tool tries for ONE player:
// another owned ability in one slot, or another cast order of slots 1-4, and a
// coordinate descent's answer (bestCandidate); the search itself is descent.js's.
// Pure apart from the game data; the statistics are rankCandidates'
// (equipmentScan/scan.js).
//
// The rules are the game's and the engine's:
//   * slot i (DTO index; 0 is the special) unlocks at BASE intelligence >=
//     abilitySlotsLevelRequirementList[i + 1] (player.js createFromDTO). A
//     locked slot is never filled or changed.
//   * slot 0 takes special abilities only, slots 1-4 the rest (PlayerConfig).
//   * an ability is never slotted twice, and only owned ones are tried.
//   * the engine casts an ability with NO triggers always (ability.js
//     shouldTrigger) and reads defaultCombatTriggers only when a DTO has none at
//     all, so a swapped-in ability carries explicit triggers: the ones its
//     loadout remembers for it (triggerMemory), else the game's defaults. Kept
//     abilities keep theirs; a re-order moves them with the ability.
// =============================================================================
import { descentWorkload } from './descent.js';

const { abilityDetailMap, abilitySlotsLevelRequirementList } =
  await import('../../src/combatsimulator/dataProvider.js');

/** What the tool can vary: each slot by DTO index, and the cast order. */
export const COORDINATES = ['s0', 's1', 's2', 's3', 's4', 'order'];
const SLOT_LABELS = ['Aura', 'Ability 1', 'Ability 2', 'Ability 3', 'Ability 4']; // as PlayerConfig names them
const FACTORIAL = [1, 1, 2, 6, 24];
const slotOf = (coordinate) => Number(coordinate.slice(1));
export const labelOf = (coordinate) => (coordinate === 'order' ? 'Cast order' : SLOT_LABELS[slotOf(coordinate)]);
const nameOf = (hrid) => (hrid ? abilityDetailMap[hrid]?.name ?? hrid : 'empty');
const isSpecial = (hrid) => !!abilityDetailMap[hrid]?.isSpecialAbility;

/** A slot as the engine reads it: the remembered triggers ([] included: cast whenever ready), else the game's defaults — copied, never absent. */
const slotted = (hrid, level, remembered) =>
  ({ hrid, level, triggers: (remembered || abilityDetailMap[hrid].defaultCombatTriggers || []).map((t) => ({ ...t })) });

/** The subject's five slots, what it may slot ({hrid: level}: known hrids at level >= 1, plus anything already slotted), which slots are unlocked, and the triggers its loadout remembers per ability. */
export function abilityContext(subject, ownedAbilities, triggerMemory) {
  const abilities = [0, 1, 2, 3, 4].map((i) => subject?.abilities?.[i] ?? null);
  const owned = {};
  for (const [hrid, value] of Object.entries(ownedAbilities && typeof ownedAbilities === 'object' ? ownedAbilities : {})) {
    const level = Math.floor(Number(value));
    if (Object.hasOwn(abilityDetailMap, hrid) && level >= 1) owned[hrid] = level;
  }
  for (const slot of abilities) {
    if (slot?.hrid && Object.hasOwn(abilityDetailMap, slot.hrid)) owned[slot.hrid] ??= Math.max(1, Math.floor(Number(slot.level)) || 1);
  }
  const list = abilitySlotsLevelRequirementList;
  const intelligence = Number(subject?.intelligenceLevel);
  const unlocked = abilities.map((_, i) => list.length === 0 || intelligence >= (list[i + 1] ?? Infinity));
  // Lists of trigger objects, [] included; absent means never set up in this loadout.
  const remembered = {};
  for (const [hrid, list] of Object.entries(triggerMemory && typeof triggerMemory === 'object' ? triggerMemory : {})) {
    if (Object.hasOwn(abilityDetailMap, hrid) && Array.isArray(list) && list.every((t) => t && typeof t === 'object')) remembered[hrid] = list;
  }
  return { abilities, owned, unlocked, remembered };
}

function swapsAt(abilities, slot, ctx) {
  if (!ctx.unlocked[slot]) return [];
  const equipped = new Set(abilities.filter(Boolean).map((a) => a.hrid)); // locked slots too: never a duplicate
  return Object.keys(ctx.owned)
    .filter((hrid) => !equipped.has(hrid) && isSpecial(hrid) === (slot === 0))
    .sort()
    .map((hrid) => {
      const next = abilities.slice();
      next[slot] = slotted(hrid, ctx.owned[hrid], ctx.remembered[hrid]);
      return { id: `s${slot}:${hrid}`, label: `${SLOT_LABELS[slot]}: ${nameOf(abilities[slot]?.hrid)} → ${nameOf(hrid)}`, slot, to: hrid, abilities: next };
    });
}

const permutations = (list) => (list.length <= 1 ? [list]
  : list.flatMap((first, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [first, ...rest])));

function ordersOf(abilities, ctx) {
  const slots = [1, 2, 3, 4].filter((i) => ctx.unlocked[i] && abilities[i]);
  return permutations(slots)
    .filter((order) => order.some((source, j) => source !== slots[j]))
    .map((order) => {
      const next = abilities.slice();
      order.forEach((source, j) => { next[slots[j]] = abilities[source]; });
      return { id: `order:${order.join('-')}`, label: `Cast order: ${slots.map((i) => nameOf(next[i].hrid)).join(' → ')}`, abilities: next };
    });
}

/** The candidates one coordinate offers from `abilities`. Ids never contain '#'. */
export function candidatesAt(abilities, coordinate, ctx) {
  return coordinate === 'order' ? ordersOf(abilities, ctx) : swapsAt(abilities, slotOf(coordinate), ctx);
}

/** For the panel: per coordinate, its label, whether (and at what intelligence) it unlocks, and how many changes it offers now. */
export function coordinateSummary(ctx) {
  return COORDINATES.map((key) => {
    const slot = key === 'order' ? null : slotOf(key);
    return { key, label: labelOf(key), unlocked: slot == null || ctx.unlocked[slot],
      unlockLevel: slot == null ? null : abilitySlotsLevelRequirementList[slot + 1] ?? null,
      count: candidatesAt(ctx.abilities, key, ctx).length };
  });
}

/**
 * An upper bound (for loadouts the game can produce) on what a descent
 * simulates, in estimateWorkload's shape: a slot never offers more than it does
 * now, since moves only fill or swap; a cast order is counted as if every
 * unlocked slot 1-4 were filled; plus the confirmation run.
 */
export function estimateDescent(ctx, coordinates, passes, { hours, replicates }) {
  const perPass = coordinates.reduce((sims, key) => {
    if (key === 'order') {
      const k = [1, 2, 3, 4].filter((i) => ctx.unlocked[i]).length;
      return k >= 2 ? sims + FACTORIAL[k] : sims; // k! - 1 orders + the baseline
    }
    const count = candidatesAt(ctx.abilities, key, ctx).length;
    return count ? sims + count + 1 : sims;
  }, 0);
  return descentWorkload(perPass, passes, { hours, replicates });
}

/** A trigger list as data: each trigger's keys sorted (the order they were written in is not), the list's order kept. */
const triggersKey = (list) => JSON.stringify(Array.isArray(list) ? list.map((t) => Object.entries(t ?? {}).sort()) : null);
/** Same ability with the same triggers. A descent can end on the starting abilities with other triggers (one swapped out
 *  and back in comes back with its remembered or default ones), and that is a change worth offering. */
const sameSlot = (a, b) => (a?.hrid ?? null) === (b?.hrid ?? null) && triggersKey(a?.triggers) === triggersKey(b?.triggers);

/** The descent's answer as one candidate against the true start (ctx.abilities), or null when it ended exactly there. */
export function bestCandidate(ctx, abilities) {
  const changes = [0, 1, 2, 3, 4]
    .filter((i) => !sameSlot(abilities[i], ctx.abilities[i]))
    .map((i) => (abilities[i]?.hrid === ctx.abilities[i]?.hrid
      ? `${SLOT_LABELS[i]}: ${nameOf(abilities[i]?.hrid)}, other triggers`
      : `${SLOT_LABELS[i]}: ${nameOf(ctx.abilities[i]?.hrid)} → ${nameOf(abilities[i]?.hrid)}`));
  return changes.length ? { id: 'best', label: changes.join(', '), abilities } : null;
}
