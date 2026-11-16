// audit-12 — the marginal cost of a level subtracts two totals priced under the
// SAME protection plan. The lower total used to take the solver's own cheapest
// plan, which can differ from the one the level-up was costed with.
import test from 'node:test';
import assert from 'node:assert/strict';

const { fetchMarginalCost, costScanRows } = await import('../../ui/src/utils/enhancementCosts.js');

// +3 → +4. Cheapest plan for +4 protects from 3 (900); for +3 alone it protects
// from 2 (500), but under the +4 plan (protect at 3) +3 costs 600.
const ROWS = {
  4: [{ protect_at: 2, total_cost: 1000 }, { protect_at: 3, total_cost: 900 }],
  3: [{ protect_at: 2, total_cost: 500 }, { protect_at: 3, total_cost: 600 }],
};

// The enhancement simulator, answering from ROWS.
const engine = (onCall) => ({
  calculate: async ({ target }) => {
    onCall?.();
    return { rows: ROWS[target], base_price: 0 };
  },
});

test('audit-12: both totals of a marginal cost use the level-up\'s protection plan', async () => {
  const result = await fetchMarginalCost({ itemHrid: '/items/x', currentLevel: 3, config: {}, engine: engine() });
  assert.equal(result.protectAt, 3);
  assert.equal(result.seconds, 300);
});

test('audit3-h: a scan stopped mid-request reports no progress afterwards', async () => {
  const controller = new AbortController();
  const progress = [];
  // the user presses Stop while this row is in flight
  await costScanRows([{ id: 'a', itemHrid: '/items/x', currentLevel: 3 }], {}, {
    engine: engine(() => controller.abort()),
    signal: controller.signal,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(progress, []);
});

test('an engine error is the row\'s reason, including at +0', async () => {
  const failing = { calculate: async () => { throw new Error('unknown item_hrid'); } };
  for (const currentLevel of [0, 3]) {
    const result = await fetchMarginalCost({ itemHrid: '/items/x', currentLevel, config: {}, engine: failing });
    assert.equal(result.seconds, null);
    assert.match(result.reason, /unknown item_hrid/);
  }
});
