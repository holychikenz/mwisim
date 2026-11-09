// useAbilityOptimizer — drives the backend ability search. The transport and
// state live in useOptimizerRun, shared with the other optimiser tools.
import { useOptimizerRun } from './useOptimizerRun.js';

const OPTIONS = { endpoint: '/api/optimize-abilities', kind: 'abilityOpt', name: 'The ability search' };

export function useAbilityOptimizer() {
  return useOptimizerRun(OPTIONS);
}
