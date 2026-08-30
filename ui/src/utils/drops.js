/**
 * Calculate expected drops from simulation results
 * This is the "average" (no RNG) calculation
 *
 * Chance and quantity are two INDEPENDENT stats, and party size touches only one
 * of them:
 *
 *   chance to drop  - fixed. Every member rolls the full, undiluted rate on every
 *                     kill. Modified by combatDropRate / combatRareFind.
 *   drop quantity   - divided by the number of players. Modified by
 *                     combatDropQuantity.
 *
 * Since the expectation is chance x quantity, the divisor may sit on the product
 * below — but it belongs to the quantity alone, and must never be applied to a
 * chance (an RNG roll must test the undivided rate; see main.js calcDropMaps).
 *
 * All figures are what `playerHrid` alone receives, at that player's own stats.
 */
export function calculateExpectedDrops(simResult, monsters, items, playerHrid = 'player1') {
  if (!simResult || !monsters || !simResult.deaths) {
    return [];
  }

  const dropRateMultiplier = simResult.dropRateMultiplier?.[playerHrid] || 1;
  const rareFindMultiplier = simResult.rareFindMultiplier?.[playerHrid] || 1;
  const combatDropQuantity = simResult.combatDropQuantity?.[playerHrid] || 0;
  const debuffOnLevelGap = simResult.debuffOnLevelGap?.[playerHrid] || 0;
  const difficultyTier = simResult.difficultyTier || 0;
  const numberOfPlayers = simResult.numberOfPlayers || 1;

  const dropMap = new Map();

  // Iterate through all monsters that were killed
  for (const [monsterHrid, deathCount] of Object.entries(simResult.deaths)) {
    // Skip player deaths
    if (monsterHrid.startsWith('player')) continue;

    const monster = monsters[monsterHrid];
    if (!monster) continue;

    // Process regular drop table
    if (monster.dropTable) {
      for (const drop of monster.dropTable) {
        // Check difficulty tier requirement
        if (drop.minDifficultyTier && drop.minDifficultyTier > difficultyTier) {
          continue;
        }

        // Effective drop chance, in the same order as the classic path's
        // calcDropMaps — the order matters because of the 1.0 clamp.
        //
        // The COMMON table carries a difficulty-tier bonus of +10% of base per
        // tier ON TOP of dropRatePerDifficultyTier. Both are needed: a dark key
        // fragment is dropRate -0.02 + 0.04/tier, which at T5 gives 0.18, and
        // only the x1.5 tier factor brings it to the 0.27 the game reports. The
        // rare table below takes no such factor.
        const tierMultiplier = 1.0 + 0.1 * difficultyTier;
        let baseDropRate = Math.min(
          1.0,
          tierMultiplier * (drop.dropRate + (drop.dropRatePerDifficultyTier || 0) * difficultyTier)
        );
        if (baseDropRate <= 0) continue;

        const effectiveDropRate = Math.min(1.0, baseDropRate * dropRateMultiplier);
        const avgCount = (drop.minCount + drop.maxCount) / 2;
        const expectedAmount = deathCount * effectiveDropRate * avgCount *
                              (1 + debuffOnLevelGap) * (1 + combatDropQuantity) / numberOfPlayers;

        if (expectedAmount > 0) {
          const existing = dropMap.get(drop.itemHrid) || 0;
          dropMap.set(drop.itemHrid, existing + expectedAmount);
        }
      }
    }

    // Process rare drop table
    if (monster.rareDropTable) {
      for (const drop of monster.rareDropTable) {
        // Check difficulty tier requirement
        if (drop.minDifficultyTier && drop.minDifficultyTier > difficultyTier) {
          continue;
        }

        const effectiveDropRate = drop.dropRate * rareFindMultiplier;
        const avgCount = (drop.minCount + drop.maxCount) / 2;
        const expectedAmount = deathCount * effectiveDropRate * avgCount *
                              (1 + debuffOnLevelGap) * (1 + combatDropQuantity) / numberOfPlayers;

        if (expectedAmount > 0) {
          const existing = dropMap.get(drop.itemHrid) || 0;
          dropMap.set(drop.itemHrid, existing + expectedAmount);
        }
      }
    }
  }

  // Convert to array and add item names
  const drops = [];
  for (const [itemHrid, amount] of dropMap.entries()) {
    const item = items?.[itemHrid];
    drops.push({
      itemHrid,
      name: item?.name || itemHrid.split('/').pop(),
      amount,
      sellPrice: item?.sellPrice || 0
    });
  }

  // Sort by total value (amount * sellPrice) descending
  drops.sort((a, b) => (b.amount * b.sellPrice) - (a.amount * a.sellPrice));

  return drops;
}

/**
 * Calculate drops per hour
 */
export function calculateDropsPerHour(drops, simulatedTimeNs) {
  const ONE_HOUR = 60 * 60 * 1e9;
  const hours = simulatedTimeNs / ONE_HOUR;

  return drops.map(drop => ({
    ...drop,
    perHour: drop.amount / hours
  }));
}
