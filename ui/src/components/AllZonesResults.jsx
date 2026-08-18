import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  Tooltip
} from '@mantine/core';
import { effectiveRatePerHour, summariseConsumableCost } from '../utils/consumableCosts';
import { formatSeconds } from '../utils/triggerOptimizer';

// =============================================================================
// AllZonesResults — one row per (zone, tier), ranked, for ONE player
//
// ONE PLAYER, NEVER THE PARTY SUMMED. `focusHrid` is whichever member the left
// panel's P-tab has selected, and every per-character column answers for that
// member alone. A party is five separate characters with five levelling curves,
// five food bills and five ways to die; adding their experience together ranks
// zones for a composite nobody plays, and the sum is dominated by whoever
// happens to be strongest. Switching the P-tab re-derives the table from rows
// already measured — the sweep does not have to run again.
//
// Enc/h and Clears/h stay as they are: the party fights an encounter together,
// so the count is the same number for every member rather than a shared total
// being divided up.
//
// The two columns the sweep exists for:
//
//   XP/hour       the selected player's experience across all their skills, per
//                 hour of COMBAT — the figure a levelling run is chasing.
//   Effective     the same rates per hour of TOTAL time: combat plus the
//   enc/h & XP/h  production owed for what THAT player ate. Raw throughput
//                 cannot see the food bill, and a zone that out-earns another by
//                 a few percent while eating twice as much is not, in fact,
//                 ahead. Only the iron (time-value) price source can answer
//                 that; on any other source these read "—" rather than being
//                 printed equal to the raw figure, which would say "your food is
//                 free" when it means "we have no idea".
//
// Rows arrive one at a time from the pool, so this renders whatever has landed —
// a sweep in progress is a table that grows, not a spinner.
// =============================================================================

/** 'player3' → 'P3'. Anything unrecognised is shown as it came. */
function playerLabel(hrid) {
  const match = /^player(\d+)$/.exec(String(hrid || ''));
  return match ? `P${match[1]}` : String(hrid || '');
}

function formatNumber(num, decimals = 2) {
  if (!Number.isFinite(num)) return '—';
  if (num >= 1000000) return (num / 1000000).toFixed(decimals) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}

const COLUMNS = [
  { key: 'zoneName', label: 'Zone', numeric: false },
  { key: 'difficultyTier', label: 'Tier', numeric: true },
  { key: 'encountersPerHour', label: 'Enc/h', numeric: true },
  { key: 'effEncountersPerHour', label: 'Effective enc/h', numeric: true, effective: true },
  { key: 'experiencePerHour', label: 'XP/h', numeric: true },
  { key: 'effExperiencePerHour', label: 'Effective XP/h', numeric: true, effective: true },
  { key: 'deathsPerHour', label: 'Deaths/h', numeric: true },
];

const DUNGEON_COLUMN = { key: 'clearsPerHour', label: 'Clears/h', numeric: true };

