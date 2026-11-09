// =============================================================================
// optimizerTarget — the header's target and tool, and which fight the
// optimisers are pointed at
//
// App holds two pieces of state: `simMode` (zone | labyrinth | guildTrial |
// a TOOLS value | itemCosts) and `optTarget` (zone | labyrinth, read only
// while an optimiser is the mode). The header shows them as a TARGET
// (Zone · Lab · Trial) over a row of tools (Simulate | the TOOLS);
// toRoute and fromRoute translate between the two, so none of App's
// `simMode === …` checks has to change.
//
// The target is shared by the optimisers rather than held per optimiser: a user
// who has just scanned their gear against a labyrinth room and switches to
// Triggers means to tune the triggers for that same room.
//
// Not persisted. simMode never was, and every way into an optimiser sets
// optTarget from the header, so a remembered one would never be read.
// =============================================================================

export const OPT_TARGETS = ['zone', 'labyrinth'];

/** The header's target segment. Each value is also the simMode that simulates it. */
export const TARGETS = [
  { value: 'zone', label: 'Zone' },
  { value: 'labyrinth', label: 'Lab' },
  { value: 'guildTrial', label: 'Trial' },
];

/**
 * The tool tabs after Simulate. `value` is the tool's simMode in App; `targets`
 * are the ones it can fight, a subset of OPT_TARGETS (all optTarget can hold).
 * Adding an optimiser to the header is one entry here.
 */
export const TOOLS = [
  { value: 'triggerOpt', label: 'Triggers', targets: OPT_TARGETS },
  { value: 'equipOpt', label: 'Gear', targets: OPT_TARGETS },
];

/** Is this simMode one of the TOOLS? Mode-generic code asks this rather than naming tools. */
export const isTool = (simMode) => TOOLS.some(t => t.value === simMode);

const isTarget = (target) => TARGETS.some(t => t.value === target);

/** Can this tool run against this target? Simulate runs every target. */
export function supports(tool, target) {
  if (tool === 'simulate') return isTarget(target);
  return !!TOOLS.find(t => t.value === tool)?.targets.includes(target);
}

/**
 * What the header shows for App's state. Costs is a view rather than a place,
 * so it selects neither target nor tool. Anything unrecognised reads as
 * Zone · Simulate; never throws.
 *
 * @returns {{target: string|null, tool: string|null, costs: boolean}}
 */
export function toRoute(simMode, optTarget) {
  if (simMode === 'itemCosts') return { target: null, tool: null, costs: true };
  if (isTool(simMode)) {
    return { target: OPT_TARGETS.includes(optTarget) ? optTarget : 'zone', tool: simMode, costs: false };
  }
  return { target: isTarget(simMode) ? simMode : 'zone', tool: 'simulate', costs: false };
}

/**
 * The App state a header pick leads to. An optimiser stays open when the new
 * target suits it, re-aimed there; otherwise the pick lands on Simulate.
 * optTarget changes only when an optimiser is chosen. Never throws.
 *
 * @returns {{simMode: string, optTarget: 'zone'|'labyrinth'}}
 */
export function fromRoute(target, tool, optTarget) {
  const t = isTarget(target) ? target : 'zone';
  if (tool !== 'simulate' && supports(tool, t)) return { simMode: tool, optTarget: t };
  return { simMode: t, optTarget: OPT_TARGETS.includes(optTarget) ? optTarget : 'zone' };
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
