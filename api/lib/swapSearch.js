// =============================================================================
// swapSearch — the changes the Swaps tool tries for ONE player, from what the
// character owns: another owned food or drink in an open consumable slot, or
// another owned piece it can wear in a gear slot; and a descent's answer as one
// candidate. Pure apart from the game data; the statistics are rankCandidates',
// the combination search descent.js's. The rules are the game's and the engine's:
//   * consumable slots open: 1 + the pouch's foodSlots / drinkSlots (player.js
//     createFromDTO). A consumable is never slotted twice (a closed slot counts)
//     and a swapped-in one carries copies of its game default triggers.
//   * a piece goes in the slot its equipmentDetail.type names, at the highest
//     enhancement owned, as the game equips it — except the piece worn at the
//     start, which goes back exactly as worn. A two-hander clears the main and
//     off hand and either of those clears a two-hander (PlayerConfig); no off
//     hand is tried under a two-hander.
//   * combat-level requirements are checked against the build; the import has
//     dropped what fails a total-level or skilling one (characterToStore.js).
//   * owned = the posted inventory plus whatever is worn or slotted.
// Coordinates: 'food:0'..'drinks:2' and the gear slots. Ids never contain '#'.
// =============================================================================
import { MAX_ENHANCEMENT_LEVEL } from './equipmentScan/candidates.js';
import { descentWorkload } from './descent.js';

const { itemDetailMap } = await import('../../src/combatsimulator/dataProvider.js');

const SLOT_LABELS = Object.fromEntries([['head', 'Head'], ['body', 'Body'], ['legs', 'Legs'], ['feet', 'Feet'], ['hands', 'Hands'],
  ['main_hand', 'Main Hand'], ['two_hand', 'Two Hand'], ['off_hand', 'Off Hand'], ['pouch', 'Pouch'], ['back', 'Back'], ['neck', 'Neck'],
  ['earrings', 'Earrings'], ['ring', 'Ring'], ['charm', 'Charm']].map(([key, label]) => [`/equipment_types/${key}`, label])); // PlayerConfig EQUIPMENT_SLOTS
const GEAR = Object.keys(SLOT_LABELS);
const [MAIN, TWO, OFF, POUCH] = ['main_hand', 'two_hand', 'off_hand', 'pouch'].map((s) => `/equipment_types/${s}`);
const KIND_LABELS = { food: 'Food', drinks: 'Drink' };
export const COORDINATES = [...['food', 'drinks'].flatMap((kind) => [0, 1, 2].map((i) => `${kind}:${i}`)), ...GEAR];
const LEVEL_FIELDS = { '/skills/stamina': 'staminaLevel', '/skills/intelligence': 'intelligenceLevel', '/skills/attack': 'attackLevel',
  '/skills/melee': 'meleeLevel', '/skills/defense': 'defenseLevel', '/skills/ranged': 'rangedLevel', '/skills/magic': 'magicLevel' };

const nameOf = (hrid) => (hrid ? itemDetailMap[hrid]?.name ?? hrid : 'empty');
/** 'food' | 'drinks' | null, as useGameData getFood / getDrinks decide. */
const consumableKind = (detail) => (!detail?.consumableDetail?.usableInActionTypeMap?.['/action_types/combat'] ? null
  : detail.categoryHrid?.includes('drink') ? 'drinks' : detail.categoryHrid?.includes('food') ? 'food' : null);
const requirementKey = (hrid) => (itemDetailMap[hrid]?.equipmentDetail?.levelRequirements || []).map((r) => r.skillHrid).sort().join();
const slotsOf = (pouchHrid, kind) => Math.min(3, 1 + (Number(itemDetailMap[pouchHrid]?.equipmentDetail?.combatStats?.[kind === 'food' ? 'foodSlots' : 'drinkSlots']) || 0));
const parse = (coordinate) => { const [kind, index] = coordinate.split(':'); return KIND_LABELS[kind] ? { kind, index: Number(index) } : { slot: coordinate }; };
export const labelOf = (coordinate) => { const c = parse(coordinate); return c.kind ? `${KIND_LABELS[c.kind]} ${c.index + 1}` : SLOT_LABELS[c.slot]; };

/**
 * The subject's start ({ equipment, food, drinks }, three of each), what it owns by slot (pool: sorted hrids), the
 * highest enhancement owned per piece, and which items are tried: what it starts with, plus `allowed` (a Set of
 * hrids) when posted, else the defaults — every owned food and drink, and gear needing the same skills as the slot's
 * item now (empty slot: none). `unpriced(hrid)`: a consumable the objective would count as free, so never a default.
 */
