import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { COST_ROLES, describeBuildCosts, searchItemCosts } from '../utils/itemCosts';
import { formatAge, formatSeconds } from '../utils/triggerOptimizer';
import { PROTECTION_PRICING } from '../../../shared/enhancementRoi.js';

// =============================================================================
// ItemCostsView — hand-set production times, in seconds, for any item.
//
// This exists because the fetched times have a hole in them, and the hole is
// invisible. The cow webapp's value map simply OMITS anything its production
// walker cannot resolve — a drop-only material, an item with no recipe — and
// every consumer downstream reads an omission as zero. A Chaotic Chain, the
// protection item for a Chaotic Flail, is absent; so is Sinister Essence, of
// which an attempt consumes eighteen. The result was a marginal enhancement cost
// 182 times too small, presented with a straight face.
//
// So the tab opens on the items this build actually depends on, unpriced ones
// first, rather than on a search box. A search box is only useful to somebody who
// already knows what to type, and the whole difficulty is that they cannot: the
// items that silently cost nothing are exactly the ones nothing ever names.
//
// A value entered here overrides the fetched time EVERYWHERE — consumable
// economics, enhancement costing, and drop valuation alike — because it is a fact
// about the player's situation and the fetched figure is only ever an estimate of
// the same thing.
// =============================================================================

