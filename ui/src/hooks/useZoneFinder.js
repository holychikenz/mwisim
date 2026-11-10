import { useState, useCallback, useMemo } from 'react';
import { useAllZones } from './useAllZones';
import { ONE_HOUR_NS } from '../../../shared/dungeonRuns.js';
import { FINALISTS, QUICK_HOURS, TOP_N, VERIFY_HOURS, countRuns, rankZones } from '../utils/zoneProgress';

// =============================================================================
// useZoneFinder — the Progress tool's "Find top 10 zones"
//
// Two zone sweeps on its own useAllZones pool (so App's All Zones table keeps
// its rows): every zone × tier × variant for QUICK_HOURS, then each of the best
// FINALISTS (zone, tier)s, with its best variant, for VERIFY_HOURS. The second
// pass is started from the first's onDone; `top` ranks the second's rows, which
// useAllZones flushes before calling onDone, so they are complete at 'done'.
// A pass that is stopped, stalls or errors leaves `stopped` set, and `top` then
// ranks that pass's rows as they stand. `runs` counts both passes' runs and failures.
// =============================================================================

export function useZoneFinder() {
  const sweep = useAllZones();
  const { run, rows, running } = sweep;
  const [job, setJob] = useState(null);
  const [stage, setStage] = useState(null); // 'quick' | 'verify' | 'done'
  const [quickRuns, setQuickRuns] = useState(undefined);

  // job: { base: run params bar combos/hours, combos, progressRows, subjectHrid, variants, monsters, items }
  const start = useCallback((next) => {
    const pass = (combos, hours, onDone) =>
      run({ ...next.base, combos, hours, simulationTimeLimit: hours * ONE_HOUR_NS, onDone });
    setJob(next);
    setStage('quick');
    setQuickRuns(undefined);
    pass(next.combos, QUICK_HOURS, (quick) => {
      setStage('verify');
      setQuickRuns(countRuns(quick));
      const finalists = rankZones(quick, next, FINALISTS)
        .map(({ zoneHrid, difficultyTier, variant }) => ({ zoneHrid, difficultyTier, variant }));
      pass(finalists, VERIFY_HOURS, () => setStage('done'));
    });
  }, [run]);

  // Stop, stall or error mid-pass: the pass's own rows are still an answer.
  const stopped = !running && !!job && stage !== 'done';
  const top = useMemo(() => (job && (stage === 'done' || stopped) ? rankZones(rows, job, TOP_N) : []), [stage, stopped, job, rows]);
  const runs = useMemo(() => countRuns(rows, quickRuns), [rows, quickRuns]);
  return { ...sweep, job, stage, stopped, top, runs, start };
}
