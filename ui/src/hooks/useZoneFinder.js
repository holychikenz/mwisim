import { useState, useCallback, useMemo } from 'react';
import { useAllZones } from './useAllZones';
import { FINALISTS, QUICK_HOURS, TOP_N, VERIFY_HOURS, scoreZoneRow, topZones } from '../utils/zoneProgress';

// =============================================================================
// useZoneFinder — the Progress tool's "Find top 10 zones"
//
// Two zone sweeps on its own useAllZones pool (so App's All Zones table keeps
// its rows): every zone × tier × variant for QUICK_HOURS, then each of the best
// FINALISTS (zone, tier)s, with its best variant, for VERIFY_HOURS. The second
// pass is started from the first's onDone; `top` ranks the second's rows, which
// useAllZones flushes before calling onDone, so they are complete at 'done'.
// =============================================================================

const ONE_HOUR_NS = 60 * 60 * 1e9;

const rank = (rows, job, n) =>
  topZones(rows.map((r) => scoreZoneRow(r, job.progressRows, job.subjectHrid, job.monsters, job.items)), n);

export function useZoneFinder() {
  const sweep = useAllZones();
  const { run, rows } = sweep;
  const [job, setJob] = useState(null);
  const [stage, setStage] = useState(null); // 'quick' | 'verify' | 'done'

  // job: { base: run params bar combos/hours, combos, progressRows, subjectHrid, variants, monsters, items }
  const start = useCallback((next) => {
    const pass = (combos, hours, onDone) =>
      run({ ...next.base, combos, hours, simulationTimeLimit: hours * ONE_HOUR_NS, onDone });
    setJob(next);
    setStage('quick');
    pass(next.combos, QUICK_HOURS, (quick) => {
      setStage('verify');
      const finalists = rank(quick, next, FINALISTS)
        .map(({ zoneHrid, difficultyTier, variant }) => ({ zoneHrid, difficultyTier, variant }));
      pass(finalists, VERIFY_HOURS, () => setStage('done'));
    });
  }, [run]);

  const top = useMemo(() => (stage === 'done' && job ? rank(rows, job, TOP_N) : []), [stage, job, rows]);
  return { ...sweep, job, stage, top, start };
}
