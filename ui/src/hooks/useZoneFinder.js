import { useState, useCallback, useMemo } from 'react';
import { useAllZones } from './useAllZones';
import { ONE_HOUR_NS } from '../../../shared/dungeonRuns.js';
import { FINALISTS, QUICK_HOURS, TOP_N, VERIFY_HOURS, countRuns, rankFinalists, rankZones } from '../utils/zoneProgress';

// =============================================================================
// useZoneFinder — the Progress tool's "Find top 10 zones"
//
// Two zone sweeps on its own useAllZones pool (so App's All Zones table keeps
// its rows): every zone × tier × variant for QUICK_HOURS, then each of the best
// FINALISTS (zone, tier)s, with its best variant, for VERIFY_HOURS. The second
// pass is started from the first's onDone; with no finalist it is skipped.
// `top` ranks the finalists on their long rows, a finalist without one keeping
// its quick score, so a stopped or failed second pass still answers. A quick pass
// that is stopped, stalls or errors leaves `stopped` set, and `top` then ranks
// its rows as they stand. `runs` counts both passes' runs and failures.
// =============================================================================

export function useZoneFinder() {
  const sweep = useAllZones();
  const { run, rows, running } = sweep;
  const [job, setJob] = useState(null);
  const [stage, setStage] = useState(null); // 'quick' | 'verify' | 'done'
  const [quickRuns, setQuickRuns] = useState(undefined);
  const [finalists, setFinalists] = useState([]); // the quick pass's best, scored at QUICK_HOURS

  // job: { base: run params bar combos/hours, combos, progressRows, subjectHrid, variants, monsters, items }
  const start = useCallback((next) => {
    const pass = (combos, hours, onDone) =>
      run({ ...next.base, combos, hours, simulationTimeLimit: hours * ONE_HOUR_NS, onDone });
    setJob(next);
    setStage('quick');
    setQuickRuns(undefined);
    setFinalists([]);
    pass(next.combos, QUICK_HOURS, (quick) => {
      setQuickRuns(countRuns(quick));
      const best = rankZones(quick, next, FINALISTS);
      setFinalists(best);
      if (best.length === 0) return setStage('done');
      setStage('verify');
      pass(best.map(({ zoneHrid, difficultyTier, variant }) => ({ zoneHrid, difficultyTier, variant })),
        VERIFY_HOURS, () => setStage('done'));
    });
  }, [run]);

  // Stop, stall or error mid-pass: the pass's own rows are still an answer.
  const stopped = !running && !!job && stage !== 'done';
  const top = useMemo(() => {
    if (!job || !(stage === 'done' || stopped)) return [];
    return stage === 'quick' ? rankZones(rows, job, TOP_N) : rankFinalists(finalists, rows, job, TOP_N);
  }, [stage, stopped, job, rows, finalists]);
  // With no finalist the quick rows are still `rows`: counted once, not twice.
  const runs = useMemo(() => (stage === 'quick' || finalists.length === 0 ? countRuns(rows) : countRuns(rows, quickRuns)),
    [rows, quickRuns, stage, finalists]);
  return { ...sweep, job, stage, stopped, top, runs, finalists: finalists.length, start };
}
