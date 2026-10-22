// audit-12 — the marginal cost of a level subtracts two totals priced under the
// SAME protection plan. The lower total used to take the solver's own cheapest
// plan, which can differ from the one the level-up was costed with.
import test from 'node:test';
import assert from 'node:assert/strict';

const { fetchMarginalCost } = await import('../../ui/src/utils/enhancementCosts.js');

// +3 → +4. Cheapest plan for +4 protects from 3 (900); for +3 alone it protects
// from 2 (500), but under the +4 plan (protect at 3) +3 costs 600.
const ROWS = {
  4: [{ protect_at: 2, total_cost: 1000 }, { protect_at: 3, total_cost: 900 }],
  3: [{ protect_at: 2, total_cost: 500 }, { protect_at: 3, total_cost: 600 }],
};

test('audit-12: both totals of a marginal cost use the level-up\'s protection plan', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { target } = JSON.parse(init.body);
    return { ok: true, json: async () => ({ rows: ROWS[target], base_price: 0 }) };
  };
  try {
    const result = await fetchMarginalCost({ itemHrid: '/items/x', currentLevel: 3, config: {} });
    assert.equal(result.protectAt, 3);
    assert.equal(result.seconds, 300);
  } finally {
    globalThis.fetch = real;
  }
});
