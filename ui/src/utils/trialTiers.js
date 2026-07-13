// =============================================================================
// trialTiers — display-dialect helpers for guild-trial tiers.
// -----------------------------------------------------------------------------
// The game counts trial TIERS from 0: Tier 0 = monster level 100, each
// subsequent tier is +1 tier / +10 levels, capped at Tier 20 = Lv 300.
// The engine (and every wire field: guildTrial.startTier, aggregate keys,
// summaries) speaks LEVELS (100, 110, … 300). Mechanics are verified correct —
// only the labels need translating, so these helpers are DISPLAY-ONLY:
// state and worker payloads keep storing the level value untouched.
//
// One consistent compact form is used everywhere: formatTier(130) → "T3 · Lv 130".
// =============================================================================

export const TIER_BASE_LEVEL = 100;
export const TIER_LEVEL_STEP = 10;
export const MAX_TIER_INDEX = 20; // Tier 20 = Lv 300 (the ladder cap)

/** Engine level (100..300) → game tier index (0..20). May be fractional for
 *  level-space means (e.g. expectedMaxTierCleared). */
export function levelToTierIndex(level) {
  return (Number(level) - TIER_BASE_LEVEL) / TIER_LEVEL_STEP;
}

/** Game tier index (0..20) → engine level (100..300). */
export function tierIndexToLevel(index) {
  return TIER_BASE_LEVEL + Number(index) * TIER_LEVEL_STEP;
}

/** The one canonical dual form: formatTier(130) → "T3 · Lv 130". */
export function formatTier(level) {
  return `T${Math.round(levelToTierIndex(level))} · Lv ${level}`;
}
