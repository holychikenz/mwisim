import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Select, Stack, Switch, Table, Text } from '@mantine/core';
import { DropsTable } from './DropsTable';
import { calculateExpectedDrops, calculateDropsPerHour } from '../utils/drops';
import { priceOf, formatValue } from '../utils/prices';
import { convertDropsToCredits } from '../utils/guildCredits';

const ONE_HOUR = 60 * 60 * 1e9;

// =============================================================================
// DropsEconomy — the Drops tab: price-source controls, the drops/income
// table, the consumable expense table, and the profit line. Ported from the
// old UI's Get Prices / Edit Prices / expenses flow.
//
// Economy numbers are computed for player1 (matching the old UI's
// per-displayed-player convention).
// =============================================================================

const SOURCE_OPTIONS = [
  { value: 'vendor', label: 'Vendor prices (offline)' },
  { value: 'market', label: 'Market (live)' },
  { value: 'iron', label: 'Iron time-value (cow webapp)' }
];

const MODE_OPTIONS = [
  { value: 'bid', label: 'Bid first' },
  { value: 'ask', label: 'Ask first' }
];

function ExpensesTable({ rows, unit }) {
  if (rows.length === 0) {
    return <Text size="sm" c="dimmed">No consumables used by player1.</Text>;
  }
  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Consumable</Table.Th>
          <Table.Th>Used</Table.Th>
          <Table.Th>Per Hour</Table.Th>
          <Table.Th>Unit Cost</Table.Th>
          <Table.Th>Total Cost</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.hrid}>
            <Table.Td>{r.name}</Table.Td>
            <Table.Td>{r.count}</Table.Td>
            <Table.Td>{r.perHour.toFixed(2)}</Table.Td>
            <Table.Td>{r.price > 0 ? formatValue(r.price, unit) : '-'}</Table.Td>
            <Table.Td>{r.price > 0 ? formatValue(r.total, unit) : '-'}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function DropsEconomy({ results, monsters, items, pricing }) {
  const {
    source, setSource, prices, unit, fetching, error, fetchedLabel, fetchPrices,
    revenueMode, setRevenueMode, expenseMode, setExpenseMode,
    ironCharacter, setIronCharacter, characters
  } = pricing;

  const hours = results.simulatedTime / ONE_HOUR;

  // Income: expected drops priced by the active source.
  const drops = useMemo(() => {
    if (!results || !monsters || !items) return [];
    const expected = calculateExpectedDrops(results, monsters, items, 'player1');
    const priced = expected.map((d) => ({
      ...d,
      sellPrice: prices ? priceOf(prices, d.itemHrid, revenueMode) : d.sellPrice
    }));
    priced.sort((a, b) => (b.amount * b.sellPrice) - (a.amount * a.sellPrice));
    return calculateDropsPerHour(priced, results.simulatedTime);
  }, [results, monsters, items, prices, revenueMode]);

  const income = drops.reduce((s, d) => s + d.amount * d.sellPrice, 0);

  // Guild credit conversion: re-express the same loot table as the guild
  // credits it would donate for, taking the highest-tier option wherever an
  // item offers several. Purely a view over `drops` — it changes nothing about
  // the simulation or the coin economy below.
  const [creditMode, setCreditMode] = useState(false);
  const credits = useMemo(
    () => (creditMode ? convertDropsToCredits(drops, items) : null),
    [creditMode, drops, items]
  );

  // Expenses: player1's consumables at the expense-mode price.
  const expenseRows = useMemo(() => {
    const used = results.consumablesUsed?.player1 || {};
    return Object.entries(used)
      .map(([hrid, count]) => {
        const price = prices
          ? priceOf(prices, hrid, expenseMode)
          : (items?.[hrid]?.sellPrice || 0);
        return {
          hrid,
          name: items?.[hrid]?.name || hrid.split('/').pop(),
          count,
          perHour: count / hours,
          price,
          total: count * price
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [results.consumablesUsed, prices, expenseMode, items, hours]);

  const expenseTotal = expenseRows.reduce((s, r) => s + r.total, 0);
  const profit = income - expenseTotal;

  return (
    <Stack gap="md">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          label="Price source"
          data={SOURCE_OPTIONS}
          value={source}
          onChange={(v) => v && setSource(v)}
          allowDeselect={false}
          size="xs"
          w={210}
        />
        {source === 'iron' && (
          <Select
            label="Character"
            data={characters}
            value={ironCharacter}
            onChange={setIronCharacter}
            placeholder={characters.length ? 'Character…' : 'webapp offline'}
            size="xs"
            w={150}
            searchable
            disabled={characters.length === 0}
          />
        )}
        {source === 'market' && (
          <>
            <Select
              label="Revenue"
              data={MODE_OPTIONS}
              value={revenueMode}
              onChange={(v) => v && setRevenueMode(v)}
              allowDeselect={false}
              size="xs"
              w={110}
            />
            <Select
              label="Expenses"
              data={MODE_OPTIONS}
              value={expenseMode}
              onChange={(v) => v && setExpenseMode(v)}
              allowDeselect={false}
              size="xs"
              w={110}
            />
          </>
        )}
        {source !== 'vendor' && (
          <Button size="xs" variant="light" onClick={fetchPrices} loading={fetching}>
            Fetch prices
          </Button>
        )}
        {fetchedLabel && (
          <Badge variant="light" color="teal" size="sm">{fetchedLabel}</Badge>
        )}
        <Switch
          label="Guild credits"
          description="Show loot as guild credit conversion"
          size="xs"
          checked={creditMode}
          onChange={(e) => setCreditMode(e.currentTarget.checked)}
        />
      </Group>

      {error && (
        <Alert color="red" variant="light">
          Price fetch failed: {error.message}
          {source === 'iron' ? ' — is the cow webapp running on port 12345?' : ''}
        </Alert>
      )}

      <Paper p="sm" radius="md" withBorder>
        <Group gap="xl">
          <div>
            <Text size="xs" c="dimmed" tt="uppercase">Income/hr (P1)</Text>
            <Text fw={700}>{formatValue(income / hours, unit)}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" tt="uppercase">Expenses/hr (P1)</Text>
            <Text fw={700}>{formatValue(expenseTotal / hours, unit)}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" tt="uppercase">Profit/hr (P1)</Text>
            <Text fw={700} c={profit >= 0 ? 'teal' : 'red'}>
              {formatValue(profit / hours, unit)}
            </Text>
          </div>
          <Text size="xs" c="dimmed" style={{ alignSelf: 'flex-end' }}>
            unit: {unit === 'seconds' ? 'time-to-acquire' : 'coins'}
          </Text>
        </Group>
      </Paper>

      {creditMode && (
        <Paper p="sm" radius="md" withBorder>
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Group gap="xl" wrap="wrap">
              {credits.totals.length === 0 ? (
                <Text size="sm" c="dimmed">
                  None of this loot converts into guild credits.
                </Text>
              ) : (
                credits.totals.map((t) => (
                  <div key={t.creditItemHrid}>
                    <Text size="xs" c="dimmed" tt="uppercase">{t.name}/hr</Text>
                    <Text fw={700}>
                      {t.perHour >= 1000
                        ? (t.perHour / 1000).toFixed(2) + 'K'
                        : t.perHour.toFixed(2)}
                    </Text>
                  </div>
                ))
              )}
            </Group>
            <Text size="xs" c="dimmed" style={{ alignSelf: 'flex-end' }}>
              {credits.convertedCount} of {credits.convertedCount + credits.unconvertedCount} drops
              convert · highest tier taken where several are offered
            </Text>
          </Group>
        </Paper>
      )}

      <DropsTable
        drops={creditMode ? credits.rows : drops}
        unit={unit}
        creditMode={creditMode}
      />

      <div>
        <Text size="sm" fw={600} mb={6}>Consumable expenses (P1)</Text>
        <ExpensesTable rows={expenseRows} unit={unit} />
      </div>
    </Stack>
  );
}
