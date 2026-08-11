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
//     Server-Sent Events. Frames are `progress`, `checkpoint`, `result`, `error`,
//     matching the shape POST /api/simulate-stream already established.
//
// Unlike /api/simulate-stream this route handles `req.on('close')`: an optimiser
// run holds a whole worker pool, and a user who navigates away must not leave a
// dozen threads saturating the machine until they finish. It also emits SSE
// heartbeat comments, because a single 72-hour candidate simulation can outlast a
// client-side stall timeout with no natural frame to send.
// =============================================================================

import { Router } from 'express';
import { buildExtraBuffs } from '../lib/simulator.js';
import { deriveBounds } from '../lib/triggerSearch/bounds.js';
import { collectSearchParams, enumerateTriggers } from '../lib/triggerSearch/params.js';
import { createSimulationPool, defaultPoolSize, MAX_WORKERS } from '../lib/triggerSearch/pool.js';
import { makePoolEvaluator } from '../lib/triggerSearch/pool.js';
import { REPORTED_METRICS, defaultObjective } from '../lib/triggerSearch/score.js';
import { DEFAULT_STAGES, STABLE_VERIFY_HOURS, estimateWorkload, optimizeTriggers } from '../lib/triggerSearch/search.js';

const router = Router();

/** Heartbeat interval. Comfortably inside a 30s client stall timeout. */
const HEARTBEAT_MS = 10_000;

/** Reject absurd stage configurations before they cost anybody an afternoon. */
const MAX_STAGE_HOURS = 1000;
const MAX_SELECTION = 24;

function validateBody(body) {
  const { players, zone } = body || {};
  if (!players || !Array.isArray(players) || players.length === 0) {
    return 'Players array is required';
  }
  if (!zone || !zone.zoneHrid) {
    return 'Zone configuration is required';
  }
  return null;
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

/**
 * Sanitise the consumable cost table: itemHrid → SECONDS of production time.
 *
 * The UI sources these from the cow webapp via buildIronPrices, which uses -1 for
 * "no value known". Dropping NEGATIVE entries here means an unknown item
 * contributes nothing rather than a negative cost, which would make eating it look
 * like a saving.
 *
 * Zero is KEPT, and the distinction is deliberate. A user can override an item's
 * cost to 0 to say "this one reaches me free — a daily, a handout, a stockpile
 * already paid for", which is a fact about their situation that no production time
 * can know. Numerically a zero costs the same as an omission, but it keeps the
 * table non-empty, and an empty table switches the objective back to raw
 * throughput and the UI back to warning that the food bill is not counted. A build
 * whose every consumable is free would otherwise be told its costs are unknown.
 */
function sanitiseConsumableCosts(input) {
  if (!input || typeof input !== 'object') return null;
  const costs = {};
  for (const [hrid, value] of Object.entries(input)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) costs[hrid] = seconds;
  }
  return Object.keys(costs).length ? costs : null;
}

