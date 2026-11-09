// =============================================================================
// optimizerRoute — what routes/optimizeTriggers.js and routes/optimizeEquipment.js
// share: body validation, the consumable-cost table rule, the pool size, and the SSE run
// lifecycle (headers, heartbeat, client-disconnect abort, pool teardown). Plus
// subjectRoutes, the whole preview + SSE pair for a tool that ranks replacements
// for one party member (routes/optimizeLoadout.js, routes/optimizeAbilities.js).
// =============================================================================

import { Router } from 'express';
import { isKnownCost } from '../../shared/consumableCost.js';
import { buildExtraBuffs } from './simulator.js';
import { markDungeon, normaliseTarget, targetExtraBuffs, targetPlayerDTOs } from './target.js';
import { createSimulationPool, defaultPoolSize, makePoolEvaluator, MAX_WORKERS } from './triggerSearch/pool.js';
import { defaultObjective, OBJECTIVE_METRICS, reportedMetricsFor } from './triggerSearch/score.js';
import { DEFAULT_SCAN, DEFAULT_SEED_BASE } from './equipmentScan/scan.js';

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
 * The drop-credit table (body.dropCreditCosts: itemHrid → seconds over the
 * consumable class) on the cost table's rules, wherever the zone results credit
 * it: beside a KNOWN bill — a cost table, or a party that slots nothing to eat
 * (a bill of zero, the zone tab's "nothing consumed"). Consumables slotted with
 * no price leave the bill unknown, so there it is refused, as the zone tab then
 * omits its effective rate; and never in a labyrinth. Present, it makes the
 * objective time-denominated (consumableCostsKnown).
 */
export function sanitiseDropCreditCosts(body, { labyrinth, consumableCosts, simPlayers }) {
  if (labyrinth) return null;
  const eats = (simPlayers || []).some((p) => [...(p?.food || []), ...(p?.drinks || [])].some((c) => c?.hrid));
  return consumableCosts || !eats ? sanitiseConsumableCosts(body?.dropCreditCosts) : null;
}

/**
 * A posted `objective` must be a higher-is-better metric that this target
 * reports; absent means the default.
 */
export function objectiveError(body, target) {
  const objective = body?.objective;
  if (objective == null) return null;
  if (OBJECTIVE_METRICS.has(objective) && reportedMetricsFor(target).includes(objective)) return null;
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

/** hours / replicates / alpha for every paired run (the subject tools and the equipment scan): user data from NumberInputs. */
export function sanitiseFidelity(input) {
  const clamp = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? Math.min(max, parsed) : fallback;
  };
  return {
    hours: clamp(input?.hours, DEFAULT_SCAN.hours, 0.1, 1000),
    // Two replicates is the floor for any error bar at all; one would report a
    // difference with no way to say whether it was real.
    replicates: Math.floor(clamp(input?.replicates, DEFAULT_SCAN.replicates, 2, 40)),
    alpha: clamp(input?.alpha, DEFAULT_SCAN.alpha, 0.0001, 0.5),
  };
}

/**
 * POST /api/<path>/preview (JSON) and POST /api/<path> (SSE) for a tool that
 * ranks replacements for ONE member of the party, players[subjectIndex]:
 * Loadout and Abilities. The tool supplies
 *   prepare(base, body) → { candidates, workload, refusal?, echo?, ...its own state }
 *     (refusal: why this run must not start — the preview echoes it, the run answers 400 with it)
 *   run(prepared, { evaluate, signal, onProgress, seedBase, cancelMessage }) → result
 * and this owns validation, the target, buffs and costs (as optimizeEquipment.js),
 * the pool, the evaluator and the frames.
 */
export function subjectRoutes({ path, prepare, run, cancelMessage, emptyError }) {
  const router = Router();
  // May throw on a hostile body; both handlers call it inside their try.
  const setup = (body) => {
    const k = body?.subjectIndex;
    const invalid = validateBody(body) || (Number.isInteger(k) && k >= 0 && k < body.players.length
      && body.players[k] && typeof body.players[k] === 'object' ? null : 'subjectIndex must name one of the players');
    if (invalid) return { invalid };
    const target = markDungeon(normaliseTarget(body));
    const labyrinth = target.kind === 'labyrinth';
    // Nothing is eaten in a labyrinth, so there is no bill to count.
    const consumableCosts = labyrinth ? null : sanitiseConsumableCosts(body.consumableCosts);
    // Food and drinks blanked in a labyrinth, as the game blanks them (target.js).
    const simPlayers = targetPlayerDTOs(body.players, target);
    const dropCreditCosts = sanitiseDropCreditCosts(body, { labyrinth, consumableCosts, simPlayers });
    const base = {
      target, subjectIndex: k, scan: sanitiseFidelity(body.scan), consumableCosts, dropCreditCosts,
      // Same composition runSimulation uses, plus the lab-shop upgrades in a labyrinth.
      extraBuffs: buildExtraBuffs(body.extra || {}).concat(body.guildBuffs || []).concat(targetExtraBuffs(target)),
      simPlayers,
      objective: body.objective || defaultObjective({ consumableCostsKnown: !!(consumableCosts || dropCreditCosts), labyrinth, dungeon: !!target.dungeon }),
    };
    return { prepared: { ...base, ...prepare(base, body) } };
  };
  // What the panel and the results describe the run by. Never the DTOs.
  const echo = (p) => ({ objective: p.objective, target: p.target, reportedMetrics: reportedMetricsFor(p.target),
    consumableCostsKnown: !!(p.consumableCosts || p.dropCreditCosts), subjectIndex: p.subjectIndex, scan: p.scan, workload: p.workload,
    candidates: p.candidates.length, refusal: p.refusal ?? null, ...p.echo });

  router.post(`/${path}/preview`, (req, res) => {
    try {
      const { invalid, prepared } = setup(req.body);
      if (invalid) return res.status(400).json({ success: false, error: invalid });
      return res.json({ success: true, ...echo(prepared), poolSize: poolSizeFor(req.body.workers) });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post(`/${path}`, async (req, res) => {
    let prepared;
    try {
      // Inside the try: an async Express 4 handler's rejection is unhandled and kills the process.
      const out = setup(req.body);
      if (out.invalid) return res.status(400).json({ success: false, error: out.invalid });
      prepared = out.prepared;
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (prepared.refusal || !prepared.candidates.length) return res.status(400).json({ success: false, error: prepared.refusal || emptyError });
    await streamPoolRun(req, res, async ({ pool, poolSize, send, signal }) => {
      send({ type: 'start', poolSize, ...echo(prepared) });
      const evaluate = makePoolEvaluator({ pool, zoneConfig: prepared.target.zone, labyrinthConfig: prepared.target.labyrinth,
        extraBuffs: prepared.extraBuffs, consumableCosts: prepared.consumableCosts, dropCreditCosts: prepared.dropCreditCosts,
        signal, cancelMessage });
      const result = await run(prepared, { evaluate, signal, cancelMessage,
        seedBase: Number(req.body.seedBase) || DEFAULT_SEED_BASE,
        onProgress: (progress) => send({ type: 'progress', ...progress }) });
      send({ type: 'result', result: { ...result, ...echo(prepared) } });
    });
  });
  return router;
}
