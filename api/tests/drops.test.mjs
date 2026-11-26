// =============================================================================
// shared/drops.js above tier 0 (audit-17): the +10%/tier factor, the per-tier
// rate, the 1.0 cap, the minimum tier and the rare table, which takes no tier factor.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateExpectedDrops } from '../../shared/drops.js';

test('T5: tier factor, per-tier rate, the 1.0 cap and the rare table', () => {
  const monsters = {
    '/monsters/m': {
      dropTable: [
        { itemHrid: '/items/dark_key_fragment', dropRate: -0.02, dropRatePerDifficultyTier: 0.04, minCount: 1, maxCount: 1 },
        { itemHrid: '/items/sugar', dropRate: 0.8, minCount: 2, maxCount: 4 }, // 1.5 x 0.8 = 1.2, capped at 1
        { itemHrid: '/items/gated', dropRate: 1, minDifficultyTier: 6, minCount: 1, maxCount: 1 },
      ],
      rareDropTable: [{ itemHrid: '/items/rare', dropRate: 0.001, minCount: 1, maxCount: 1 }],
    },
  };
  const run = {
    deaths: { '/monsters/m': 1000 }, difficultyTier: 5, numberOfPlayers: 1,
    dropRateMultiplier: { player1: 1 }, rareFindMultiplier: { player1: 1.2 }, combatDropQuantity: {}, debuffOnLevelGap: {},
  };
  const got = Object.fromEntries(calculateExpectedDrops(run, monsters, null).map((d) => [d.itemHrid, d.amount]));
  assert.ok(Math.abs(got['/items/dark_key_fragment'] - 270) < 1e-9, `${got['/items/dark_key_fragment']}`); // 0.27 per kill, as the game reports
  assert.equal(got['/items/sugar'], 3000);
  assert.equal('/items/gated' in got, false);
  assert.ok(Math.abs(got['/items/rare'] - 1.2) < 1e-9, `${got['/items/rare']}`);
});
