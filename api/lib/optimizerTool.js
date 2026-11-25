// =============================================================================
// optimizerTool — the optimiser tools without a transport. Each tool
// (api/lib/tools/*.js) is { path, preview(body), plan(body) }; previewTool and
// planTool answer a request body as the HTTP routes did, and runPlanned runs a
// plan on any pool, sending the frames `start`, `progress`, `result`,
// `error` / `cancelled`. Two transports drive them: the Express routes
// (optimizerRoute.js: JSON + SSE over worker_threads) and the UI's in-browser
// host (ui/src/workers/optimizerHost.js: postMessage over Web Workers running
// the wasm twin). Nothing here may import Node: the browser bundles it.
// =============================================================================

import { isKnownCost } from '../../shared/consumableCost.js';
import { buildCommunityBuffs as buildExtraBuffs } from '../../shared/communityBuffs.js';
import { markDungeon, normaliseTarget, targetExtraBuffs, targetPlayerDTOs } from './target.js';
import { makePoolEvaluator } from './triggerSearch/poolCore.js';
import { costsKnown, COSTED_OBJECTIVES, defaultObjective, OBJECTIVE_METRICS, reportedMetricsFor } from './triggerSearch/score.js';
import { DEFAULT_SCAN, DEFAULT_SEED_BASE } from './equipmentScan/scan.js';

