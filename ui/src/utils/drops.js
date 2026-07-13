/**
 * Calculate expected drops from simulation results
 * This is the "average" (no RNG) calculation
 */
export function calculateExpectedDrops(simResult, monsters, items, playerHrid = 'player1') {
  if (!simResult || !monsters || !simResult.deaths) {
    return [];
  }

  const dropRateMultiplier = simResult.dropRateMultiplier?.[playerHrid] || 1;
  const rareFindMultiplier = simResult.rareFindMultiplier?.[playerHrid] || 1;
  const combatDropQuantity = simResult.combatDropQuantity?.[playerHrid] || 0;
  const debuffOnLevelGap = simResult.debuffOnLevelGap?.[playerHrid] || 0;
  const numberOfPlayers = simResult.numberOfPlayers || 1;
  const difficultyTier = simResult.difficultyTier || 0;

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

        // Calculate effective drop rate
        let baseDropRate = drop.dropRate + (drop.dropRatePerDifficultyTier || 0) * difficultyTier;
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
