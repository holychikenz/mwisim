import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  VERDICT_LABELS,
  formatPct,
  formatSignedPct,
  verdictOf,
} from '../utils/equipmentOptimizer';
import { formatSeconds } from '../utils/triggerOptimizer';
import { useEnhancementCosts } from '../hooks/useEnhancementCosts';
import { breakEvenHours } from '../../../shared/enhancementRoi.js';

// =============================================================================
// EquipmentOptimizerResults — the ranked table of what a level is worth.
//
// The design problem here is not the ranking; it is stopping the ranking from
// being read as more certain than it is. Fourteen slots, each measured to within
// a few tenths of a percent, will always produce an order — and the top of that
// order is the only part anyone reads. So every row carries its own error bar
// next to its estimate rather than in a footnote, and the verdict column
// distinguishes "beat the noise" from "beat the noise even after allowing for
// having asked fourteen slots at once". Where nothing clears the bar the headline
// says so outright instead of presenting a confident ordering of accidents.
// =============================================================================

const METRIC_COLUMNS = [
  { key: 'effectiveEncountersPerHour', label: 'Effective enc/h', decimals: 2, costed: true },
  { key: 'encountersPerHour', label: 'Enc/h', decimals: 2 },
  { key: 'deathsPerHour', label: 'Deaths/h', decimals: 2 },
  { key: 'experiencePerHour', label: 'XP/h', decimals: 0 },
];

function formatNumber(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (Math.abs(number) >= 1e4) return `${(number / 1e3).toFixed(1)}K`;
  return number.toFixed(decimals);
}

function KpiCard({ label, value, hint }) {
  const body = (
    <Paper p="sm" radius="md" withBorder>
      <Text size="10px" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="lg" fw={700}>
        {value}
      </Text>
    </Paper>
  );
  return hint ? (
    <Tooltip label={hint} withArrow multiline w={280}>
      {body}
    </Tooltip>
  ) : (
    body
  );
}

const VERDICT_STYLE = {
  'strong-gain': { color: 'teal', variant: 'filled' },
  gain: { color: 'teal', variant: 'light' },
  'strong-loss': { color: 'red', variant: 'filled' },
  loss: { color: 'red', variant: 'light' },
  noise: { color: 'gray', variant: 'outline' },
  unknown: { color: 'gray', variant: 'outline' },
};

function VerdictBadge({ row }) {
  const verdict = verdictOf(row);
  const style = VERDICT_STYLE[verdict] || VERDICT_STYLE.unknown;
  return (
    <Badge size="xs" color={style.color} variant={style.variant}>
      {VERDICT_LABELS[verdict]}
    </Badge>
  );
}