export function swapContext(subject, owned, { allowed = null, consumables = true, unpriced = null } = {}) {
  const three = (list) => [0, 1, 2].map((i) => list?.[i] ?? null);
  const start = { equipment: { ...(subject?.equipment || {}) }, food: three(subject?.food), drinks: three(subject?.drinks) };
  const best = new Map();
  const own = (hrid, enhancement) => {
    if (typeof hrid !== 'string' || !Object.hasOwn(itemDetailMap, hrid)) return;
    best.set(hrid, Math.max(best.get(hrid) ?? 0, Math.min(MAX_ENHANCEMENT_LEVEL, Math.max(0, Math.floor(Number(enhancement)) || 0))));
  };
  for (const entry of Array.isArray(owned) ? owned : []) own(entry?.itemHrid, entry?.enhancementLevel);
  for (const piece of Object.values(start.equipment)) own(piece?.hrid, piece?.enhancementLevel);
  for (const c of [...start.food, ...start.drinks]) own(c?.hrid, 0); // slotted means owned: a descent may put it back
  const meets = (detail) => (detail.equipmentDetail.levelRequirements || [])
    .every((r) => !LEVEL_FIELDS[r.skillHrid] || Number(subject?.[LEVEL_FIELDS[r.skillHrid]]) >= r.level);
  const pool = { food: [], drinks: [] };
  for (const hrid of [...best.keys()].sort()) {
    const detail = itemDetailMap[hrid];
    const kind = consumableKind(detail);
    if (kind) { if (consumables) pool[kind].push(hrid); continue; }
    const slot = detail.equipmentDetail?.type;
    if (SLOT_LABELS[slot] && meets(detail)) (pool[slot] ??= []).push(hrid);
  }
  const isDefault = (key, hrid) => (KIND_LABELS[key] ? !unpriced?.(hrid)
    : !!start.equipment[key] && requirementKey(hrid) === requirementKey(start.equipment[key].hrid));
  // What it starts with is always tried, ticked or not (the panel lists only the alternatives): a descent may put it back.
  const startItems = new Set([...Object.values(start.equipment), ...start.food, ...start.drinks].map((x) => x?.hrid));
  return { start, best, pool, isDefault, unpriced, tried: (key, hrid) => startItems.has(hrid) || (allowed ? allowed.has(hrid) : isDefault(key, hrid)) };
}

const consumed = (hrid) => ({ hrid, triggers: (itemDetailMap[hrid].consumableDetail.defaultCombatTriggers || []).map((t) => ({ ...t })) });

/** What differs between two states, slot by slot: what Apply writes and the label reads. */
function changesBetween(from, to) {
  const piece = (p) => (p ? `${p.hrid}+${p.enhancementLevel ?? 0}` : null);
  const gear = [...new Set([...Object.keys(from.equipment), ...Object.keys(to.equipment)])]
    .filter((slot) => piece(from.equipment[slot]) !== piece(to.equipment[slot]))
    .map((slot) => ({ kind: 'gear', slot, from: from.equipment[slot]?.hrid ?? null, item: to.equipment[slot] ?? null }));
  const consumables = ['food', 'drinks'].flatMap((kind) => [0, 1, 2]
    .filter((i) => (from[kind][i]?.hrid ?? null) !== (to[kind][i]?.hrid ?? null))
    .map((i) => ({ kind, index: i, from: from[kind][i]?.hrid ?? null, item: to[kind][i] ?? null })));
  return [...gear, ...consumables];
}
const describe = (changes) => changes.map((c) =>
  `${c.kind === 'gear' ? SLOT_LABELS[c.slot] : `${KIND_LABELS[c.kind]} ${c.index + 1}`}: ${nameOf(c.from)} → ${nameOf(c.item?.hrid)}`).join(', ');
const candidate = (id, from, state) => { const changes = changesBetween(from, state); return { id, label: describe(changes), state, changes }; };

