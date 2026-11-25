// =============================================================================
// triggers — the trigger threshold optimiser tool (optimizerTool.js)
//
//   preview (POST /api/optimize-triggers/preview, or the browser host)
//     Cheap and synchronous. Enumerates every trigger on the submitted players,
//     says which values can be swept and why the rest cannot, derives the search
//     bounds, and estimates the simulation count. The UI calls this on every
//     configuration change so the user sees the bill before committing to a run
//     whose verification stage alone is 72 simulated hours per finalist.
//
//   plan → run (POST /api/optimize-triggers over SSE, or the browser host)
//     Frames are `start`, `progress`, `result`, `error`, `cancelled`.
//
// The run aborts when the client disconnects or cancels (optimizerRoute.js, optimizerHost.js): an
// optimiser run holds a whole worker pool, and a user who navigates away must not leave a
// dozen threads saturating the machine until they finish. It also emits SSE
// heartbeat comments, because a single 72-hour candidate simulation can outlast a
// client-side stall timeout with no natural frame to send.
// =============================================================================

import { buildCommunityBuffs as buildExtraBuffs } from '../../../shared/communityBuffs.js';
import { Refusal, costTables, evaluatorArgs, validateBody } from '../optimizerTool.js';
import { markDungeon, normaliseTarget, targetExtraBuffs, targetPlayerDTOs } from '../target.js';
import { deriveBounds } from '../triggerSearch/bounds.js';
import { collectSearchParams, enumerateTriggers } from '../triggerSearch/params.js';
import { defaultObjective, reportedMetricsFor } from '../triggerSearch/score.js';
import { DEFAULT_STAGES, STABLE_VERIFY_HOURS, estimateWorkload, optimizeTriggers } from '../triggerSearch/search.js';

/** Reject absurd stage configurations before they cost anybody an afternoon. */
const MAX_STAGE_HOURS = 1000;
const MAX_SELECTION = 24;

/**
 * Clamp the caller's stage overrides. The UI offers these as inputs, so they are
 * user data, not trusted configuration.
 */
function sanitiseStages(input, { stableMode = false } = {}) {
  input ??= {}; // a JSON null skips a default parameter
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

  // Same composition runSimulation uses (api/lib/simulator.js), so a candidate
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
  const { consumableCosts, dropCreditCosts, consumableCostsKnown } = costTables(body, { labyrinth, simPlayers });

  // Default to the time-denominated objective whenever we can actually price the
  // food, because raw throughput cannot see the bill and will happily recommend
  // eating constantly for a fraction of a percent. In a labyrinth there is
  // nothing to eat and nothing to price, so the objective is the completion
  // chance instead — see score.js defaultObjective.
  const objective =
    body.objective || defaultObjective({ consumableCostsKnown, labyrinth, dungeon });

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
    dropCreditCosts,
    consumableCostsKnown,
    objective,
  };
}

/** Validation, clamped stages and the shared setup: what preview and plan both start from. */
function setup(body) {
  const invalid = validateBody(body);
  if (invalid) throw new Refusal(invalid);
  return { stages: sanitiseStages(body.stages, { stableMode: !!body.stableMode }), ...prepare(body) };
}

export default {
  path: 'optimize-triggers',

  /** What can be searched, over what range, and what it will cost. */
  preview(body) {
    const { stages, target, bounds, triggers, selection, params, rejected, consumableCosts, consumableCostsKnown, objective } =
      setup(body);
    return {
      objective,
      // Echoed back clamped and validated, so the panel can show the room level
      // and crates actually in force rather than the ones it hoped it sent.
      target,
      reportedMetrics: reportedMetricsFor(target),
      // Lets the UI say plainly whether the food bill is being counted, and warn
      // when it is not — that is the difference between a trustworthy consumable
      // recommendation and one biased toward eating constantly.
      consumableCostsKnown,
      pricedConsumables: consumableCosts ? Object.keys(consumableCosts) : [],
      bounds,
      triggers,
      selection,
      params,
      rejected,
      stages,
      workload: estimateWorkload(params, stages),
    };
  },

  /** The search, streaming progress. */
  plan(body) {
    const prepared = setup(body);
    const { stages } = prepared;
    if (prepared.params.length === 0) {
      throw new Refusal('No searchable trigger values in the selection', { rejected: prepared.rejected });
    }
    const echo = {
      target: prepared.target,
      reportedMetrics: reportedMetricsFor(prepared.target),
      consumableCostsKnown: prepared.consumableCostsKnown,
    };
    return {
      start: { stages, objective: prepared.objective, ...echo, params: prepared.params, rejected: prepared.rejected,
        workload: estimateWorkload(prepared.params, stages) },
      evaluator: evaluatorArgs(prepared),
      async run({ evaluate, signal, onProgress }) {
        const result = await optimizeTriggers({
          // The stripped set when the target is a labyrinth: the search must sweep
          // the build the game would actually let the player field.
          playerDTOs: prepared.simPlayers,
          params: prepared.params,
          evaluate,
          objective: prepared.objective,
          stages,
          seedBase: Number(body.seedBase) || undefined,
          epsilons: body.epsilons || {},
          signal,
          onProgress,
        });
        // Merged rather than returned by search.js, which is deliberately ignorant of
        // pricing — it takes an objective name and an evaluator, nothing more.
        return { ...result, ...echo, pricedConsumables: prepared.consumableCosts ? Object.keys(prepared.consumableCosts) : [] };
      },
    };
  },
};
