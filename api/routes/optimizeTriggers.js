// =============================================================================
// optimizeTriggers — HTTP surface for the trigger threshold optimiser
//
// Two routes:
//
//   POST /api/optimize-triggers/preview
//     Cheap and synchronous. Enumerates every trigger on the submitted players,
//     says which values can be swept and why the rest cannot, derives the search
//     bounds, and estimates the simulation count. The UI calls this on every
//     configuration change so the user sees the bill before committing to a run
//     whose verification stage alone is 72 simulated hours per finalist.
//
//   POST /api/optimize-triggers
//     Server-Sent Events. Frames are `start`, `progress`, `result`, `error`, `cancelled`.
//
// The run aborts when the client disconnects (api/lib/optimizerRoute.js): an
// optimiser run holds a whole worker pool, and a user who navigates away must not leave a
// dozen threads saturating the machine until they finish. It also emits SSE
// heartbeat comments, because a single 72-hour candidate simulation can outlast a
// client-side stall timeout with no natural frame to send.
// =============================================================================

import { Router } from 'express';
import { buildExtraBuffs } from '../lib/simulator.js';
import { objectiveError, poolSizeFor, sanitiseConsumableCosts, streamPoolRun } from '../lib/optimizerRoute.js';
import { markDungeon, normaliseTarget, targetExtraBuffs, targetPlayerDTOs } from '../lib/target.js';
import { deriveBounds } from '../lib/triggerSearch/bounds.js';
import { collectSearchParams, enumerateTriggers } from '../lib/triggerSearch/params.js';
import { makePoolEvaluator } from '../lib/triggerSearch/pool.js';
import { defaultObjective, reportedMetricsFor } from '../lib/triggerSearch/score.js';
import { DEFAULT_STAGES, STABLE_VERIFY_HOURS, estimateWorkload, optimizeTriggers } from '../lib/triggerSearch/search.js';

const router = Router();

/** Reject absurd stage configurations before they cost anybody an afternoon. */
const MAX_STAGE_HOURS = 1000;
const MAX_SELECTION = 24;

function validateBody(body) {
  const { players } = body || {};
  if (!players || !Array.isArray(players) || players.length === 0) {
    return 'Players array is required';
  }
  // `zone` XOR `labyrinth`, resolved and validated in one place so this route,
  // the equipment route and the bounds derivation cannot disagree about what
  // was asked for. See api/lib/target.js.
  return objectiveError(body) || normaliseTarget(body).error;
}

/**
 * Clamp the caller's stage overrides. The UI offers these as inputs, so they are
 * user data, not trusted configuration.
 */
function sanitiseStages(input = {}, { stableMode = false } = {}) {
  const hours = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(MAX_STAGE_HOURS, number);
  };
  const count = (value, fallback, max) => {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(max, number);
  };

  return {
    calibration: {
      repeats: Math.min(20, Math.max(0, Math.floor(Number(input.calibration?.repeats ?? DEFAULT_STAGES.calibration.repeats)) || 0)),
    },
    initial: {
      hours: hours(input.initial?.hours, DEFAULT_STAGES.initial.hours),
      keepPerParam: count(input.initial?.keepPerParam, DEFAULT_STAGES.initial.keepPerParam, 10),
    },
    coarse: {
      hours: hours(input.coarse?.hours, DEFAULT_STAGES.coarse.hours),
      beamWidth: count(input.coarse?.beamWidth, DEFAULT_STAGES.coarse.beamWidth, 32),
    },
    fine: {
      hours: hours(input.fine?.hours, DEFAULT_STAGES.fine.hours),
      keep: count(input.fine?.keep, DEFAULT_STAGES.fine.keep, 20),
    },
    verify: {
      hours: hours(
        input.verify?.hours,
        stableMode ? STABLE_VERIFY_HOURS : DEFAULT_STAGES.verify.hours
      ),
    },
  };
}

