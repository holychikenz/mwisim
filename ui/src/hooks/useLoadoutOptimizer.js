// useLoadoutOptimizer — drives the backend loadout comparison. The transport and
// state live in useOptimizerRun, shared with the other optimiser tools.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-loadout', kind: 'loadoutOpt', name: 'The loadout comparison' };

export function useLoadoutOptimizer() {
  return useOptimizerRun(OPTIONS);
}
