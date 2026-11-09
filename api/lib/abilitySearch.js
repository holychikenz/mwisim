// =============================================================================
// abilitySearch — the ability changes the Abilities tool tries for ONE player:
// another owned ability in one slot, or another cast order of slots 1-4, and a
// coordinate descent that chains them. Pure apart from the game data; the
// statistics are rankCandidates' (equipmentScan/scan.js).
//
// The rules are the game's and the engine's:
//   * slot i (DTO index; 0 is the special) unlocks at BASE intelligence >=
//     abilitySlotsLevelRequirementList[i + 1] (player.js createFromDTO). A
//     locked slot is never filled or changed.
//   * slot 0 takes special abilities only, slots 1-4 the rest (PlayerConfig).
//   * an ability is never slotted twice, and only owned ones are tried.
//   * the engine casts an ability with NO triggers always (ability.js
//     shouldTrigger) and reads defaultCombatTriggers only when a DTO has none at
//     all, so a swapped-in ability carries the game's defaults explicitly. Kept
//     abilities keep theirs; a re-order moves them with the ability.
// =============================================================================
const { abilityDetailMap, abilitySlotsLevelRequirementList } =
  await import('../../src/combatsimulator/dataProvider.js');

/** What the tool can vary: each slot by DTO index, and the cast order. */
export const COORDINATES = ['s0', 's1', 's2', 's3', 's4', 'order'];
const SLOT_LABELS = ['Aura', 'Ability 1', 'Ability 2', 'Ability 3', 'Ability 4']; // as PlayerConfig names them
const FACTORIAL = [1, 1, 2, 6, 24];
const slotOf = (coordinate) => Number(coordinate.slice(1));
const labelOf = (coordinate) => (coordinate === 'order' ? 'Cast order' : SLOT_LABELS[slotOf(coordinate)]);
const nameOf = (hrid) => (hrid ? abilityDetailMap[hrid]?.name ?? hrid : 'empty');
const isSpecial = (hrid) => !!abilityDetailMap[hrid]?.isSpecialAbility;

/** A slot as the engine reads it, with the game's default triggers spelled out. */
const slotted = (hrid, level) => ({ hrid, level, triggers: (abilityDetailMap[hrid].defaultCombatTriggers || []).map((t) => ({ ...t })) });

/** The subject's five slots, what it may slot ({hrid: level}: known hrids at level >= 1, plus anything already slotted), and which slots are unlocked. */
export function abilityContext(subject, ownedAbilities) {
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
  return { abilities, owned, unlocked };
}

function swapsAt(abilities, slot, ctx) {
  if (!ctx.unlocked[slot]) return [];
  const equipped = new Set(abilities.filter(Boolean).map((a) => a.hrid)); // locked slots too: never a duplicate
  return Object.keys(ctx.owned)
    .filter((hrid) => !equipped.has(hrid) && isSpecial(hrid) === (slot === 0))
    .sort()
    .map((hrid) => {
      const next = abilities.slice();
      next[slot] = slotted(hrid, ctx.owned[hrid]);
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
  const perReplicate = perPass * passes + 2;
  const total = perReplicate * replicates;
  return { candidates: perPass, replicates, perReplicate, total, simulatedHours: total * hours };
}

/**
 * Coordinate descent: each pass visits every coordinate, ranks what it offers
 * against the current best, and moves only on a family-wise significant gain;
 * a descent that followed noise would wander. Stops after a pass that moves
 * nothing, or after `passes`. `rank(abilities, candidates, label)` is
 * rankCandidates against `abilities`.
 */
export async function descendAbilities({ ctx, coordinates, passes, rank }) {
  let abilities = ctx.abilities;
  const steps = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    let moved = false;
    for (const coordinate of coordinates) {
      const candidates = candidatesAt(abilities, coordinate, ctx);
      if (!candidates.length) continue;
      const label = labelOf(coordinate);
      const [best] = (await rank(abilities, candidates, `pass ${pass} · ${label}`)).rows;
      const taken = best.significantFamilywise && best.delta > 0;
      steps.push({ pass, coordinate, label, tried: candidates.length, best: best.label, deltaPct: best.deltaPct, taken });
      if (taken) { abilities = best.abilities; moved = true; }
    }
    if (!moved) break;
  }
  return { abilities, steps };
}

/** The descent's answer as one candidate against where it started. */
export function bestCandidate(ctx, abilities) {
  const changes = [0, 1, 2, 3, 4]
    .filter((i) => abilities[i]?.hrid !== ctx.abilities[i]?.hrid)
    .map((i) => `${SLOT_LABELS[i]}: ${nameOf(ctx.abilities[i]?.hrid)} → ${nameOf(abilities[i]?.hrid)}`);
  return { id: 'best', label: changes.join(', ') || 'No change found', abilities };
}
