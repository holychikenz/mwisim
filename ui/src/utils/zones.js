// =============================================================================
// zones — which combat actions are ZONES, and what difficulty tiers they offer
//
// `actionDetailMap` files 59 combat actions under one type. They are not one
// kind of thing:
//
//   solo actions   maxSpawnCount === 1 — "Fly", "Jerry", "Granite Golem". One
//                  named monster, fought alone. The game exposes these as the
//                  single-monster entries INSIDE a planet, not as places you
//                  can send a character to grind.
//   planets        maxSpawnCount > 1 — "Smelly Planet", "Golem Cave". A random
//                  spawn table plus a boss every tenth encounter: the thing a
//                  player actually chooses.
//   dungeons       isDungeon — fixed waves, its own reward table.
//
// The simulator only offers the last two. Solo actions are still in the data
// (the engine spawns them; the drops tab names them), they are simply not
// destinations, and a dropdown that mixes 44 monsters into 15 places is a
// dropdown nobody can find anything in.
//
// TIERS. `action.maxDifficulty` is the game's own ceiling — 5 for every planet,
// 2 for every dungeon — and it is what the upstream webpack UI enforces too
// (its difficulty select offers T0–T5 and disables T3+ when the dungeon toggle
// is on). Nothing above it exists in the game, so nothing above it is offered.
// =============================================================================

/** Fallback tier ceiling for a zone whose data carries no `maxDifficulty`. */
export const FALLBACK_MAX_TIER = 5;

/**
 * The zone a fresh session starts on: the lowest planet, mirroring the game's
 * own first combat destination. Previously '/actions/combat/fly' — a solo
 * action, and so no longer selectable.
 */
export const DEFAULT_ZONE_HRID = '/actions/combat/smelly_planet';

/** A place you can send a character: a planet or a dungeon, never a lone monster. */
export function isSimulableZone(zone) {
  if (!zone) return false;
  return !!zone.isDungeon || (Number(zone.maxSpawnCount) || 0) > 1;
}

/** The simulable zones, in the game's own order (sortIndex, set by useGameData). */
export function simulableZones(zones) {
  return (zones || []).filter(isSimulableZone);
}

export function findZone(zones, hrid) {
  return (zones || []).find(z => z.hrid === hrid) || null;
}

/** Highest difficulty tier this zone offers (5 for planets, 2 for dungeons). */
export function maxTierFor(zone) {
  const max = Number(zone?.maxDifficulty);
  return Number.isFinite(max) && max >= 0 ? max : FALLBACK_MAX_TIER;
}

/** [0, 1, … maxDifficulty] — the tier column set for one zone. */
export function zoneTiers(zone) {
  return Array.from({ length: maxTierFor(zone) + 1 }, (_, i) => i);
}

/** The widest tier ceiling across a zone list — the grid's column count. */
export function maxTierAcross(zones) {
  return simulableZones(zones).reduce(
    (max, zone) => Math.max(max, maxTierFor(zone)),
    0
  ) || FALLBACK_MAX_TIER;
}

/**
 * Coerce any stored, imported or bridged zone hrid to one this UI can select.
 *
 * Sessions saved before solo actions were dropped — and MWIX bridge payloads
 * from a character standing on "Fly" — still name them. Rather than leaving the
 * select blank, we promote a solo action to the PLANET IT BELONGS TO: both share
 * an action category ('/action_categories/combat/smelly_planet'), so "Fly"
 * becomes "Smelly Planet", which is where that fight happens anyway.
 *
 * An unrecognised hrid falls back to the default zone. An empty zone list means
 * game data has not loaded yet — the value is returned untouched rather than
 * rewritten from an empty world.
 */
export function resolveZoneHrid(zones, hrid) {
  const list = simulableZones(zones);
  if (list.length === 0) return hrid || DEFAULT_ZONE_HRID;
  if (list.some(z => z.hrid === hrid)) return hrid;

  const solo = findZone(zones, hrid);
  if (solo?.category) {
    const parent = list.find(z => z.category === solo.category);
    if (parent) return parent.hrid;
  }

  return list.find(z => z.hrid === DEFAULT_ZONE_HRID)?.hrid || list[0].hrid;
}

/** Clamp a tier to what the zone actually offers (T7 on a dungeon is not a thing). */
export function clampTier(zones, hrid, tier) {
  const value = Math.max(0, Math.round(Number(tier) || 0));
  const zone = findZone(zones, hrid);
  if (!zone) return value;
  return Math.min(value, maxTierFor(zone));
}
