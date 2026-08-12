// =============================================================================
// optimizeEquipment — HTTP surface for the equipment enhancement scan
//
// Sibling of optimizeTriggers.js and deliberately shaped like it: a cheap
// synchronous preview so the user sees the bill first, and an SSE run so a job
// measured in thousands of simulated hours can report progress and be cancelled
// by closing the socket. The worker pool, the seeded RNG, the scoring and the
// consumable-cost handling are all the trigger optimiser's, imported rather than
// copied — none of that machinery ever knew what a trigger was.
//
// The one thing that differs in kind: this route does not narrow. A search
// returns a winner; this returns the whole table, because "which slot is worth
// the next level" is a question about every slot at once.
// =============================================================================

import { Router } from 'express';
import { isKnownCost } from '../../shared/consumableCost.js';
import { buildExtraBuffs } from '../lib/simulator.js';
import { createSimulationPool, defaultPoolSize, makePoolEvaluator, MAX_WORKERS } from '../lib/triggerSearch/pool.js';
import { REPORTED_METRICS, defaultObjective } from '../lib/triggerSearch/score.js';
import {
  DEFAULT_STEP,
  MAX_ENHANCEMENT_LEVEL,
  applyEnhancement,
  enumerateEquipment,
} from '../lib/equipmentScan/candidates.js';
import { DEFAULT_SCAN, DEFAULT_SEED_BASE, estimateWorkload, scanEquipment } from '../lib/equipmentScan/scan.js';

const router = Router();

/** Heartbeat interval. Comfortably inside the client's stall timeout. */
const HEARTBEAT_MS = 10_000;

/** Guard rails on user-supplied configuration. */
const MAX_HOURS = 1000;
const MAX_REPLICATES = 40;
const MAX_CANDIDATES = 40;

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
 * Clamp the scan configuration. These arrive from NumberInputs, so they are user
 * data rather than trusted settings.
 */
function sanitiseScan(input = {}) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(max, parsed);
  };
  const integer = (value, fallback, min, max) => {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(max, parsed);
  };

  return {
    hours: number(input.hours, DEFAULT_SCAN.hours, 0.1, MAX_HOURS),
    // Two replicates is the floor for any error bar at all; one would report a
    // difference with no way to say whether it was real.
    replicates: integer(input.replicates, DEFAULT_SCAN.replicates, 2, MAX_REPLICATES),
    // A step of at least one, and never past the cap — an over-cap level yields
    // an undefined multiplier and silently NaN stats.
    step: integer(input.step, DEFAULT_STEP, 1, MAX_ENHANCEMENT_LEVEL),
    alpha: number(input.alpha, DEFAULT_SCAN.alpha, 0.0001, 0.5),
  };
}

/**
 * Sanitise the consumable cost table: itemHrid -> SECONDS of production time.
 *
 * Identical rule to optimizeTriggers.js, and for the same reason: -1 means "no
 * value known" and must be dropped, while an explicit 0 is a claim about the
 * player's situation ("this reaches me free") and must survive, because an empty
 * table flips the objective back to raw throughput.
 */
function sanitiseConsumableCosts(input) {
  if (!input || typeof input !== 'object') return null;
  const costs = {};
  for (const [hrid, value] of Object.entries(input)) {
    if (isKnownCost(value)) costs[hrid] = Number(value);
  }
  return Object.keys(costs).length ? costs : null;
}

/** Shared setup for both routes. */
function prepare(body) {
  const { players, zone, extra = {}, guildBuffs = [] } = body;
  const scan = sanitiseScan(body.scan);

  // Same composition runSimulation uses, so a candidate is scored against exactly
  // the build a normal simulation would produce.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs);

  const equipment = enumerateEquipment(players, { step: scan.step });

  // An explicit selection is a list of row ids ("0:/equipment_types/head").
  // Absent, everything scannable is scanned, which is the sensible default and
  // what the preview shows.
  const requested = Array.isArray(body.selection) ? new Set(body.selection.map(String)) : null;
  const candidates = equipment
    .filter((row) => row.scannable && (!requested || requested.has(row.id)))
    .slice(0, MAX_CANDIDATES);

  const skipped = equipment.filter((row) => !row.scannable);
  const consumableCosts = sanitiseConsumableCosts(body.consumableCosts);

  // Default to the time-denominated objective whenever the food can be priced.
  // Raw throughput cannot see the consumable bill, and an enhancement that lets
  // the build eat less would go unrewarded by it.
  const objective =
    body.objective || defaultObjective({ consumableCostsKnown: !!consumableCosts });

  return { scan, equipment, candidates, skipped, extraBuffs, consumableCosts, objective, zone };
}

/**
 * POST /api/optimize-equipment/preview
 * Which slots can be probed, which cannot and why, and what it will cost.
 */
router.post('/optimize-equipment/preview', (req, res) => {
  try {
    const invalid = validateBody(req.body);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const { scan, equipment, candidates, skipped, consumableCosts, objective } = prepare(req.body);

    return res.json({
      success: true,
      objective,
      consumableCostsKnown: !!consumableCosts,
      pricedConsumables: consumableCosts ? Object.keys(consumableCosts) : [],
      reportedMetrics: REPORTED_METRICS,
      maxEnhancementLevel: MAX_ENHANCEMENT_LEVEL,
      equipment,
      candidates,
      skipped,
      scan,
      workload: estimateWorkload(candidates.length, scan),
      poolSize: Math.min(MAX_WORKERS, Math.max(1, Math.floor(Number(req.body.workers)) || defaultPoolSize())),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/optimize-equipment
 * Run the scan, streaming progress over SSE.
 */
router.post('/optimize-equipment', async (req, res) => {
  const invalid = validateBody(req.body);
  if (invalid) return res.status(400).json({ success: false, error: invalid });

  let prepared;
  try {
    prepared = prepare(req.body);
  } catch (error) {
    // Nothing flushed yet, so JSON is still available.
    return res.status(400).json({ success: false, error: error.message });
  }

  if (prepared.candidates.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No equipment in the selection can be enhanced further',
      skipped: prepared.skipped,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  const controller = new AbortController();
  let pool = null;

  // On `res`, not `req`: req's 'close' fires once the request body has finished
  // uploading, i.e. on every normal request. See optimizeTriggers.js.
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
      scan: prepared.scan,
      objective: prepared.objective,
      consumableCostsKnown: !!prepared.consumableCosts,
      candidates: prepared.candidates,
      skipped: prepared.skipped,
      workload: estimateWorkload(prepared.candidates.length, prepared.scan),
    });

    const evaluate = makePoolEvaluator({
      pool,
      zoneConfig: prepared.zone,
      extraBuffs: prepared.extraBuffs,
      consumableCosts: prepared.consumableCosts,
      signal: controller.signal,
      cancelMessage: 'Equipment scan cancelled',
    });

    const result = await scanEquipment({
      playerDTOs: req.body.players,
      candidates: prepared.candidates,
      evaluate,
      applyCandidate: applyEnhancement,
      objective: prepared.objective,
      hours: prepared.scan.hours,
      replicates: prepared.scan.replicates,
      alpha: prepared.scan.alpha,
      seedBase: Number(req.body.seedBase) || DEFAULT_SEED_BASE,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'progress', ...progress }),
    });

    send({
      type: 'result',
      result: {
        ...result,
        skipped: prepared.skipped,
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