/** A row named twice would be swept as two parameters fighting over one value. */
function uniqueSelection(selection) {
  const seen = new Set();
  return selection.filter((row) => {
    const key = `${row?.playerIndex}|${row?.slotKind}|${row?.slotIndex}|${row?.triggerIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Shared setup for both routes: bounds, enumerated triggers, resolved params. */
function prepare(body) {
  const { players, extra = {}, guildBuffs = [] } = body;
  // A dungeon is a zone whose objective is completed runs, not waves, so the
  // flag rides on the target and is echoed back for the UI to label by.
  const target = markDungeon(normaliseTarget(body));
  const labyrinth = target.kind === 'labyrinth';
  const dungeon = !!target.dungeon;

  // Same composition runSimulation uses (api/lib/simulator.js:123), so a candidate
  // is scored against exactly the build a normal simulation would produce — plus,
  // in a labyrinth, the lab-shop combat upgrades, which are character upgrades
  // and apply only in there.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs).concat(targetExtraBuffs(target));

  // The DTOs actually simulated: in a labyrinth, food and drinks are blanked,
  // because the game confiscates them at the door. Note the enumeration below
  // reads the ORIGINAL players — a stripped set would have nothing to explain.
  const simPlayers = targetPlayerDTOs(players, target);

  const bounds = deriveBounds({ playerDTOs: simPlayers, target, extraBuffs });
  const triggers = enumerateTriggers(players, { labyrinth });

  // No explicit selection means "sweep everything that can be swept" — the
  // sensible default, and what the preview shows before the user narrows it.
  const selection = Array.isArray(body.selection)
    ? uniqueSelection(body.selection).slice(0, MAX_SELECTION)
    : triggers
        .filter((row) => row.searchable)
        .slice(0, MAX_SELECTION)
        .map(({ playerIndex, slotKind, slotIndex, triggerIndex }) => ({
          playerIndex,
          slotKind,
          slotIndex,
          triggerIndex,
        }));

  // Resolved against the SIMULATED DTOs, so a stale selection naming a food slot
  // is rejected by address rather than silently sweeping a value the engine will
  // never read.
  const { params, rejected } = collectSearchParams(simPlayers, selection, bounds, { labyrinth });
  const consumableCosts = labyrinth ? null : sanitiseConsumableCosts(body.consumableCosts);

  // Default to the time-denominated objective whenever we can actually price the
  // food, because raw throughput cannot see the bill and will happily recommend
  // eating constantly for a fraction of a percent. In a labyrinth there is
  // nothing to eat and nothing to price, so the objective is the completion
  // chance instead — see score.js defaultObjective.
  const objective =
    body.objective || defaultObjective({ consumableCostsKnown: !!consumableCosts, labyrinth, dungeon });

  return {
    target,
    simPlayers,
    bounds,
    triggers,
    selection,
    params,
    rejected,
    extraBuffs,
    consumableCosts,
    objective,
  };
}

/**
 * POST /api/optimize-triggers/preview
 * What can be searched, over what range, and what it will cost.
 */
router.post('/optimize-triggers/preview', (req, res) => {
  try {
    const invalid = validateBody(req.body);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const stages = sanitiseStages(req.body.stages, { stableMode: !!req.body.stableMode });
    const { target, bounds, triggers, selection, params, rejected, consumableCosts, objective } =
      prepare(req.body);

    return res.json({
      success: true,
      objective,
      // Echoed back clamped and validated, so the panel can show the room level
      // and crates actually in force rather than the ones it hoped it sent.
      target,
      reportedMetrics: reportedMetricsFor(target),
      // Lets the UI say plainly whether the food bill is being counted, and warn
      // when it is not — that is the difference between a trustworthy consumable
      // recommendation and one biased toward eating constantly.
      consumableCostsKnown: !!consumableCosts,
      pricedConsumables: consumableCosts ? Object.keys(consumableCosts) : [],
      bounds,
      triggers,
      selection,
      params,
      rejected,
      stages,
      workload: estimateWorkload(params, stages),
      poolSize: poolSizeFor(req.body.workers),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/optimize-triggers
 * Run the search, streaming progress over SSE.
 */
router.post('/optimize-triggers', async (req, res) => {
  const invalid = validateBody(req.body);
  if (invalid) return res.status(400).json({ success: false, error: invalid });

  let prepared;
  let stages;
  try {
    stages = sanitiseStages(req.body.stages, { stableMode: !!req.body.stableMode });
    prepared = prepare(req.body);
  } catch (error) {
    // Still safe to answer with JSON — nothing has been flushed yet.
    return res.status(400).json({ success: false, error: error.message });
  }

  if (prepared.params.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No searchable trigger values in the selection',
      rejected: prepared.rejected,
    });
  }

  await streamPoolRun(req, res, async ({ pool, poolSize, send, signal }) => {
    send({
      type: 'start',
      poolSize,
      stages,
      objective: prepared.objective,
      target: prepared.target,
      reportedMetrics: reportedMetricsFor(prepared.target),
      consumableCostsKnown: !!prepared.consumableCosts,
      params: prepared.params,
      rejected: prepared.rejected,
      workload: estimateWorkload(prepared.params, stages),
    });

    const evaluate = makePoolEvaluator({
      pool,
      zoneConfig: prepared.target.zone,
      labyrinthConfig: prepared.target.labyrinth,
      extraBuffs: prepared.extraBuffs,
      consumableCosts: prepared.consumableCosts,
      signal,
    });

    const result = await optimizeTriggers({
      // The stripped set when the target is a labyrinth: the search must sweep
      // the build the game would actually let the player field.
      playerDTOs: prepared.simPlayers,
      params: prepared.params,
      evaluate,
      objective: prepared.objective,
      stages,
      seedBase: Number(req.body.seedBase) || undefined,
      epsilons: req.body.epsilons || {},
      signal,
      onProgress: (progress) => send({ type: 'progress', ...progress }),
    });

    // Merged rather than returned by search.js, which is deliberately ignorant of
    // pricing — it takes an objective name and an evaluator, nothing more.
    send({
      type: 'result',
      result: {
        ...result,
        target: prepared.target,
        reportedMetrics: reportedMetricsFor(prepared.target),
        consumableCostsKnown: !!prepared.consumableCosts,
        pricedConsumables: prepared.consumableCosts ? Object.keys(prepared.consumableCosts) : [],
      },
    });
  });
});

export default router;
