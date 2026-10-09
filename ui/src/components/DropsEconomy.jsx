import { useMemo } from 'react';
import { Alert, Badge, Button, Group, Select, SimpleGrid, Stack, Switch, Table, Text } from '@mantine/core';
import { DropsTable } from './DropsTable';
import { nameOf } from '../utils/names';
import { NumTd, Section, StatGroup } from './ResultParts';
import { usePersistentState, isBool } from '../hooks/usePersistentState';
import { calculateExpectedDrops, calculateDropsPerHour } from '../utils/drops';
import { priceOf, formatValue } from '../utils/prices';
import { convertDropsToCredits } from '../utils/guildCredits';

const ONE_HOUR = 60 * 60 * 1e9;

// =============================================================================
// DropsEconomy — the Drops tab: price-source controls, the drops/income
// table, the consumable expense table, and the profit line. Ported from the
// old UI's Get Prices / Edit Prices / expenses flow.
//
// ONE PLAYER, NEVER THE PARTY SUMMED. Every figure here — drops, income,
// consumable expenses, profit — answers for `focusHrid`, the member whose
// config is open in the left panel's P-tab, and follows that tab immediately
// without a re-run. This is not cosmetic: chance-to-drop is modified per
// character by combatDropRate / combatRareFind (magnetic gloves, lucky coffee,
// necklace of efficiency), so two members of the same party walk away from the
// same kills with materially different loot. Summing them would report a
// composite nobody plays.
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

