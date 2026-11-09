// =============================================================================
// optimizeLoadout — every saved loadout of ONE party member against the one it
// wears now, on shared seeds. The UI sends each loadout as a DTO; this route
// owns the ids and everything that is the character's rather than the loadout's,
// and labels a loadout whose unpriced food or drink a costed ranking counts as free.
// =============================================================================
import { MAX_LOADOUT_CANDIDATES, postedLoadouts, slotsConsumable, subjectRoutes, unpricedUnder } from '../lib/optimizerRoute.js';
import { targetPlayerDTOs } from '../lib/target.js';
import { estimateWorkload, rankCandidates } from '../lib/equipmentScan/scan.js';

function prepare({ target, simPlayers, subjectIndex, scan, objective, consumableCosts, consumableCostsKnown }, body) {
  const subject = simPlayers[subjectIndex];
  const unpriced = unpricedUnder({ objective, consumableCosts, consumableCostsKnown });
  const dtos = new Map();
  const valid = postedLoadouts(body);
  const candidates = valid.slice(0, MAX_LOADOUT_CANDIDATES)
    .map((c, i) => {
      // Ours, not the client's: a loadout name may contain the '#' that job ids split on.
      const id = `loadout${i}`;
      const name = String(c.name ?? id);
      // Same character, so the same unit hrid, shrines, seals and level-gap debuff as the slot it replaces.
      const dto = targetPlayerDTOs([{ ...c.player, hrid: subject.hrid, extraBuffs: subject.extraBuffs,
        debuffOnLevelGap: subject.debuffOnLevelGap }], target)[0];
      dtos.set(id, dto);
      // Said as Swaps says it of an owned item: this ranking counts its unpriced food or drink as free.
      return { id, name, label: unpriced && slotsConsumable(dto, unpriced) ? `${name} · no price` : name };
    });
  return { candidates, dtos, workload: estimateWorkload(candidates.length, scan), echo: { skipped: valid.length - candidates.length } };
}

const run = (p, { evaluate, signal, onProgress, seedBase, cancelMessage }) => rankCandidates({
  playerDTOs: p.simPlayers, candidates: p.candidates, objective: p.objective, ...p.scan,
  applyCandidate: (dtos, row) => dtos.map((dto, i) => (i === p.subjectIndex ? p.dtos.get(row.id) : dto)),
  evaluate, signal, onProgress, seedBase, cancelMessage,
});

export { prepare as prepareLoadoutRun };
export default subjectRoutes({ path: 'optimize-loadout', prepare, run,
  cancelMessage: 'Loadout comparison cancelled', emptyError: 'This character has no other saved loadout to compare' });
