import { Button, Paper, SegmentedControl, Stack, Text } from '@mantine/core';
import { Select } from './SearchSelect';
import { formatAge, formatSeconds } from '../utils/triggerOptimizer';

// =============================================================================
// ConsumableCostSource — the price-source card shared by the Gear, Loadout and
// Abilities panels. Only the Iron source yields production time in seconds,
// and only seconds are commensurable with combat time: without it a tool ranks
// on raw throughput and cannot see the food bill at all.
// =============================================================================

export function ConsumableCostSource({ pricing, loading, consumableCostRows = [] }) {
  const overrideCount = consumableCostRows.filter((row) => row.override != null).length;
  return (
    <Paper p="xs" radius="sm" withBorder>
      <Stack gap={6}>
        <Text size="xs" fw={600}>
          Consumable cost
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          value={pricing.source}
          onChange={pricing.setSource}
          disabled={loading}
          data={[
            { value: 'vendor', label: 'None' },
            { value: 'market', label: 'Coins' },
            { value: 'iron', label: 'Iron time' },
          ]}
        />
        {pricing.source === 'iron' && (
          <>
            <Select
              size="xs"
              placeholder="Character"
              data={[
                ...new Set(
                  [...(pricing.characters || []), pricing.ironCharacter].filter(Boolean)
                ),
              ].map((name) => ({ value: name, label: name }))}
              value={pricing.ironCharacter}
              onChange={pricing.setIronCharacter}
              disabled={loading}
              searchable
            />
            <Button
              variant="default"
              size="compact-xs"
              loading={pricing.fetching}
              onClick={pricing.fetchPrices}
              disabled={loading}
            >
              {pricing.fetchedLabel ? 'Refetch production times' : 'Fetch production times'}
            </Button>
            {pricing.fetchedLabel && (
              <Text size="xs" c="dimmed">
                {pricing.fetchedLabel}
                {formatAge(pricing.fetchedAt) ? ` · cached ${formatAge(pricing.fetchedAt)}` : ''}
              </Text>
            )}
            {overrideCount > 0 && (
              <Text size="10px" c="dimmed">
                {overrideCount} per-item override{overrideCount === 1 ? '' : 's'} in effect
                {consumableCostRows.length
                  ? ` (${consumableCostRows
                      .filter((row) => row.override != null)
                      .map((row) => formatSeconds(row.effective))
                      .join(', ')})`
                  : ''}
                . Edit them on the Triggers tab.
              </Text>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
