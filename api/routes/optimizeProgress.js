// =============================================================================
// optimizeProgress — "what should I level next?" for ONE party member: each
// stat and slotted ability raised N levels against the current levels on shared
// seeds, the gain per level ranked across both, with what a level costs.
// Probes: lib/progressSearch.js; the paired per-level scan: scanEquipment.
// Advice only: nothing to apply.
// =============================================================================
import { subjectRoutes } from '../lib/optimizerRoute.js';
import { estimateWorkload, scanEquipment } from '../lib/equipmentScan/scan.js';
import { applyProgress, progressRows, withCosts } from '../lib/progressSearch.js';

function prepare({ simPlayers, subjectIndex, scan }, body) {
  const rows = progressRows(simPlayers[subjectIndex], { levels: body.levels, stats: body.stats });
  const candidates = rows.filter((row) => row.scannable);
  // `probes`, not `rows`: subjectRoutes spreads the echo over the result, whose rows are the scan's.
  return { candidates, workload: estimateWorkload(candidates.length, scan),
    echo: { probes: rows.map(({ id, label, scannable, reason }) => ({ id, label, scannable, reason })) } };
}

async function run(p, { evaluate, signal, onProgress, seedBase, cancelMessage }) {
  const result = await scanEquipment({ playerDTOs: p.simPlayers, candidates: p.candidates, objective: p.objective, ...p.scan,
    applyCandidate: (dtos, row) => applyProgress(dtos, p.subjectIndex, row), evaluate, signal, onProgress, seedBase, cancelMessage });
  return { ...result, rows: result.rows.map(withCosts) };
}

export { prepare as prepareProgressRun, run as runProgress };
export default subjectRoutes({ path: 'optimize-progress', prepare, run, cancelMessage: 'Progress scan cancelled',
  emptyError: 'Nothing to raise: every probed stat and ability is already level 200' });