/** "9.4 h" / "3.1 days" — a grinding horizon, not a production time. */
function formatHours(hours) {
  if (hours == null || !Number.isFinite(hours)) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * Return on investment: what the level costs against what it buys.
 *
 * Both sides are seconds, so the answer is a TIME rather than a ratio — the
 * number of combat hours before an enhancement has repaid the time spent making
 * it. That ordering can invert the ranking by gain completely, which is the whole
 * reason it is worth computing: the biggest gain is frequently the worst
 * investment, because the items that gain most are the ones already deep enough
 * into the enhancement curve to be ruinous to push further.
 */
function ReturnOnInvestment({ rows, baselineRate, objective, costed }) {
  const { costs, loading, progress, error, fetchCosts } = useEnhancementCosts();

  const ranked = useMemo(() => {
    if (!costs) return null;
    return rows
      .map((row) => {
        const cost = costs[row.id];
        const hours = breakEvenHours({
          costSeconds: cost?.seconds,
          baselineRate,
          gainPerHour: row.perLevel,
        });
        return { row, cost, hours };
      })
      // Unrepayable and uncostable rows sort last, but are still shown: "this
      // never pays back" is a result, and hiding it would leave the reader
      // wondering whether it had simply been forgotten.
      .sort((a, b) => {
        if (a.hours == null && b.hours == null) return a.row.rank - b.row.rank;
        if (a.hours == null) return 1;
        if (b.hours == null) return -1;
        return a.hours - b.hours;
      });
  }, [costs, rows, baselineRate]);

  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" mb={6}>
        <Text size="sm" fw={600}>
          Return on investment
        </Text>
        <Button
          size="compact-xs"
          variant="default"
          loading={loading}
          onClick={() => fetchCosts(rows)}
        >
          {costs ? 'Refetch costs' : 'Cost these levels'}
        </Button>
      </Group>

      {!costs && !loading && !error && (
        <Text size="xs" c="dimmed">
          Asks the cow webapp&apos;s enhancement simulator what each next level costs, in
          production seconds, and works out how long you must fight before it pays for itself.
          Requires the cow webapp on port 12345.
        </Text>
      )}

      {loading && progress && (
        <Text size="xs" c="dimmed">
          Costing {progress.done} of {progress.total}…
        </Text>
      )}

      {error && (
        <Alert color="orange" variant="light" p="xs">
          <Text size="xs">{error.message}</Text>
        </Alert>
      )}

      {!costed && costs && (
        <Alert color="yellow" variant="light" p="xs" mb={6}>
          <Text size="xs">
            Gains are raw encounters per hour, but costs are production seconds. Load Iron
            production times and rerun the scan so both sides are denominated in the same currency.
          </Text>
        </Alert>
      )}

      {ranked && (
        <>
          <Table.ScrollContainer minWidth={640}>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Slot</Table.Th>
                  <Table.Th>Item</Table.Th>
                  <Table.Th ta="right">Next</Table.Th>
                  <Table.Th ta="right">Costs</Table.Th>
                  <Table.Th ta="right">Buys</Table.Th>
                  <Table.Th ta="right">Pays back after</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ranked.map(({ row, cost, hours }) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>{row.slotName}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {row.itemName}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      +{row.currentLevel + 1}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {cost?.seconds != null ? (
                        formatSeconds(cost.seconds)
                      ) : (
                        <Tooltip label={cost?.reason || 'no costing available'} withArrow multiline w={260}>
                          <Text span size="xs" c="dimmed">
                            unknown
                          </Text>
                        </Tooltip>
                      )}
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      ff="monospace"
                      c={row.perLevel > 0 ? 'teal' : row.perLevel < 0 ? 'red' : undefined}
                    >
                      {formatSignedPct(row.perLevelPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={hours == null ? 400 : 700}>
                      {hours == null ? (
                        <Text span size="xs" c="dimmed">
                          never
                        </Text>
                      ) : (
                        formatHours(hours)
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Text size="10px" c="dimmed" mt={8}>
            Costs are the cheapest expected programme to reach the next level, in production
            seconds, minimised over where you start protecting — the item&apos;s own acquisition
            price appears on both sides of the difference and cancels. Pay-back is the combat time
            at which the enhancement has repaid the time it cost:{' '}
            <Text span ff="monospace">
              (cost / 3600) × {objective === 'effectiveEncountersPerHour' ? 'effective rate' : 'rate'}{' '}
              ÷ gain
            </Text>
            . Rows that never repay are those whose measured gain was zero or negative.
          </Text>
        </>
      )}
    </Paper>
  );
}

export function EquipmentOptimizerResults({ results }) {
  const rows = Array.isArray(results?.rows) ? results.rows : null;

  const columns = useMemo(
    () => METRIC_COLUMNS.filter((column) => !column.costed || results?.consumableCostsKnown),
    [results?.consumableCostsKnown]
  );

  // What this run could actually resolve. The median margin rather than the best
  // or the worst: it is the figure that answers "would a gain of X have shown up
  // here?" for a typical slot, which is what a reader wants before concluding
  // that a slot is not worth enhancing.
  const detectionFloor = useMemo(() => {
    if (!rows?.length) return null;
    const margins = rows
      .map((row) => row.perLevelMarginPct)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (!margins.length) return null;
    return margins[Math.floor(margins.length / 2)];
  }, [rows]);

  if (!rows) return null;

  const {
    baseline,
    noise,
    objective,
    hours,
    replicates,
    step,
    simulationsRun,
    inconclusive,
    pairingEfficiency,
    skipped = [],
  } = results;

  const costed = !!results.consumableCostsKnown;
  const leader = rows[0];
  const anyCaveat = rows.some((row) => row.caveat);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={4}>Equipment Optimizer</Title>
        <Group gap={6}>
          <Badge variant="light">{simulationsRun} simulations</Badge>
          <Badge variant="light">
            {replicates} × {hours}h
          </Badge>
          <Badge variant="light">probed at +{step}</Badge>
        </Group>
      </Group>

      {inconclusive ? (
        <Alert color="gray" variant="light" title="Nothing clears the measurement noise">
          <Text size="sm">
            At {replicates} replicates of {hours} simulated hours, no slot&apos;s gain could be
            distinguished from run-to-run variance. Raise the replicates or the hours — or accept
            that on this zone, at this build, an enhancement level is worth less than the noise.
          </Text>
        </Alert>
      ) : (
        <Alert color="teal" variant="light" title={`Best next level: ${leader.slotName}`}>
          <Text size="sm">
            One more level on <b>{leader.itemName}</b> (currently +{leader.currentLevel}) is worth{' '}
            <b>{formatSignedPct(leader.perLevelPct)}</b> of{' '}
            {costed ? 'effective encounters per hour' : 'encounters per hour'}, ±
            {formatPct(leader.perLevelMarginPct, 3)} at 95% confidence.
          </Text>
        </Alert>
      )}

      {!costed && (
        <Alert color="yellow" variant="light" title="The food bill is not counted">
          <Text size="xs">
            Ranking is on raw encounters per hour. Load Iron production times to rank on effective
            encounters per hour instead, which counts the time owed for every consumable burned.
          </Text>
        </Alert>
      )}

      {anyCaveat && (
        <Alert color="orange" variant="light" title="One or more rows carry a caveat">
          <Stack gap={2}>
            {rows
              .filter((row) => row.caveat)
              .map((row) => (
                <Text size="xs" key={row.id}>
                  <b>{row.slotName}</b> — {row.caveat}
                </Text>
              ))}
          </Stack>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <KpiCard
          label={costed ? 'Baseline effective enc/h' : 'Baseline enc/h'}
          value={formatNumber(baseline?.metrics?.[objective], 2)}
          hint={`The unmodified build, averaged over ${replicates} runs of ${hours} simulated hours.`}
        />
        <KpiCard
          label="Best per +1"
          value={inconclusive ? '—' : formatSignedPct(leader.perLevelPct)}
          hint="Measured over the full probe, then divided by the probe size. The multiplier table is convex, so this slightly flatters the next single level."
        />
        <KpiCard
          label="Detection floor"
          value={detectionFloor == null ? '—' : `±${formatPct(detectionFloor, 3)}`}
          hint="The typical 95% margin per level on this run. A gain smaller than this could not have been told from noise, whatever the ranking says."
        />
        <KpiCard
          label="Run-to-run noise"
          value={noise?.calibrated ? formatPct(noise.coefficientOfVariation, 3) : '—'}
          hint={
            `Coefficient of variation of the baseline across ${noise?.samples ?? 0} runs at ${hours}h. ` +
            (pairingEfficiency == null
              ? ''
              : `Sharing seeds between baseline and variant removed ${formatPct(pairingEfficiency, 1)} of the comparison variance.`)
          }
        />
      </SimpleGrid>

      <Paper p="sm" radius="md" withBorder>
        <Text size="sm" fw={600} mb={6}>
          Every slot, ranked
        </Text>
        <Table.ScrollContainer minWidth={760}>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Slot</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th ta="right">Level</Table.Th>
                <Table.Th ta="right">Per +1</Table.Th>
                <Table.Th ta="right">±95%</Table.Th>
                <Table.Th>Verdict</Table.Th>
                {columns.map((column) => (
                  <Table.Th key={column.key} ta="right">
                    {column.label}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>{row.rank}</Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Text size="sm">{row.slotName}</Text>
                      {row.caveat && (
                        <Tooltip label={row.caveat} withArrow multiline w={260}>
                          <Text size="xs" c="orange">
                            ⚠
                          </Text>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {row.itemName}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    +{row.currentLevel}
                    {row.step !== row.requestedStep && (
                      <Tooltip
                        label={`Probed only +${row.step}: the cap is +20.`}
                        withArrow
                        multiline
                        w={200}
                      >
                        <Text span size="10px" c="dimmed">
                          {' '}
                          (+{row.step})
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td
                    ta="right"
                    ff="monospace"
                    fw={row.significant ? 700 : 400}
                    c={row.significant ? (row.perLevel >= 0 ? 'teal' : 'red') : undefined}
                  >
                    {formatSignedPct(row.perLevelPct)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" c="dimmed">
                    {formatPct(row.perLevelMarginPct, 3)}
                  </Table.Td>
                  <Table.Td>
                    <VerdictBadge row={row} />
                  </Table.Td>
                  {columns.map((column) => (
                    <Table.Td key={column.key} ta="right" ff="monospace">
                      {formatNumber(row.metrics?.[column.key], column.decimals)}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>

        <Text size="10px" c="dimmed" mt={8}>
          Each slot was raised {step} levels and the measured gain divided by {step}, so the figures
          assume the response is locally linear. The enhancement multiplier table is convex, so a
          probe of six buys somewhat more per level than the next single level will —
          {' '}
          {leader?.multiplierRatio
            ? `about ${leader.multiplierRatio.toFixed(2)}× for the leading row.`
            : 'see each row for its own ratio.'}
        </Text>
      </Paper>

      <ReturnOnInvestment
        rows={rows}
        baselineRate={Number(baseline?.metrics?.[objective]) || 0}
        objective={objective}
        costed={costed}
      />

      {skipped.length > 0 && (
        <Paper p="sm" radius="md" withBorder>
          <Text size="sm" fw={600} mb={6}>
            Not probed ({skipped.length})
          </Text>
          <Stack gap={2}>
            {skipped.map((row) => (
              <Group key={row.id} gap={6} justify="space-between">
                <Text size="xs">
                  {row.slotName} · {row.itemName}
                </Text>
                <Text size="xs" c="dimmed">
                  {row.reason}
                </Text>
              </Group>
            ))}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
