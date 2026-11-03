// useTriggerOptimizer — drives the backend trigger-threshold search. The
// transport and state live in useOptimizerRun, shared with the equipment scan.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-triggers', kind: 'triggerOpt', name: 'The optimiser' };

export function useTriggerOptimizer() {
  return useOptimizerRun(OPTIONS);
}
