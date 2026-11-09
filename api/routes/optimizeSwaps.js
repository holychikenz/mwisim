// =============================================================================
// optimizeSwaps — other owned food, drinks and gear for ONE party member against
// what it wears now, on shared seeds; or a coordinate descent to the best
// combination. Candidates: lib/swapSearch.js; the search: lib/descent.js.
// =============================================================================
import { subjectRoutes } from '../lib/optimizerRoute.js';
import { planSearch, searchSubject } from '../lib/descent.js';
import { COORDINATES, bestSwap, candidatesAt, estimateSwapDescent, labelOf, swapContext, swapGroups } from '../lib/swapSearch.js';

function prepare({ target, simPlayers, subjectIndex, scan, objective, consumableCosts, dropCreditCosts }, body) {
  const allowed = Array.isArray(body.allowed) ? new Set(body.allowed.map(String)) : null;
  // A costed objective counts a consumable with no price as free (sanitiseConsumableCosts dropped its -1; a 0 stays) —
  // drop credit alone costs it too, and then nothing has a price.
  const unpriced = (consumableCosts || dropCreditCosts) && objective?.startsWith('effective')
    ? (hrid) => !Object.hasOwn(consumableCosts || {}, hrid) : null;
  // Nothing is eaten in a labyrinth (target.js strips it), so only gear is swapped there.
  const ctx = swapContext(simPlayers[subjectIndex], body.owned, { allowed, consumables: target.kind !== 'labyrinth', unpriced });
  const all = COORDINATES.flatMap((key) => candidatesAt(ctx.start, key, ctx));
  const plan = planSearch(body, all, scan, (passes) => estimateSwapDescent(ctx, passes, scan), 'Untick some items.');
  return { ctx, coordinates: COORDINATES, ...plan, echo: { ...plan.echo, groups: swapGroups(ctx) } };
}

const run = (p, io) => searchSubject(p, io, {
  start: p.ctx.start, patch: (dto, { equipment, food, drinks }) => ({ ...dto, equipment, food, drinks }), stateOf: (row) => row.state,
  candidatesAt: (state, key) => candidatesAt(state, key, p.ctx), labelOf, bestOf: (state) => bestSwap(p.ctx, state),
});

export { prepare as prepareSwapRun, run as runSwapSearch };
export default subjectRoutes({ path: 'optimize-swaps', prepare, run, cancelMessage: 'Swap search cancelled',
  emptyError: 'Nothing this character owns is ticked to try' });
