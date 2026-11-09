// useSwapOptimizer — drives the backend swap search. The transport and
// state live in useOptimizerRun, shared with the other optimiser tools.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-swaps', kind: 'swapOpt', name: 'The swap search' };

export function useSwapOptimizer() {
  return useOptimizerRun(OPTIONS);
}