/** One editable row. */
function CostRow({ row, disabled, onChange }) {
  const overridden = row.override != null;
  const unpriced = row.effective == null;

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={overridden ? 600 : 400}>
            {row.name}
          </Text>
          {unpriced && (
            <Tooltip
              label="No production time known, and no override. This counts as ZERO everywhere it is used."
              withArrow
              multiline
              w={260}
            >
              <Badge size="xs" color="orange" variant="light">
                unpriced
              </Badge>
            </Tooltip>
          )}
        </Group>
        {row.usedBy?.length > 0 && (
          <Text size="10px" c="dimmed">
            {row.usedBy.join(', ')}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap={4}>
          {(row.roles || []).map((role) => (
            <Badge key={role} size="xs" variant="outline" color="gray">
              {COST_ROLES[role] || role}
            </Badge>
          ))}
        </Group>
      </Table.Td>
      <Table.Td ta="right">
        <Text
          size="xs"
          c="dimmed"
          ff="monospace"
          style={{ textDecoration: overridden ? 'line-through' : 'none' }}
        >
          {row.fetched != null ? formatSeconds(row.fetched) : '—'}
        </Text>
      </Table.Td>
      <Table.Td>
        <NumberInput
          size="xs"
          w={120}
          min={0}
          hideControls
          placeholder={row.fetched != null ? 'fetched' : 'unknown'}
          value={row.override ?? ''}
          // Passed through raw: usePrices is the only sanitiser, and it treats ''
          // and anything not a finite non-negative number as "no override", so a
          // half-typed value falls back to the fetched time until it parses.
          onChange={(value) => onChange(row.hrid, value)}
          disabled={disabled}
          aria-label={`Time cost for ${row.name}, seconds per unit`}
        />
      </Table.Td>
      <Table.Td ta="right" ff="monospace" fw={overridden ? 700 : 400}>
        {row.effective != null ? formatSeconds(row.effective) : <Text span c="orange">0s</Text>}
      </Table.Td>
      <Table.Td>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          disabled={disabled || !overridden}
          onClick={() => onChange(row.hrid, null)}
          aria-label={`Clear time cost for ${row.name}`}
        >
          ↺
        </ActionIcon>
      </Table.Td>
    </Table.Tr>
  );
}

function CostTable({ rows, disabled, onChange, empty }) {
  if (!rows.length) {
    return (
      <Text size="xs" c="dimmed" p="xs">
        {empty}
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={680}>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th>Used for</Table.Th>
            <Table.Th ta="right">Fetched</Table.Th>
            <Table.Th>Your time (s)</Table.Th>
            <Table.Th ta="right">Effective</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <CostRow key={row.hrid} row={row} disabled={disabled} onChange={onChange} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function ItemCostsView({ playerDTOs, gameItems, pricing, protectionPricing }) {
  const [query, setQuery] = useState('');

  const buildRows = useMemo(
    () => describeBuildCosts(playerDTOs, gameItems, pricing, { protectionPricing }),
    [playerDTOs, gameItems, pricing, protectionPricing]
  );

  const searchRows = useMemo(
    () => searchItemCosts(query, gameItems, pricing),
    [query, gameItems, pricing]
  );

  const unpricedCount = buildRows.filter((row) => row.effective == null).length;
  const overrideCount = Object.keys(pricing?.itemCostOverrides || {}).length;
  const isSeconds = pricing?.unit === 'seconds';

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={4}>Item time costs</Title>
        <Group gap={6}>
          {overrideCount > 0 && (
            <Badge variant="light">{overrideCount} set by hand</Badge>
          )}
          {unpricedCount > 0 && (
            <Badge variant="light" color="orange">
              {unpricedCount} unpriced
            </Badge>
          )}
        </Group>
      </Group>

      <Text size="sm" c="dimmed">
        What one unit of an item costs you, in seconds of production time. A value set here
        overrides the fetched time <b>everywhere</b> — consumable costs, enhancement costs and
        drop valuation alike. Blank uses the fetched time; <b>0</b> means it reaches you free.
        {protectionPricing === PROTECTION_PRICING.MIRROR && (
          <>
            {' '}
            The Gear tab is costing every protect as a <b>Philosopher&apos;s Mirror</b>, so only
            that one is listed as a protection — price it and every protect is covered.
          </>
        )}
        {protectionPricing === PROTECTION_PRICING.FREE && (
          <>
            {' '}
            The Gear tab is treating protections as <b>free</b>, so none is listed here — nothing
            would read the price.
          </>
        )}
      </Text>

      {/* The price source lives here as well as on the optimiser panels, because
          this is the tab a user will be on when they discover the times are
          wrong, and sending them elsewhere to switch source would be perverse. */}
      <Paper p="sm" radius="md" withBorder>
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm">
            <Text size="xs" fw={600}>
              Source
            </Text>
            <SegmentedControl
              size="xs"
              value={pricing.source}
              onChange={pricing.setSource}
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
                  w={160}
                  placeholder="Character"
                  data={[
                    ...new Set(
                      [...(pricing.characters || []), pricing.ironCharacter].filter(Boolean)
                    ),
                  ].map((name) => ({ value: name, label: name }))}
                  value={pricing.ironCharacter}
                  onChange={pricing.setIronCharacter}
                  searchable
                />
                <Button
                  variant="default"
                  size="compact-xs"
                  loading={pricing.fetching}
                  onClick={pricing.fetchPrices}
                >
                  {pricing.fetchedLabel ? 'Refetch' : 'Fetch times'}
                </Button>
                {pricing.fetchedLabel && (
                  <Text size="xs" c="dimmed">
                    {pricing.fetchedLabel}
                    {formatAge(pricing.fetchedAt) ? ` · ${formatAge(pricing.fetchedAt)}` : ''}
                  </Text>
                )}
              </>
            )}
          </Group>
          {overrideCount > 0 && (
            <Button
              variant="subtle"
              size="compact-xs"
              color="gray"
              onClick={pricing.clearItemCostOverrides}
            >
              Reset all {overrideCount}
            </Button>
          )}
        </Group>
      </Paper>

      {!isSeconds && (
        <Alert color="yellow" variant="light" title="Not denominated in time">
          <Text size="xs">
            The current source reports {pricing.source === 'vendor' ? 'nothing' : 'coins'}, which
            cannot be added to combat hours. Your hand-entered times are kept and will apply the
            moment you switch to <b>Iron time</b>, but nothing below shows a fetched figure until
            you do.
          </Text>
        </Alert>
      )}

      {unpricedCount > 0 && (
        <Alert color="orange" variant="light" title={`${unpricedCount} items have no time at all`}>
          <Text size="xs">
            These are counted as <b>zero</b> wherever they are used, which can only ever
            understate a cost. They are listed first below. Drop-only materials and protection
            items are the usual culprits — the production walker has no recipe to follow, so it
            returns nothing, and nothing reads as free.
          </Text>
        </Alert>
      )}

      <Paper p="sm" radius="md" withBorder>
        <Text size="sm" fw={600} mb={6}>
          Used by this build ({buildRows.length})
        </Text>
        <CostTable
          rows={buildRows}
          onChange={pricing.setItemCostOverride}
          empty="Nothing slotted or equipped yet — configure a party and these fill in."
        />
      </Paper>

      <Paper p="sm" radius="md" withBorder>
        <Group justify="space-between" mb={6}>
          <Text size="sm" fw={600}>
            Any other item
          </Text>
          {searchRows.length > 0 && (
            <Text size="10px" c="dimmed">
              showing {searchRows.length}
            </Text>
          )}
        </Group>
        <TextInput
          size="xs"
          placeholder="Search all items by name…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          mb={8}
        />
        <CostTable
          rows={searchRows}
          onChange={pricing.setItemCostOverride}
          empty={
            query.trim().length < 2
              ? 'Type at least two characters to search the full item list.'
              : 'No items match that search.'
          }
        />
      </Paper>
    </Stack>
  );
}