/** A request the tool refuses: answered as { success: false, error, ...extra } with `status`, never as a run. */
export class Refusal extends Error {
  constructor(message, { status = 400, ...extra } = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const refused = (error) => ({ status: error.status, json: { success: false, error: error.message, ...error.extra } });

/** A tool's preview as { status, json }: 200 with poolSize, its refusal, or 500 when it throws. */
export function previewTool(tool, body, poolSize) {
  try {
    return { status: 200, json: { success: true, ...tool.preview(body ?? {}), poolSize } };
  } catch (error) {
    return error instanceof Refusal ? refused(error) : { status: 500, json: { success: false, error: error.message } };
  }
}

/** A tool's run plan, { planned }; or { status, json } when it is refused or its setup throws (a hostile body: 400). */
export function planTool(tool, body) {
  try {
    return { planned: tool.plan(body ?? {}) };
  } catch (error) {
    return error instanceof Refusal ? refused(error) : { status: 400, json: { success: false, error: error.message } };
  }
}

/** The evaluator's run-wide arguments for a prepared run. */
export const evaluatorArgs = (p, cancelMessage) => ({ zoneConfig: p.target.zone, labyrinthConfig: p.target.labyrinth,
  extraBuffs: p.extraBuffs, consumableCosts: p.consumableCosts, dropCreditCosts: p.dropCreditCosts, ...(cancelMessage ? { cancelMessage } : {}) });

/**
 * Run a plan from planTool on a pool from `createPool(poolSize)`, sending every frame through `send`. Never throws:
 * a cancellation (an AbortError) is a `cancelled` frame, any other failure an `error` frame. The pool is destroyed after.
 */
export async function runPlanned(planned, { createPool, poolSize, send, signal }) {
  let pool = null;
  try {
    pool = await createPool(poolSize);
    send({ type: 'start', poolSize, ...planned.start });
    const evaluate = makePoolEvaluator({ pool, ...planned.evaluator, signal });
    const result = await planned.run({ evaluate, signal, onProgress: (progress) => send({ type: 'progress', ...progress }) });
    send({ type: 'result', result });
  } catch (error) {
    send(error?.name === 'AbortError' ? { type: 'cancelled', error: error.message } : { type: 'error', error: error.message });
  } finally {
    await pool?.destroy();
  }
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

/** The Loadout tool simulates only the first this many of the whole loadouts it is sent (body.candidates). */
export const MAX_LOADOUT_CANDIDATES = 40;

/** body.candidates that can run at all (each needs a player), in order; only the first MAX_LOADOUT_CANDIDATES do. */
export const postedLoadouts = (body) => (Array.isArray(body?.candidates) ? body.candidates : [])
  .filter((c) => c?.player && typeof c.player === 'object');

/** Whether a player slots any food or drink, or with `test` one whose hrid passes it. */
export const slotsConsumable = (player, test = () => true) =>
  [player?.food, player?.drinks].some((list) => Array.isArray(list) && list.some((c) => c?.hrid && test(c.hrid)));

/**
 * Under a costed objective a consumable with no price counts as free (sanitiseConsumableCosts dropped its -1; a 0
 * stays), and with drop credit alone nothing has a price: the test Swaps and Loadout flag such items by. Else null.
 */
export const unpricedUnder = ({ objective, consumableCosts, consumableCostsKnown }) =>
  (consumableCostsKnown && COSTED_OBJECTIVES.has(objective) ? (hrid) => !Object.hasOwn(consumableCosts || {}, hrid) : null);

/**
 * The drop-credit table (body.dropCreditCosts: itemHrid → seconds over the
 * consumable class) on the cost table's rules, beside a bill known BEFORE the
 * run: a cost table, or nothing slotted to eat by the party or by any whole
 * loadout the run swaps in (the postedLoadouts it simulates, the Loadout tool). Consumables
 * slotted with no price leave the bill unknown, so there it is refused; and
 * never in a labyrinth. The zone results ask the same question of what was
 * EATEN, which only a finished run knows, so they also credit a run whose
 * unpriced slot never fired — no optimiser can promise that of a candidate.
 * Present, it makes the objective time-denominated (consumableCostsKnown).
 */
export function sanitiseDropCreditCosts(body, { labyrinth, consumableCosts, simPlayers }) {
  if (labyrinth) return null;
  const parties = [...(simPlayers || []), ...postedLoadouts(body).slice(0, MAX_LOADOUT_CANDIDATES).map((c) => c.player)];
  const eats = parties.some((p) => slotsConsumable(p));
  return consumableCosts || !eats ? sanitiseConsumableCosts(body?.dropCreditCosts) : null;
}

/**
 * Both tables on their rules, and the one flag every objective and echo reads:
 * the bill is known, so the objective is time-denominated, with either table.
 */
export function costTables(body, { labyrinth, simPlayers }) {
  // Nothing is eaten in a labyrinth, so there is no bill to count.
  const consumableCosts = labyrinth ? null : sanitiseConsumableCosts(body?.consumableCosts);
  const dropCreditCosts = sanitiseDropCreditCosts(body, { labyrinth, consumableCosts, simPlayers });
  return { consumableCosts, dropCreditCosts, consumableCostsKnown: costsKnown(consumableCosts, dropCreditCosts) };
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
 * The tool for one that ranks replacements for ONE member of the party,
 * players[subjectIndex]: Loadout, Abilities, Progress and Swaps. The tool supplies
 *   prepare(base, body) → { candidates, workload, refusal?, echo?, ...its own state }
 *     (refusal: why this run must not start — the preview echoes it, the run is refused with it)
 *   run(prepared, { evaluate, signal, onProgress, seedBase, cancelMessage }) → result
 * and this owns validation, the target, buffs and costs (as tools/equipment.js),
 * the evaluator's arguments and the echo.
 */
export function subjectTool({ path, prepare, run, cancelMessage, emptyError }) {
  // May throw on a hostile body; previewTool and planTool catch it.
  const setup = (body) => {
    const k = body?.subjectIndex;
    const invalid = validateBody(body) || (Number.isInteger(k) && k >= 0 && k < body.players.length
      && body.players[k] && typeof body.players[k] === 'object' ? null : 'subjectIndex must name one of the players');
    if (invalid) throw new Refusal(invalid);
    const target = markDungeon(normaliseTarget(body));
    const labyrinth = target.kind === 'labyrinth';
    // Food and drinks blanked in a labyrinth, as the game blanks them (target.js).
    const simPlayers = targetPlayerDTOs(body.players, target);
    const { consumableCosts, dropCreditCosts, consumableCostsKnown } = costTables(body, { labyrinth, simPlayers });
    const base = {
      target, subjectIndex: k, scan: sanitiseFidelity(body.scan), consumableCosts, dropCreditCosts, consumableCostsKnown,
      // Same composition runSimulation uses, plus the lab-shop upgrades in a labyrinth.
      extraBuffs: buildExtraBuffs(body.extra || {}).concat(body.guildBuffs || []).concat(targetExtraBuffs(target)),
      simPlayers,
      objective: body.objective || defaultObjective({ consumableCostsKnown, labyrinth, dungeon: !!target.dungeon }),
    };
    return { ...base, ...prepare(base, body) };
  };
  // What the panel and the results describe the run by. Never the DTOs.
  const echo = (p) => ({ objective: p.objective, target: p.target, reportedMetrics: reportedMetricsFor(p.target),
    consumableCostsKnown: p.consumableCostsKnown, subjectIndex: p.subjectIndex, scan: p.scan, workload: p.workload,
    candidates: p.candidates.length, refusal: p.refusal ?? null, ...p.echo });

  return {
    path,
    preview: (body) => echo(setup(body)),
    plan(body) {
      const prepared = setup(body);
      if (prepared.refusal || !prepared.candidates.length) throw new Refusal(prepared.refusal || emptyError);
      return {
        start: echo(prepared),
        evaluator: evaluatorArgs(prepared, cancelMessage),
        run: async ({ evaluate, signal, onProgress }) => ({
          ...(await run(prepared, { evaluate, signal, cancelMessage, onProgress, seedBase: Number(body.seedBase) || DEFAULT_SEED_BASE })),
          ...echo(prepared),
        }),
      };
    },
  };
}
