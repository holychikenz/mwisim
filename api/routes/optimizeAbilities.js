// =============================================================================
// optimizeAbilities — other owned abilities in each slot of ONE party member,
// and other cast orders, against the current setup on shared seeds; or a
// coordinate descent to the best combination. Candidates: lib/abilitySearch.js;
// the search: lib/descent.js.
// =============================================================================
import { subjectRoutes } from '../lib/optimizerRoute.js';
import { planSearch, searchSubject } from '../lib/descent.js';
import { COORDINATES, abilityContext, bestCandidate, candidatesAt, coordinateSummary, estimateDescent, labelOf } from '../lib/abilitySearch.js';

function prepare({ simPlayers, subjectIndex, scan }, body) {
  const ctx = abilityContext(simPlayers[subjectIndex], body.ownedAbilities, body.triggerMemory);
  const asked = Array.isArray(body.coordinates) ? new Set(body.coordinates.map(String)) : null;
  const coordinates = COORDINATES.filter((key) => !asked || asked.has(key));
  const all = coordinates.flatMap((key) => candidatesAt(ctx.abilities, key, ctx));
  const plan = planSearch(body, all, scan, (passes) => estimateDescent(ctx, coordinates, passes, scan), 'Untick a slot.');
  return { ctx, coordinates, ...plan, echo: { ...plan.echo, slots: coordinateSummary(ctx) } };
}

const run = (p, io) => searchSubject(p, io, {
  start: p.ctx.abilities, patch: (dto, abilities) => ({ ...dto, abilities }), stateOf: (row) => row.abilities,
  candidatesAt: (abilities, key) => candidatesAt(abilities, key, p.ctx), labelOf, bestOf: (abilities) => bestCandidate(p.ctx, abilities),
});

export default subjectRoutes({ path: 'optimize-abilities', prepare, run, cancelMessage: 'Ability search cancelled',
  emptyError: 'No owned ability fits the chosen slots, and there is no other cast order to try' });

export { prepare as prepareAbilityRun, run as runAbilitySearch };