function ExpensesTable({ rows, unit, playerName }) {
  if (rows.length === 0) {
    return <Text size="sm" c="dimmed">No consumables used by {playerName}.</Text>;
  }
  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Consumable</Table.Th>
          <Table.Th ta="right">Used</Table.Th>
          <Table.Th ta="right">Per Hour</Table.Th>
          <Table.Th ta="right">Unit Cost</Table.Th>
          <Table.Th ta="right">Total Cost</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.hrid}>
            <Table.Td>{r.name}</Table.Td>
            <NumTd faded={!r.count}>{r.count}</NumTd>
            <NumTd faded={!r.perHour}>{r.perHour.toFixed(2)}</NumTd>
            <NumTd faded={!(r.price > 0)}>{r.price > 0 ? formatValue(r.price, unit) : '—'}</NumTd>
            <NumTd faded={!(r.price > 0)}>{r.price > 0 ? formatValue(r.total, unit) : '—'}</NumTd>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function DropsEconomy({ results, monsters, items, pricing, focusHrid, playerNames }) {
  const {
    source, setSource, prices, unit, fetching, error, fetchedLabel, fetchPrices,
    revenueMode, setRevenueMode, expenseMode, setExpenseMode,
    ironCharacter, setIronCharacter, characters
  } = pricing;

  const hours = results.simulatedTime / ONE_HOUR;

  // The party as SIMULATED, not as currently ticked — dropRateMultiplier carries
  // one entry per player the run actually included (see simResult
  // setDropRateMultipliers). The checkboxes may have moved since.
  const partyHrids = useMemo(() => {
    const keys = Object.keys(results.dropRateMultiplier || {});
    keys.sort((a, b) => (parseInt(a.slice(6), 10) || 0) - (parseInt(b.slice(6), 10) || 0));
    return keys;
  }, [results.dropRateMultiplier]);

  // The P-tab can point at a player who was not in the run — the user editing P4
  // while the simulated party was [P1, P2]. Rather than print a table of a
  // never-simulated build's default multipliers, fall back to the first member
  // actually simulated and say so.
  const focusMissing =
    !!focusHrid && partyHrids.length > 0 && !partyHrids.includes(focusHrid);
  const activeHrid = focusMissing ? partyHrids[0] : focusHrid || partyHrids[0] || 'player1';
  // The party member's name where the run's slot has one, else "P1".
  const activeLabel = nameOf(activeHrid, { playerNames });

  // Income: expected drops priced by the active source.
  const drops = useMemo(() => {
    if (!results || !monsters || !items) return [];
    const expected = calculateExpectedDrops(results, monsters, items, activeHrid);
    const priced = expected.map((d) => ({
      ...d,
      sellPrice: prices ? priceOf(prices, d.itemHrid, revenueMode) : d.sellPrice
    }));
    priced.sort((a, b) => (b.amount * b.sellPrice) - (a.amount * a.sellPrice));
    return calculateDropsPerHour(priced, results.simulatedTime);
  }, [results, monsters, items, prices, revenueMode, activeHrid]);

  const income = drops.reduce((s, d) => s + d.amount * d.sellPrice, 0);

  // Guild credit conversion: re-express the same loot table as the guild
  // credits it would donate for, taking the highest-tier option wherever an
  // item offers several. Purely a view over `drops` — it changes nothing about
  // the simulation or the coin economy below.
  const [creditMode, setCreditMode] = usePersistentState('csim_ui_drops_credit_mode', false, isBool);
  const credits = useMemo(
    () => (creditMode ? convertDropsToCredits(drops, items) : null),
    [creditMode, drops, items]
  );

  // Expenses: the focused player's consumables at the expense-mode price.
  const expenseRows = useMemo(() => {
    const used = results.consumablesUsed?.[activeHrid] || {};
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
  }, [results.consumablesUsed, prices, expenseMode, items, hours, activeHrid]);

  const expenseTotal = expenseRows.reduce((s, r) => s + r.total, 0);
  const profit = income - expenseTotal;

  return (
    <Stack gap="sm">
      <Section title="Pricing">
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
      </Section>

      {error && (
        <Alert color="red" variant="light">
          Price fetch failed: {error.message}
          {source === 'iron' ? ' — is the cow webapp running on port 12345?' : ''}
        </Alert>
      )}

      {focusMissing && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">
            {nameOf(focusHrid, { playerNames })} was not in the simulated party (
            {partyHrids.map(h => nameOf(h, { playerNames })).join(', ')}), so these figures read{' '}
            {activeLabel}. Tick {nameOf(focusHrid, { playerNames })} into the party and run
            again to see that build's loot.
          </Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
        <StatGroup
          title={`Economy · ${activeLabel}`}
          kpis={[
            {
              lead: true,
              label: 'Profit/hr',
              value: formatValue(profit / hours, unit),
              color: profit >= 0 ? 'teal' : 'red',
              hint: `unit: ${unit === 'seconds' ? 'time-to-acquire' : 'coins'}`
            },
            { label: 'Income/hr', value: formatValue(income / hours, unit) },
            { label: 'Expenses/hr', value: formatValue(expenseTotal / hours, unit) }
          ]}
        />
        {creditMode && (
          <Section title="Guild credits/hr">
            {credits.totals.length === 0 ? (
              <Text size="sm" c="dimmed">
                None of this loot converts into guild credits.
              </Text>
            ) : (
              credits.totals.map((t) => (
                <Group key={t.creditItemHrid} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" c="dimmed">{t.name}/hr</Text>
                  <Text size="sm" fw={600}>
                    {t.perHour >= 1000
                      ? (t.perHour / 1000).toFixed(2) + 'K'
                      : t.perHour.toFixed(2)}
                  </Text>
                </Group>
              ))
            )}
            <Text size="xs" c="dimmed">
              {credits.convertedCount} of {credits.convertedCount + credits.unconvertedCount} drops
              convert · highest tier taken where several are offered
            </Text>
          </Section>
        )}
      </SimpleGrid>

      <DropsTable
        drops={creditMode ? credits.rows : drops}
        unit={unit}
        creditMode={creditMode}
      />

      <Section title={`Consumable expenses (${activeLabel})`}>
        <ExpensesTable rows={expenseRows} unit={unit} playerName={activeLabel} />
      </Section>
    </Stack>
  );
}
