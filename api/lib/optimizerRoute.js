// =============================================================================
// optimizerRoute — what routes/optimizeTriggers.js and routes/optimizeEquipment.js
// share: body validation, the consumable-cost table rule, the pool size, and the SSE run
// lifecycle (headers, heartbeat, client-disconnect abort, pool teardown).
// =============================================================================

import { isKnownCost } from '../../shared/consumableCost.js';
import { markDungeon, normaliseTarget } from './target.js';
import { createSimulationPool, defaultPoolSize, MAX_WORKERS } from './triggerSearch/pool.js';
import { reportedMetricsFor } from './triggerSearch/score.js';

/** Heartbeat interval. Comfortably inside a 30s client stall timeout. */
const HEARTBEAT_MS = 10_000;

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
export function sanitiseConsumableCosts(input) {
  if (!input || typeof input !== 'object') return null;
  const costs = {};
  for (const [hrid, value] of Object.entries(input)) {
    // isKnownCost rather than a local `>= 0`, so this surface and the scoring
    // agree on the -1-vs-0 rule — and so a posted null is rejected rather than
    // coerced to a cost of nothing.
    if (isKnownCost(value)) costs[hrid] = Number(value);
  }
  return Object.keys(costs).length ? costs : null;
}

/**
 * Reported metrics where lower is better. The ranking and the equipment scan
 * always maximise, so as an objective each would put the worst build first.
 * attemptsPerHour is here too: it rises with every quick death.
 */
const NOT_OBJECTIVES = new Set([
  'deathsPerHour', 'consumableSecondsPerHour', 'consumablesPerHour', 'dungeonFailuresPerHour',
  'timeoutsPerHour', 'roomDeathsPerHour', 'attemptsPerHour', 'outOfManaSecondsPerHour',
]);

/**
 * A posted `objective` must be a higher-is-better metric that this target
 * reports; absent means the default.
 */
export function objectiveError(body, target) {
  const objective = body?.objective;
  if (objective == null) return null;
  if (reportedMetricsFor(target).includes(objective) && !NOT_OBJECTIVES.has(objective)) return null;
  return `Unknown objective ${String(objective)} for this target (it must be a higher-is-better metric the target reports)`;
}

/** The first problem with an optimiser request body, or null when it is usable. */
export function validateBody(body) {
  const { players } = body || {};
  if (!players || !Array.isArray(players) || players.length === 0) {
    return 'Players array is required';
  }
  // `zone` XOR `labyrinth`, resolved and validated in one place so the two
  // routes and the bounds derivation cannot disagree about what was asked for.
  // See api/lib/target.js.
  const target = normaliseTarget(body);
  return target.error || objectiveError(body, markDungeon(target));
}

/** The caller's `workers`, clamped to [1, MAX_WORKERS]; the default when absent. */
export function poolSizeFor(workers) {
  return Math.min(MAX_WORKERS, Math.max(1, Math.floor(Number(workers)) || defaultPoolSize()));
}

/**
 * Run `body({ pool, poolSize, send, signal })` as a Server-Sent Events response.
 *
 * SSE comments (the heartbeat) are ignored by EventSource and by a manual reader
 * that skips non-`data:` lines, but they keep the socket and any client stall
 * timer alive across a long candidate simulation.
 *
 * The client vanishing is a normal way a long run ends. Without the abort the
 * pool keeps every worker busy to completion for a result nobody will read.
 * It listens on `res`, not `req`: Node emits `req`'s 'close' when the REQUEST
 * has been fully received — on every normal request — while `res`'s 'close'
 * fires when the response finishes or the socket dies, and `writableFinished`
 * distinguishes the two.
 */
export async function streamPoolRun(req, res, body) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
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

  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const poolSize = poolSizeFor(req.body.workers);
    pool = await createSimulationPool({ size: poolSize });
    await body({ pool, poolSize, send, signal: controller.signal });
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
}
