// =============================================================================
// optimizeLoadout — every saved loadout of ONE party member against the one it
// wears now, on shared seeds. The UI sends each loadout as a DTO; this route
// owns the ids and everything that is the character's rather than the loadout's.
// =============================================================================
import { subjectRoutes } from '../lib/optimizerRoute.js';
import { targetPlayerDTOs } from '../lib/target.js';
import { estimateWorkload, rankCandidates } from '../lib/equipmentScan/scan.js';

const MAX_CANDIDATES = 40;

function prepare({ target, simPlayers, subjectIndex, scan }, body) {
  const subject = simPlayers[subjectIndex];
  const dtos = new Map();
  const valid = (Array.isArray(body.candidates) ? body.candidates : []).filter((c) => c?.player && typeof c.player === 'object');
  const candidates = valid.slice(0, MAX_CANDIDATES)
    .map((c, i) => {
      // Ours, not the client's: a loadout name may contain the '#' that job ids split on.
      const id = `loadout${i}`;
      const name = String(c.name ?? id);
      // Same character, so the same unit hrid, shrines, seals and level-gap debuff as the slot it replaces.
      dtos.set(id, targetPlayerDTOs([{ ...c.player, hrid: subject.hrid, extraBuffs: subject.extraBuffs,
        debuffOnLevelGap: subject.debuffOnLevelGap }], target)[0]);
      return { id, name, label: name };
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
