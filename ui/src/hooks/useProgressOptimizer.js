// useProgressOptimizer — drives the backend progress scan. The transport and
// state live in useOptimizerRun, shared with the other optimiser tools.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-progress', kind: 'progressOpt', name: 'The progress scan' };

export function useProgressOptimizer() {
  return useOptimizerRun(OPTIONS);
}
