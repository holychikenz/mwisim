// useEquipmentOptimizer — drives the backend equipment enhancement scan. The
// transport and state live in useOptimizerRun, shared with the trigger search.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-equipment', kind: 'equipOpt', name: 'The equipment scan' };

export function useEquipmentOptimizer() {
  return useOptimizerRun(OPTIONS);
}
