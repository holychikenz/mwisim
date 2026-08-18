// =============================================================================
// allZones — the sweep's vocabulary: combinations, run summaries, persistence
//
// One "combo" is a (zone, difficulty tier) pair — the unit of work the sweep
// fans out across web workers. A full sweep is every planet at T0–T5 and every
// dungeon at T0–T2: 78 simulations, which is why it is a pool and not a loop.
//
// WORKER-SAFE ON PURPOSE. workers/allZonesWorker.js imports summariseZoneRun
// from here, so this module must import nothing — in particular nothing that
// drags the price maps (utils/prices.js pulls openableLootDropMap.json) into the
// worker bundle. The effective-rate arithmetic, which does need pricing, lives
// with the view that renders it (components/AllZonesResults.jsx).
// =============================================================================

const ONE_HOUR_NS = 60 * 60 * 1e9;

/** localStorage key, following the UI's `csim_*` convention. */
export const ALL_ZONES_KEY = 'csim_all_zones';

/**
 * Hours of combat simulated per combination.
 *
 * 24 rather than the header's 100: a sweep multiplies its duration by ~78, and
 * a day of simulated combat is already several thousand encounters on any zone
 * a build can clear — comfortably past the point where the Monte-Carlo noise on
 * a rate matters for ranking. Raise it when comparing two zones that finish
 * within a percent of each other.
 */
export const DEFAULT_SWEEP_HOURS = 24;

/** Stable key for a combination — also the React key and the selection member. */
export function comboKey(zoneHrid, difficultyTier) {
  return `${zoneHrid}#${difficultyTier}`;
}

/** Inverse of comboKey. Splits on the LAST '#', so an hrid may contain one. */
export function parseComboKey(key) {
  const at = String(key).lastIndexOf('#');
  if (at < 0) return { zoneHrid: String(key), difficultyTier: 0 };
  return {
    zoneHrid: String(key).slice(0, at),
    difficultyTier: Number(String(key).slice(at + 1)) || 0,
  };
}

/**
 * Everything a sweep row needs, and nothing else.
 *
 * A full simResult carries per-ability attack tallies, drop tables and (when
 * enabled) HP/MP time series — tens of kilobytes each, seventy-eight of them,
 * all structured-cloned across a worker boundary to render a handful of
 * numbers. This runs INSIDE the shard, so only that handful makes the crossing.
 *
 * PER PLAYER, NOT SUMMED. Experience and deaths cross as maps keyed by player
 * hrid rather than as party totals: a party does not share a levelling curve,
 * and adding one member's experience to another's ranks zones for a composite
 * character nobody plays. Five small numbers instead of one is a rounding error
 * next to a simResult, and it lets the view answer for whichever player the left
 * panel has selected without re-running the sweep.
 *
 * consumablesUsed survives whole — already keyed by player — because it is small
 * and because the effective rates are computed later, in the view, from whatever
 * pricing is loaded then: a sweep run before the iron prices arrive should gain
 * its effective column when they do, not stay blank because the shard could not
 * price it.
 */
export function summariseZoneRun(simResult, combo = {}) {
  const hours = (simResult?.simulatedTime || 0) / ONE_HOUR_NS;

  // One total per player, summed over that player's SKILLS by iteration rather
  // than by naming the seven known ones, so a skill added by a future patch
  // counts itself. `experienceGained` is players-only (addExperienceGain returns
  // early for monsters), so every key here is a party member.
  const experienceByPlayer = {};
  for (const [hrid, bySkill] of Object.entries(simResult?.experienceGained || {})) {
    let total = 0;
    for (const amount of Object.values(bySkill || {})) {
      total += Number(amount) || 0;
    }
    experienceByPlayer[hrid] = total;
  }

  // `deaths` is keyed by unit hrid — players AND monsters. Only the party's own
  // deaths belong in a survivability column, and only one member's at a time.
  const deathsByPlayer = {};
  for (const [hrid, count] of Object.entries(simResult?.deaths || {})) {
    if (String(hrid).startsWith('player')) deathsByPlayer[hrid] = Number(count) || 0;
  }

  return {
    zoneHrid: combo.zoneHrid ?? simResult?.zoneName ?? '',
    difficultyTier: combo.difficultyTier ?? simResult?.difficultyTier ?? 0,
    hours,
    encounters: simResult?.encounters || 0,
    experienceByPlayer,
    deathsByPlayer,
    consumablesUsed: simResult?.consumablesUsed || {},
    isDungeon: !!simResult?.isDungeon,
    dungeonsCompleted: simResult?.dungeonsCompleted || 0,
    dungeonsFailed: simResult?.dungeonsFailed || 0,
    maxWaveReached: simResult?.maxWaveReached || 0,
    numberOfPlayers: simResult?.numberOfPlayers || 1,
  };
}

/**
 * Very rough wall-clock estimate, in seconds — the same crude arithmetic, and
 * the same measured constant, as the trigger optimiser's estimateSeconds. It
 * exists so a user can tell "a minute" from "an hour" before committing to 78
 * simulations, not to be right to the second.
 */
export function estimateSweepSeconds(comboCount, hours, workerCount = 4) {
  const runs = Math.max(0, Number(comboCount) || 0);
  const each = Math.max(0, Number(hours) || 0);
  if (runs === 0 || each === 0) return 0;
  const HOURS_PER_SECOND_PER_WORKER = 3;
  return (runs * each) / (HOURS_PER_SECOND_PER_WORKER * Math.max(1, workerCount));
}

/** Default pool size: every core but one, so the tab stays answerable. */
export function defaultWorkerCount() {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  return Math.max(1, cores - 1);
}

export function loadAllZonesState() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALL_ZONES_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return {
      // null selection means "not chosen yet" — App then selects everything,
      // which is what a button called "All Zones" ought to start as. An empty
      // ARRAY is a deliberate clearing and is preserved as such.
      selection: Array.isArray(raw.selection) ? raw.selection : null,
      hours: Number(raw.hours) > 0 ? Number(raw.hours) : DEFAULT_SWEEP_HOURS,
      workers: Number(raw.workers) > 0 ? Math.round(Number(raw.workers)) : null,
    };
  } catch {
    return null;
  }
}

export function saveAllZonesState(state) {
  try {
    localStorage.setItem(ALL_ZONES_KEY, JSON.stringify(state));
  } catch {
    // Quota or private browsing — the session still works, it just will not persist.
  }
}