export function AllZonesResults({ rows, zones, pricing, meta, running, onOpenPicker, focusHrid }) {
  const [sort, setSort] = useState({ key: 'experiencePerHour', dir: 'desc' });

  // The party as SWEPT (meta), not as currently ticked — a sweep answers for the
  // characters it simulated, whatever the checkboxes say now.
  const partyHrids = useMemo(() => meta?.playerHrids || [], [meta]);

  // The left panel's P-tab moves independently of the party: a user may be
  // editing P4 while the swept party was [P1, P2]. Rather than empty every
  // per-character column — which reads as a broken table — fall back to the
  // first member actually swept and say so beneath the title.
  const focusMissing =
    !!focusHrid && partyHrids.length > 0 && !partyHrids.includes(focusHrid);
  const activeHrid = focusMissing ? partyHrids[0] : focusHrid || partyHrids[0] || null;

  const zoneNames = useMemo(() => {
    const map = {};
    for (const zone of zones || []) map[zone.hrid] = zone.name;
    return map;
  }, [zones]);

  const hasDungeon = useMemo(() => (rows || []).some(r => r.isDungeon), [rows]);
  const columns = useMemo(
    () => (hasDungeon ? [...COLUMNS, DUNGEON_COLUMN] : COLUMNS),
    [hasDungeon]
  );

  // usePrices returns a fresh object literal on every render, so depending on the
  // wrapper would recompute 78 cost summaries and a sort on every progress tick
  // of a running sweep — hundreds of times a second. Depend on the stable values
  // inside it instead (the same trick App.jsx uses for the optimiser payloads).
  const { fetchedPrices, prices, unit, expenseMode, itemCostOverrides } = pricing || {};
  const costBasis = useMemo(
    () => ({ fetchedPrices, prices, unit, expenseMode, itemCostOverrides }),
    [fetchedPrices, prices, unit, expenseMode, itemCostOverrides]
  );

  // One pass over the rows, re-run when prices change: the effective columns are
  // derived from whatever pricing is loaded NOW, not from what was loaded when
  // the sweep ran. Fetch your iron times after a sweep and the columns fill in.
  const metrics = useMemo(() => {
    return (rows || []).map(row => {
      const name = zoneNames[row.zoneHrid] || String(row.zoneHrid).split('/').pop();
      if (row.error) {
        return { ...row, zoneName: name, failed: true };
      }
      const hours = row.hours || 0;

      // Missing is zero, not unknown: the shard records a player only once they
      // gain experience or die, so an absent key means that member earned or
      // died nothing — which is a measurement, and a damning one.
      const experience = activeHrid ? Number(row.experienceByPlayer?.[activeHrid]) || 0 : 0;
      const deaths = activeHrid ? Number(row.deathsByPlayer?.[activeHrid]) || 0 : 0;

      // Encounters and dungeon clears are fought by the party as a unit — every
      // member lives through all of them — so they are already this player's
      // figures and are not divided.
      const encountersPerHour = hours > 0 ? row.encounters / hours : 0;
      const experiencePerHour = hours > 0 ? experience / hours : 0;
      const deathsPerHour = hours > 0 ? deaths / hours : 0;
      const clearsPerHour = hours > 0 ? (row.dungeonsCompleted || 0) / hours : 0;

      // This player's own plate. `consumablesUsed` is keyed by player, and each
      // character cooks their own supper — charging one member's production time
      // against another's throughput would be the party sum by another name.
      const eaten = activeHrid
        ? { [activeHrid]: row.consumablesUsed?.[activeHrid] || {} }
        : row.consumablesUsed;

      const cost = summariseConsumableCost({
        consumablesUsed: eaten,
        hours,
        pricing: costBasis,
      });

      return {
        ...row,
        zoneName: name,
        encountersPerHour,
        experiencePerHour,
        deathsPerHour,
        clearsPerHour,
        costKnown: cost.known,
        nothingConsumed: cost.nothingConsumed,
        timeShare: cost.timeShare,
        secondsPerHour: cost.secondsPerHour,
        effEncountersPerHour: cost.known
          ? effectiveRatePerHour(encountersPerHour, cost.secondsPerHour)
          : null,
        effExperiencePerHour: cost.known
          ? effectiveRatePerHour(experiencePerHour, cost.secondsPerHour)
          : null,
      };
    });
  }, [rows, zoneNames, costBasis, activeHrid]);

  // A sort can outlive its column: sort by Clears/h on a sweep that included
  // dungeons, re-run with planets only, and the column is gone while `sort` (component
  // state) still names it — every comparison would return 0 and the table would
  // silently fall back to worker arrival order with no header arrow to say so.
  const activeSort = useMemo(
    () => (columns.some(col => col.key === sort.key) ? sort : { key: 'experiencePerHour', dir: 'desc' }),
    [columns, sort]
  );

  const sorted = useMemo(() => {
    const list = [...metrics];
    const { key, dir } = activeSort;
    list.sort((a, b) => {
      // Failed combinations have no numbers to rank; they sink to the bottom
      // whichever way the column is sorted.
      if (a.failed !== b.failed) return a.failed ? 1 : -1;
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return dir === 'asc' ? cmp : -cmp;
      }
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return dir === 'asc' ? an - bn : bn - an;
    });
    return list;
  }, [metrics, activeSort]);

  // Best value per rate column, so the winner is visible without reading every
  // row — and stays visible when the table is sorted by something else.
  const best = useMemo(() => {
    const out = {};
    for (const col of columns) {
      if (!col.numeric || col.key === 'difficultyTier' || col.key === 'deathsPerHour') continue;
      let top = null;
      for (const row of metrics) {
        const value = row[col.key];
        if (!Number.isFinite(value)) continue;
        if (top == null || value > top) top = value;
      }
      out[col.key] = top;
    }
    return out;
  }, [metrics, columns]);

  const toggleSort = (key) => {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: key === 'zoneName' ? 'asc' : 'desc' }
    );
  };

  const exportCsv = () => {
    const header = columns.map(c => c.label).join(',');
    const body = sorted.map(row =>
      columns
        .map(col => {
          const value = row[col.key];
          if (row.failed && col.numeric && col.key !== 'difficultyTier') return '';
          if (typeof value === 'string') return `"${value.replace(/"/g, '""')}"`;
          return Number.isFinite(value) ? value.toFixed(4) : '';
        })
        .join(',')
    );
    const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // The player is part of what the file MEANS: two exports of the same sweep
    // for two party members are different tables with identical columns.
    link.download = activeHrid
      ? `csim-all-zones-${playerLabel(activeHrid)}.csv`
      : 'csim-all-zones.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const anyCosted = metrics.some(r => r.costKnown);
  const elapsed =
    meta?.startedAt && meta?.finishedAt ? (meta.finishedAt - meta.startedAt) / 1000 : null;

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end">
        <div>
          <Group gap={8} align="center">
            <Title order={4}>All Zones</Title>
            {activeHrid && (
              <Tooltip
                label={`XP/h and Deaths/h are ${playerLabel(activeHrid)} alone — party figures are never added together. Enc/h and Clears/h are fought by the whole party, so they are this player's too. Switch the P-tab on the left to read another member.`}
                withArrow
                multiline
                w={280}
              >
                <Badge size="sm" variant="light" color="blue" style={{ cursor: 'help' }}>
                  {playerLabel(activeHrid)}
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {meta ? `${metrics.length}/${meta.total} combinations · ${meta.hours} h each` : ''}
            {meta?.workers ? ` · ${meta.workers} workers` : ''}
            {elapsed != null ? ` · finished in ${formatSeconds(elapsed)}` : ''}
            {meta?.cancelled ? ' · stopped early' : ''}
          </Text>
        </div>
        <Group gap="xs">
          {running && <Badge color="indigo" variant="light">running</Badge>}
          {onOpenPicker && (
            <Button size="xs" variant="default" onClick={onOpenPicker}>
              Change selection
            </Button>
          )}
          <Button size="xs" variant="default" onClick={exportCsv} disabled={metrics.length === 0}>
            Export CSV
          </Button>
        </Group>
      </Group>

      {focusMissing && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">
            {playerLabel(focusHrid)} was not in the swept party (
            {partyHrids.map(playerLabel).join(', ')}), so this table reads{' '}
            {playerLabel(activeHrid)}. Tick {playerLabel(focusHrid)} into the party
            and run the sweep again to rank zones for that build.
          </Text>
        </Alert>
      )}

      {!anyCosted && metrics.length > 0 && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">
            Effective rates are blank because nothing consumed could be priced in
            TIME. They need the iron (time-value) price source — fetch it in a
            single-zone run&apos;s Drops tab, then this table fills in without
            re-running the sweep.
          </Text>
        </Alert>
      )}

      <ScrollArea type="hover">
        <Table striped highlightOnHover withTableBorder stickyHeader>
          <Table.Thead>
            <Table.Tr>
              {columns.map(col => (
                <Table.Th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                  title="Sort by this column"
                >
                  {col.label}
                  {activeSort.key === col.key ? (activeSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map(row => (
              <Table.Tr key={`${row.zoneHrid}#${row.difficultyTier}`}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm">{row.zoneName}</Text>
                    {row.isDungeon && (
                      <Badge size="xs" variant="light" color="grape">
                        dungeon
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>T{row.difficultyTier}</Table.Td>
                {row.failed ? (
                  <Table.Td colSpan={columns.length - 2}>
                    <Text size="xs" c="red">
                      {row.error}
                    </Text>
                  </Table.Td>
                ) : (
                  columns.slice(2).map(col => {
                    const value = row[col.key];
                    const isBest = best[col.key] != null && value === best[col.key] && value > 0;
                    const cell = (
                      <Text
                        size="sm"
                        fw={isBest ? 700 : 400}
                        c={isBest ? 'teal' : undefined}
                      >
                        {value == null ? '—' : formatNumber(value)}
                      </Text>
                    );
                    return (
                      <Table.Td key={col.key}>
                        {col.effective && row.costKnown ? (
                          <Tooltip
                            label={
                              row.nothingConsumed
                                ? 'Nothing consumed here — no production time owed, so this equals the raw rate'
                                : `${(row.timeShare * 100).toFixed(0)}% of total time cooking — ${formatSeconds(
                                    row.secondsPerHour
                                  )} of production per combat hour`
                            }
                            withArrow
                          >
                            {cell}
                          </Tooltip>
                        ) : (
                          cell
                        )}
                      </Table.Td>
                    );
                  })
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>

      {metrics.length === 0 && (
        <Paper p="md" withBorder radius="md">
          <Text size="sm" c="dimmed">
            {running ? 'Waiting for the first zone to finish…' : 'No results yet.'}
          </Text>
        </Paper>
      )}
    </Stack>
  );
}