/** What one coordinate offers from `state`. */
export function candidatesAt(state, coordinate, ctx) {
  const { kind, index, slot } = parse(coordinate);
  if (kind) {
    if (index >= slotsOf(state.equipment[POUCH]?.hrid, kind)) return [];
    const used = new Set(state[kind].filter(Boolean).map((c) => c.hrid));
    return ctx.pool[kind].filter((hrid) => !used.has(hrid) && ctx.tried(kind, hrid)).map((hrid) =>
      candidate(`${coordinate}:${hrid}`, state, { ...state, [kind]: state[kind].map((c, i) => (i === index ? (ctx.start[kind].find((s) => s?.hrid === hrid) ?? consumed(hrid)) : c)) }));
  }
  if (slot === OFF && state.equipment[TWO]) return [];
  const worn = ctx.start.equipment[slot];
  return (ctx.pool[slot] || []).filter((hrid) => hrid !== state.equipment[slot]?.hrid && ctx.tried(slot, hrid)).map((hrid) => {
    // The start's own piece goes back as worn (as the consumable branch puts back the start's own triggers), not at the best owned.
    const equipment = { ...state.equipment, [slot]: worn?.hrid === hrid ? worn : { hrid, enhancementLevel: ctx.best.get(hrid) } };
    if (slot === TWO) { delete equipment[MAIN]; delete equipment[OFF]; } else if (slot === MAIN || slot === OFF) delete equipment[TWO];
    return candidate(`${coordinate}:${hrid}`, state, { ...state, equipment });
  });
}

/**
 * An upper bound on a descent, in estimateWorkload's shape: a coordinate never offers more than the tried items it can
 * take, less what candidatesAt never offers there — a consumable already slotted at the start (nothing is slotted
 * twice, and a swap never empties a slot) and the slot's own piece, unless a weapon swap can empty that slot (a
 * tried two-hander clears the main and off hand, a tried main hand clears the two-hander), when it may offer them all.
 * A consumable slot counts as open if any tried pouch opens it, and the off hand under a two-hander only if a main hand
 * (which clears the two-hander) is tried, as candidatesAt offers them.
 */
export function estimateSwapDescent(ctx, passes, scan) {
  const tried = (key) => (ctx.pool[key] || []).filter((hrid) => ctx.tried(key, hrid)).length;
  const held = (key) => (ctx.pool[key] || []).filter((hrid) => (KIND_LABELS[key]
    ? ctx.start[key].some((c) => c?.hrid === hrid) : ctx.start.equipment[key]?.hrid === hrid)).length;
  const emptied = { [MAIN]: tried(TWO) > 0, [OFF]: tried(TWO) > 0, [TWO]: tried(MAIN) > 0 };
  const pouches = [ctx.start.equipment[POUCH]?.hrid, ...(ctx.pool[POUCH] || []).filter((hrid) => ctx.tried(POUCH, hrid))];
  const offClosed = !!ctx.start.equipment[TWO] && !tried(MAIN);
  const perPass = COORDINATES.reduce((sims, coordinate) => {
    const { kind, index, slot } = parse(coordinate);
    const count = kind ? (pouches.some((p) => index < slotsOf(p, kind)) ? tried(kind) - held(kind) : 0)
      : slot === OFF && offClosed ? 0 : tried(slot) - (emptied[slot] ? 0 : held(slot));
    return count ? sims + count + 1 : sims;
  }, 0);
  return descentWorkload(perPass, passes, scan);
}

/** For the panel: each slot with something to try, what it holds now, and each owned alternative with its default tick. */
export function swapGroups(ctx) {
  const consumables = ['food', 'drinks'].map((kind) => {
    const slotted = new Set(ctx.start[kind].filter(Boolean).map((c) => c.hrid));
    return { key: kind, label: kind === 'food' ? 'Food' : 'Drinks', current: [...slotted].map(nameOf).join(', ') || 'none',
      items: ctx.pool[kind].filter((hrid) => !slotted.has(hrid)).map((hrid) => ({ hrid,
        label: ctx.unpriced?.(hrid) ? `${nameOf(hrid)} · no price` : nameOf(hrid), default: ctx.isDefault(kind, hrid) })) };
  });
  const gear = GEAR.map((slot) => {
    const now = ctx.start.equipment[slot];
    return { key: slot, label: SLOT_LABELS[slot], current: now ? `${nameOf(now.hrid)} +${now.enhancementLevel ?? 0}` : 'empty',
      items: (ctx.pool[slot] || []).filter((hrid) => hrid !== now?.hrid)
        .map((hrid) => ({ hrid, label: `${nameOf(hrid)} +${ctx.best.get(hrid)}`, default: ctx.isDefault(slot, hrid) })) };
  });
  return [...consumables, ...gear].filter((group) => group.items.length);
}

/** The descent's answer as one candidate against the start, or null when it ended there. */
export function bestSwap(ctx, state) {
  const best = candidate('best', ctx.start, state);
  return best.changes.length ? best : null;
}
