// =============================================================================
// optimizeAbilities — other owned abilities in each slot of ONE party member,
// and other cast orders, against the current setup on shared seeds; or a
// coordinate descent to the best combination. Candidates: lib/abilitySearch.js.
// =============================================================================
import { subjectRoutes } from '../lib/optimizerRoute.js';
import { estimateWorkload, rankCandidates } from '../lib/equipmentScan/scan.js';
import { COORDINATES, abilityContext, bestCandidate, candidatesAt, coordinateSummary, descendAbilities, estimateDescent } from '../lib/abilitySearch.js';

/** One change at a time tries at most this many; a character who owns everything offers ~200. The rest are reported as skipped. */
const MAX_CANDIDATES = 150;
/**
 * A best-combination pass may simulate, per replicate, no more than one change at a time
 * can (MAX_CANDIDATES and the baseline). A bigger one is refused, not trimmed, so the user
 * picks which slots to drop.
 */
const MAX_PASS_SIMULATIONS = MAX_CANDIDATES + 1;
/** Fresh seeds for re-measuring a descent's winner: on the seeds it was chosen on, it would look better than it is. */
const CONFIRM_SEED_OFFSET = 1_000_000;

function prepare({ simPlayers, subjectIndex, scan }, body) {
  const ctx = abilityContext(simPlayers[subjectIndex], body.ownedAbilities, body.triggerMemory);
  const asked = Array.isArray(body.coordinates) ? new Set(body.coordinates.map(String)) : null;
  const coordinates = COORDINATES.filter((key) => !asked || asked.has(key));
  const best = body.search === 'best';
  const passes = Math.min(3, Math.max(1, Math.floor(Number(body.passes)) || 2));
  const all = coordinates.flatMap((key) => candidatesAt(ctx.abilities, key, ctx));
  const candidates = best ? all : all.slice(0, MAX_CANDIDATES);
  const workload = best ? estimateDescent(ctx, coordinates, passes, scan) : estimateWorkload(candidates.length, scan);
  return {
    ctx, coordinates, best, passes, candidates, workload,
    refusal: best && workload.candidates > MAX_PASS_SIMULATIONS
      ? `One pass of the best-combination search would simulate up to ${workload.candidates} setups per replicate; the limit is ${MAX_PASS_SIMULATIONS}, as for one change at a time. Untick a slot.`
      : null,
    echo: { search: best ? 'best' : 'swaps', passes, slots: coordinateSummary(ctx), skipped: all.length - candidates.length },
  };
}

async function run(p, { evaluate, signal, onProgress, seedBase, cancelMessage }) {
  const k = p.subjectIndex;
  const shared = { evaluate, signal, cancelMessage, objective: p.objective, ...p.scan,
    applyCandidate: (dtos, row) => dtos.map((dto, i) => (i === k ? { ...dto, abilities: row.abilities } : dto)) };
  if (!p.best) return rankCandidates({ ...shared, playerDTOs: p.simPlayers, candidates: p.candidates, seedBase, onProgress });

  let done = 0;
  let last = null;
  const rank = async (abilities, candidates, label, seed = seedBase) => {
    const result = await rankCandidates({
      ...shared, candidates, seedBase: seed,
      playerDTOs: p.simPlayers.map((dto, i) => (i === k ? { ...dto, abilities } : dto)),
      onProgress: (x) => onProgress({ ...x, stage: 'descent', label: `${label} · ${x.label}`,
        completed: done + x.completed, total: p.workload.total, progress: Math.min(1, (done + x.completed) / p.workload.total) }),
    });
    done += result.simulationsRun;
    last = result;
    return result;
  };
  const { abilities, steps } = await descendAbilities({ ctx: p.ctx, coordinates: p.coordinates, passes: p.passes, rank });
  const best = bestCandidate(p.ctx, abilities);
  // Ended where it started: nothing to confirm or apply. The last ranking measured the start on the run's own seeds.
  const result = best ? await rank(p.ctx.abilities, [best], 'confirming', seedBase + CONFIRM_SEED_OFFSET) : { ...last, rows: [] };
  // The whole search, not only its last ranking.
  return { ...result, steps, simulationsRun: done, estimatedSimulations: p.workload.total };
}

export default subjectRoutes({ path: 'optimize-abilities', prepare, run, cancelMessage: 'Ability search cancelled',
  emptyError: 'No owned ability fits the chosen slots, and there is no other cast order to try' });

export { prepare as prepareAbilityRun, run as runAbilitySearch };
