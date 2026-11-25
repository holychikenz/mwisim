// =============================================================================
// equipment — the equipment enhancement scan tool (optimizerTool.js)
//
// Sibling of triggers.js and deliberately shaped like it: a cheap
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

import { buildCommunityBuffs as buildExtraBuffs } from '../../../shared/communityBuffs.js';
import { Refusal, costTables, evaluatorArgs, sanitiseFidelity, validateBody } from '../optimizerTool.js';
import { markDungeon, normaliseTarget, targetExtraBuffs, targetPlayerDTOs } from '../target.js';
import { defaultObjective, reportedMetricsFor } from '../triggerSearch/score.js';
import {
  DEFAULT_STEP,
  MAX_ENHANCEMENT_LEVEL,
  applyEnhancement,
  enumerateEquipment,
} from '../equipmentScan/candidates.js';
import { DEFAULT_SEED_BASE, estimateWorkload, scanEquipment } from '../equipmentScan/scan.js';

/** Guard rail on user-supplied configuration. */
const MAX_CANDIDATES = 40;

/**
 * Clamp the scan configuration. These arrive from NumberInputs, so they are user
 * data rather than trusted settings. Hours, replicates and alpha clamp as every
 * paired run's do (optimizerRoute.js sanitiseFidelity); the step is the scan's own.
 */
function sanitiseScan(input) {
  const integer = (value, fallback, min, max) => {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(max, parsed);
  };

  return {
    ...sanitiseFidelity(input),
    // A step of at least one, and never past the cap — an over-cap level yields
    // an undefined multiplier and silently NaN stats.
    step: integer(input?.step, DEFAULT_STEP, 1, MAX_ENHANCEMENT_LEVEL),
  };
}

/**
 * Shared setup for both routes. Exported for the tests only, as
 * prepareEquipmentRun: the objective chosen here is the decision under test,
 * and the router offers no way to observe it short of running a scan.
 */
function prepare(body) {
  const invalid = validateBody(body);
  if (invalid) throw new Refusal(invalid);
  const { players, extra = {}, guildBuffs = [] } = body;
  const scan = sanitiseScan(body.scan);
  // A dungeon ranks on completed runs, not waves — the same flag, objective and
  // reported metrics as the trigger optimiser (score.js dungeonMetrics).
  const target = markDungeon(normaliseTarget(body));
  const labyrinth = target.kind === 'labyrinth';
  const dungeon = !!target.dungeon;

  // Same composition runSimulation uses, so a candidate is scored against exactly
  // the build a normal simulation would produce — plus the lab-shop combat
  // upgrades when the target is a labyrinth.
  const extraBuffs = buildExtraBuffs(extra).concat(guildBuffs).concat(targetExtraBuffs(target));

  // Food and drinks are blanked for a labyrinth target. This is not cosmetic
  // here: an unstripped run would let the build eat its way through rooms the
  // game would not, and every row in the table would be measured against a
  // baseline the player cannot field.
  const simPlayers = targetPlayerDTOs(players, target);

  // Enumerated from the simulated set. Equipment is untouched by the stripping —
  // a pouch is still worn — so the two sets agree here; it is the SAME set that
  // is passed, deliberately, so no future divergence can arise. A Guzzling Pouch
  // in a labyrinth will duly measure zero, since its enhancement raises drink
  // concentration and there are no drinks. That is the right answer, arrived at
  // by measurement rather than by a special case.
  const equipment = enumerateEquipment(simPlayers, { step: scan.step });

  // An explicit selection is a list of row ids ("0:/equipment_types/head").
  // Absent, everything scannable is scanned, which is the sensible default and
  // what the preview shows.
  const requested = Array.isArray(body.selection) ? new Set(body.selection.map(String)) : null;
  const candidates = equipment
    .filter((row) => row.scannable && (!requested || requested.has(row.id)))
    .slice(0, MAX_CANDIDATES);

  const skipped = equipment.filter((row) => !row.scannable);
  // Nothing is eaten in a labyrinth, so there is no bill to count and the
  // time-denominated objective would only pretend to discriminate.
  const { consumableCosts, dropCreditCosts, consumableCostsKnown } = costTables(body, { labyrinth, simPlayers });

  // Default to the time-denominated objective whenever the food can be priced.
  // Raw throughput cannot see the consumable bill, and an enhancement that lets
  // the build eat less would go unrewarded by it. A labyrinth ranks on the
  // completion chance instead, and a dungeon on completed runs per hour — see
  // score.js defaultObjective.
  const objective =
    body.objective || defaultObjective({ consumableCostsKnown, labyrinth, dungeon });

  return {
    scan,
    target,
    simPlayers,
    equipment,
    candidates,
    skipped,
    extraBuffs,
    consumableCosts,
    dropCreditCosts,
    consumableCostsKnown,
    objective,
  };
}

export default {
  path: 'optimize-equipment',

  /** Which slots can be probed, which cannot and why, and what it will cost. */
  preview(body) {
    const { scan, target, equipment, candidates, skipped, consumableCosts, consumableCostsKnown, objective } = prepare(body);
    return {
      objective,
      // Echoed back clamped and validated: the panel shows the room level and
      // crates actually in force, not the ones it hoped it sent.
      target,
      reportedMetrics: reportedMetricsFor(target),
      consumableCostsKnown,
      pricedConsumables: consumableCosts ? Object.keys(consumableCosts) : [],
      maxEnhancementLevel: MAX_ENHANCEMENT_LEVEL,
      equipment,
      candidates,
      skipped,
      scan,
      workload: estimateWorkload(candidates.length, scan),
    };
  },

  /** The scan, streaming progress. */
  plan(body) {
    const prepared = prepare(body);
    if (prepared.candidates.length === 0) {
      throw new Refusal('No equipment in the selection can be enhanced further', { skipped: prepared.skipped });
    }
    const echo = {
      target: prepared.target,
      reportedMetrics: reportedMetricsFor(prepared.target),
      consumableCostsKnown: prepared.consumableCostsKnown,
    };
    return {
      start: { scan: prepared.scan, objective: prepared.objective, ...echo, candidates: prepared.candidates,
        skipped: prepared.skipped, workload: estimateWorkload(prepared.candidates.length, prepared.scan) },
      evaluator: evaluatorArgs(prepared, 'Equipment scan cancelled'),
      async run({ evaluate, signal, onProgress }) {
        const result = await scanEquipment({
          // Stripped for a labyrinth target, so the baseline is the build the game
          // would actually let the player walk in with.
          playerDTOs: prepared.simPlayers,
          candidates: prepared.candidates,
          evaluate,
          applyCandidate: applyEnhancement,
          objective: prepared.objective,
          hours: prepared.scan.hours,
          replicates: prepared.scan.replicates,
          alpha: prepared.scan.alpha,
          seedBase: Number(body.seedBase) || DEFAULT_SEED_BASE,
          signal,
          onProgress,
        });
        return { ...result, skipped: prepared.skipped, ...echo,
          pricedConsumables: prepared.consumableCosts ? Object.keys(prepared.consumableCosts) : [] };
      },
    };
  },
};

export { prepare as prepareEquipmentRun };
