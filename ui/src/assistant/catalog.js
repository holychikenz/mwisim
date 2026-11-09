// =============================================================================
// catalog — name → entity indexes over gameData, so the model can say
// "Cheese Sword" or "Bear With It" and never has to know an hrid.
//
// The food/drink/aura/ability filters are the same as useGameData's
// getFood / getDrinks / getAuras / getCombatAbilities (a test keeps them equal);
// they are repeated here because that module imports React.
// Pure: no React, no browser globals.
// =============================================================================
import { simulableZones } from '../utils/zones.js';

/** The 14 slots PlayerConfig's paper doll offers, in its order. */
export const SLOTS = [
  'head', 'body', 'legs', 'feet', 'hands', 'main_hand', 'two_hand', 'off_hand',
  'pouch', 'back', 'neck', 'earrings', 'ring', 'charm',
];

export const SKILLS = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];

const bySort = (a, b) => (a.sortIndex || 0) - (b.sortIndex || 0);
const entry = (x, extra) => ({ hrid: x.hrid, name: x.name || x.hrid, ...extra });
const combatConsumable = (kind) => (item) =>
  item.consumableDetail?.usableInActionTypeMap?.['/action_types/combat'] && item.categoryHrid?.includes(kind);

const cache = new WeakMap();

export function catalog(gameData) {
  if (cache.has(gameData)) return cache.get(gameData);
  const items = Object.values(gameData?.items || {});
  const abilities = Object.values(gameData?.abilities || {}).sort(bySort);
  const equipment = items
    .filter(i => i.equipmentDetail?.type)
    .map(i => entry(i, { slot: i.equipmentDetail.type.split('/').pop() }));
  const c = {
    equipment,
    gear: equipment.filter(e => SLOTS.includes(e.slot)),
    food: items.filter(combatConsumable('food')).map(i => entry(i)),
    drinks: items.filter(combatConsumable('drink')).map(i => entry(i)),
    auras: abilities.filter(a => a.isSpecialAbility).map(a => entry(a)),
    abilities: abilities.filter(a => !a.isSpecialAbility).map(a => entry(a)),
    zones: simulableZones(gameData?.zones).map(z => entry(z, { isDungeon: !!z.isDungeon })),
    labMonsters: Object.values(gameData?.monsters || {}).filter(m => m.isLabyrinthMonster).sort(bySort).map(m => entry(m)),
    trials: (gameData?.guildTrials || []).map(t => entry(t)),
  };
  cache.set(gameData, c);
  return c;
}

const words = (s) => String(s).toLowerCase().split(/[^a-z0-9★']+/).filter(Boolean);

/**
 * Find one entity by what a model typed. In order: the exact hrid; the exact
 * name, ignoring case (and _ for spaces); the one entity whose name contains
 * every typed word. Otherwise an error naming the candidates or near misses.
 * @returns {{item: object}|{error: string}}
 */
export function resolveName(list, input, what) {
  const raw = String(input ?? '').trim();
  const byHrid = list.find(e => e.hrid === raw);
  if (byHrid) return { item: byHrid };
  const plain = raw.toLowerCase().replace(/_/g, ' ');
  const exact = list.find(e => e.name.toLowerCase() === plain);
  if (exact) return { item: exact };
  const want = words(plain.split('/').pop());
  const hits = want.length ? list.filter(e => { const w = words(e.name); return want.every(x => w.includes(x)); }) : [];
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) {
    const more = hits.length > 5 ? `, … ${hits.length - 5} more` : '';
    return { error: `Several ${what}s match '${raw}': ${hits.slice(0, 5).map(e => e.name).join(', ')}${more}. Use the full name.` };
  }
  const near = list.filter(e => words(e.name).some(w => want.some(x => x === w || (x.length >= 4 && w.startsWith(x.slice(0, 4))))));
  const close = near.length ? ` Close: ${near.slice(0, 5).map(e => e.name).join(', ')}.` : '';
  return { error: `Unknown ${what} '${raw}'.${close}` };
}
