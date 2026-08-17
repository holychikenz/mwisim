// =============================================================================
// optimizerTarget — which fight the Triggers and Gear optimisers are pointed at
//
// Zone and Lab are simulation MODES; Triggers and Gear are modes that need to be
// told which of the two to fight. That choice is deliberately shared between the
// two optimisers rather than stored per-optimiser: a user who has just scanned
// their gear against a labyrinth room and switches to Triggers means to tune the
// triggers for that same room, and being silently returned to a zone would
// produce a recommendation for a fight they are not having.
//
// Stored under its own key rather than inside either optimiser's config, for the
// same reason — neither owns it.
// =============================================================================

/** localStorage key, following the UI's `csim_*` convention. */
export const OPT_TARGET_KEY = 'csim_optimizer_target';

export const OPT_TARGETS = ['zone', 'labyrinth'];

/** @returns {'zone'|'labyrinth'} */
export function loadOptTarget() {
  try {
    const stored = localStorage.getItem(OPT_TARGET_KEY);
    if (OPT_TARGETS.includes(stored)) return stored;
  } catch {
    /* ignore — persistence is best-effort */
  }
  return 'zone';
}

export function saveOptTarget(target) {
  try {
    if (OPT_TARGETS.includes(target)) localStorage.setItem(OPT_TARGET_KEY, target);
  } catch {
    /* ignore */
  }
}

/**
 * The `zone` / `labyrinth` half of an optimiser request body.
 *
 * Exactly one key, because the API rejects a body carrying both — guessing which
 * the user meant is precisely the quiet decision that makes a number
 * untrustworthy (api/lib/target.js).
 *
 * `crates` is sent as the array of chosen hrids, nulls filtered, exactly as the
 * ordinary labyrinth simulation sends it; `upgrades` goes inside the labyrinth
 * object rather than riding on `extra.mwixLabUpgrades`, because on this path
 * there is no maze toggle to gate them — asking for a labyrinth IS the gate.
 *
 * @param {'zone'|'labyrinth'} target
 * @param {object} args
 * @param {string} args.zone
 * @param {number} args.difficultyTier
 * @param {object} args.labConfig  { monsterHrid, roomLevel, crates, upgrades }
 * @returns {object}
 */
export function toTargetPayload(target, { zone, difficultyTier, labConfig }) {
  if (target === 'labyrinth') {
    return {
      labyrinth: {
        labyrinthHrid: labConfig.monsterHrid,
        roomLevel: labConfig.roomLevel,
        crates: Object.values(labConfig.crates || {}).filter(Boolean),
        upgrades: labConfig.upgrades || {},
      },
    };
  }
  return { zone: { zoneHrid: zone, difficultyTier } };
}