/** Shared setup for both routes: bounds, enumerated triggers, resolved params. */
function prepare(body) {
  const { players, zone, extra = {}, guildBuffs = [] } = body;
  // Same composition runSimulation uses (api/lib/simulator.js:123), so a candidate
  // is scored against exactly the build a normal simulation would produce.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs);

  const bounds = deriveBounds({ playerDTOs: players, zone, extraBuffs });
  const triggers = enumerateTriggers(players);

  // No explicit selection means "sweep everything that can be swept" — the
  // sensible default, and what the preview shows before the user narrows it.
  const selection = Array.isArray(body.selection)
    ? body.selection.slice(0, MAX_SELECTION)
    : triggers
        .filter((row) => row.searchable)
        .slice(0, MAX_SELECTION)
        .map(({ playerIndex, slotKind, slotIndex, triggerIndex }) => ({
          playerIndex,
          slotKind,
          slotIndex,
          triggerIndex,
        }));

  const { params, rejected } = collectSearchParams(players, selection, bounds);
  const consumableCosts = sanitiseConsumableCosts(body.consumableCosts);

  // Default to the time-denominated objective whenever we can actually price the
  // food, because raw throughput cannot see the bill and will happily recommend
  // eating constantly for a fraction of a percent.
  const objective =
    body.objective || defaultObjective({ consumableCostsKnown: !!consumableCosts });

  return { bounds, triggers, selection, params, rejected, extraBuffs, consumableCosts, objective };
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
    const { bounds, triggers, selection, params, rejected, consumableCosts, objective } = prepare(req.body);

    return res.json({
      success: true,
      objective,
      // Lets the UI say plainly whether the food bill is being counted, and warn
      // when it is not — that is the difference between a trustworthy consumable
      // recommendation and one biased toward eating constantly.
      consumableCostsKnown: !!consumableCosts,
      pricedConsumables: consumableCosts ? Object.keys(consumableCosts) : [],
      reportedMetrics: REPORTED_METRICS,
      bounds,
      triggers,
      selection,
      params,
      rejected,
      stages,
      workload: estimateWorkload(params, stages),
      poolSize: Math.min(MAX_WORKERS, Math.max(1, Math.floor(Number(req.body.workers)) || defaultPoolSize())),
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // SSE comments are ignored by EventSource and by a manual reader that skips
  // non-`data:` lines, but they keep the socket and any client stall timer alive
  // across a long candidate simulation.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  const controller = new AbortController();
  let pool = null;

  // The client vanishing is a normal way a long run ends. Without this the pool
  // keeps every worker busy to completion for a result nobody will read.
  //
  // NOTE: this listens on `res`, not `req`. Node emits `req`'s 'close' when the
  // REQUEST has been fully received — i.e. on every normal request, the moment the
  // body finishes uploading — so `req.on('close')` aborts the run immediately
  // rather than on disconnect. `res`'s 'close' fires when the response finishes or
  // the socket dies, and `writableFinished` distinguishes the two.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const poolSize = Math.min(
      MAX_WORKERS,
      Math.max(1, Math.floor(Number(req.body.workers)) || defaultPoolSize())
    );
    pool = await createSimulationPool({ size: poolSize });

    send({
      type: 'start',
      poolSize,
      stages,
      objective: prepared.objective,
      consumableCostsKnown: !!prepared.consumableCosts,
      params: prepared.params,
      rejected: prepared.rejected,
      workload: estimateWorkload(prepared.params, stages),
    });

    const evaluate = makePoolEvaluator({
      pool,
      zoneConfig: req.body.zone,
      extraBuffs: prepared.extraBuffs,
      consumableCosts: prepared.consumableCosts,
      signal: controller.signal,
    });

    const result = await optimizeTriggers({
      playerDTOs: req.body.players,
      params: prepared.params,
      evaluate,
      objective: prepared.objective,
      stages,
      seedBase: Number(req.body.seedBase) || undefined,
      epsilons: req.body.epsilons || {},
      resumeCheckpoint: req.body.resumeCheckpoint || null,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'progress', ...progress }),
      // Forwarded so a client can resume an interrupted run by posting the last
      // checkpoint back in `resumeCheckpoint`.
      onCheckpoint: (checkpoint) => send({ type: 'checkpoint', checkpoint }),
    });

    // Merged rather than returned by search.js, which is deliberately ignorant of
    // pricing — it takes an objective name and an evaluator, nothing more.
    send({
      type: 'result',
      result: {
        ...result,
        consumableCostsKnown: !!prepared.consumableCosts,
        pricedConsumables: prepared.consumableCosts ? Object.keys(prepared.consumableCosts) : [],
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      send({ type: 'cancelled', error: error.message });
    } else {
      send({ type: 'error', error: error.message });
    }
  } finally {
    clearInterval(heartbeat);
    await pool?.destroy();
    if (!res.writableEnded) res.end();
  }
});

export default router;
