import { Alert, Badge, Group, Paper, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { formatBand, formatSeconds } from '../utils/triggerOptimizer';

// =============================================================================
// TriggerOptimizerResults — the ranked outcome of a threshold search.
//
// Modelled on GuildTrialResults' "DPS by build" table, with one addition that is
// the whole point of the view: every row states whether its margin over the
// baseline actually exceeds the measured noise.
//
// Without that, a table showing "+0.42%" reads as a finding. On a hard zone the
// run-to-run standard deviation of encounters/hour at 24 simulated hours is
// around 3%, so +0.42% is nothing at all — and a tool that presents it as an
// improvement is worse than one that says nothing, because it will be believed.
// =============================================================================

/**
 * `costed` columns appear only when production times were supplied. Showing an
 * "effective" rate identical to the raw one would imply the food bill had been
 * accounted for when it had not.
 */
const METRIC_COLUMNS = [
  { key: 'effectiveEncountersPerHour', label: 'Effective enc/h', decimals: 2, costed: true },
  { key: 'encountersPerHour', label: 'Enc/h', decimals: 2 },
  { key: 'consumablesPerHour', label: 'Eaten/h', decimals: 1 },
  { key: 'deathsPerHour', label: 'Deaths/h', decimals: 2 },
  { key: 'experiencePerHour', label: 'XP/h', decimals: 0 },
  { key: 'damagePerSecond', label: 'DPS', decimals: 1 },
];

function formatNumber(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (Math.abs(number) >= 1e4) return `${(number / 1e3).toFixed(1)}K`;
  return number.toFixed(decimals);
}

function formatPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(2)}%`;
}

function lastSegment(hrid) {
  if (!hrid) return '';
  return String(hrid).split('/').pop().replace(/_/g, ' ');
}

function KpiCard({ label, value, hint }) {
  const card = (
    <Paper p="sm" radius="md" withBorder>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="lg" fw={700}>
        {value}
      </Text>
    </Paper>
  );
  return hint ? (
    <Tooltip label={hint} withArrow multiline w={280}>
      {card}
    </Tooltip>
  ) : (
    card
  );
}

/** Badge describing what a row actually is. */
function RowBadge({ row }) {
  if (row.isBaseline) {
    return (
      <Badge size="sm" variant="light" color="gray">
        Current
      </Badge>
    );
  }
  if (row.significant) {
    const better = (row.marginPct ?? 0) > 0;
    return (
      <Badge size="sm" variant="filled" color={better ? 'teal' : 'red'}>
        {better ? 'Real gain' : 'Real loss'}
      </Badge>
    );
  }
  return (
    <Tooltip label="This difference is smaller than the run-to-run noise. Treat it as no change." withArrow>
      <Badge size="sm" variant="outline" color="gray">
        Within noise
      </Badge>
    </Tooltip>
  );
}

/** The recommended thresholds, laid out for typing back into the game. */
function Recommendation({ row }) {
  if (!row) return null;
  const changed = row.triggers.filter((trigger) => trigger.changed);

  return (
    <Paper p="sm" radius="md" withBorder>
      <Stack gap={6}>
        <Text size="sm" fw={600}>
          {row.isBaseline ? 'Your current thresholds' : 'Recommended thresholds'}
        </Text>

        {!row.isBaseline && changed.length === 0 && (
          <Text size="xs" c="dimmed">
            No value differs from what you already have.
          </Text>
        )}

        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Slot</Table.Th>
              <Table.Th>Condition</Table.Th>
              <Table.Th ta="right">Value</Table.Th>
              <Table.Th ta="right">Was</Table.Th>
              <Table.Th>Equivalent range</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {row.triggers.map((trigger) => {
              const band = formatBand(trigger.insensitiveValues);
              return (
                <Table.Tr key={`${trigger.slotKind}-${trigger.slotIndex}-${trigger.triggerIndex}`}>
                  <Table.Td>
                    <Text size="xs" fw={600}>
                      {lastSegment(trigger.slotHrid)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {trigger.slotKind}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {trigger.dependencyName} {trigger.conditionName} {trigger.comparatorName}
                    </Text>
                    {/* A dead trigger is a finding in its own right, and no amount
                        of threshold searching will rescue it in this zone. */}
                    {trigger.unreachable && (
                      <Text size="xs" c="orange">
                        Never fires here — this zone never reaches {trigger.initialValue}
                        {trigger.kind === 'percentage' ? '%' : ''} (max {trigger.maxValue})
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    <Text size="sm" fw={trigger.changed ? 700 : 400} c={trigger.changed ? 'teal' : undefined}>
                      {trigger.value}
                      {trigger.kind === 'percentage' ? '%' : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" c="dimmed">
                    {trigger.changed ? trigger.initialValue : '—'}
                  </Table.Td>
                  <Table.Td>
                    {/* The most useful single output of the whole search: a bare
                        number invites false precision, a range does not. */}
                    {band ? (
                      <Text size="xs" c="dimmed" ff="monospace">
                        {band}
                        {trigger.kind === 'percentage' ? '%' : ''}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    </Paper>
  );
}

export function TriggerOptimizerResults({ results }) {
  if (!results || !Array.isArray(results.rows)) return null;

  const { rows, noise, epsilons, screening, verifyHours, simulationsRun, inconclusive, objective } = results;
  const leader = rows[0];
  const cvPct = noise?.calibrated ? noise.coefficientOfVariation * 100 : null;
  const costed = !!results.consumableCostsKnown;
  const columns = METRIC_COLUMNS.filter((column) => !column.costed || costed);
  const consumableSeconds = leader?.metrics?.consumableSecondsPerHour || 0;
  const timeShare = leader?.metrics?.consumableTimeShare || 0;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <Title order={4}>Trigger Optimizer</Title>
        <Group gap="xs">
          <Badge variant="light">{simulationsRun} simulations</Badge>
          <Badge variant="light">verified at {verifyHours}h</Badge>
        </Group>
      </Group>

      {/* The headline judgement, before any numbers that might be over-read. */}
      {inconclusive ? (
        <Alert color="gray" variant="light" title="No change worth making">
          <Text size="sm">
            Nothing beat your current thresholds by more than the measurement noise. That is a real answer, not
            a failure: your triggers are already at or near the best this search can distinguish.
          </Text>
          {cvPct != null && (
            <Text size="xs" c="dimmed" mt={6}>
              Run-to-run spread for this build and zone was {cvPct.toFixed(2)}% at {noise.measuredAtHours}h over{' '}
              {noise.samples} runs. A candidate had to beat the baseline by more than{' '}
              {(epsilons.significanceBar * 100).toFixed(2)}% at {verifyHours}h to count.
            </Text>
          )}
        </Alert>
      ) : (
        <Alert color="teal" variant="light" title="A better threshold set was found">
          <Text size="sm">
            {leader?.changedCount} of {leader?.triggers.length} threshold
            {leader?.triggers.length === 1 ? '' : 's'} changed, worth {formatPct(leader?.marginPct)} on{' '}
            {objective === 'encountersPerHour' ? 'encounters per hour' : objective}.
          </Text>
        </Alert>
      )}

      {!noise?.calibrated && (
        <Alert color="yellow" variant="light" title="Noise was not measured">
          <Text size="xs">
            Calibration was disabled, so ranking used a fixed 0.1% threshold. Measured run-to-run spread on a
            hard zone is around fifty times that, which means small differences in this table may be noise. Set
            the calibration runs above 1 for a trustworthy ranking.
          </Text>
        </Alert>
      )}

      {!costed && rows.some((row) => (row.metrics?.consumablesPerHour || 0) > 0) && (
        <Alert color="yellow" variant="light" title="Food and drink cost is not counted">
          <Text size="xs">
            No production times were supplied, so the ranking is on raw throughput and cannot see what eating
            costs. Where thresholds are indistinguishable it still prefers the configuration that eats less, but
            it will trade food for a fraction of a percent of throughput if it can. Switch the price source to
            Iron for a costed ranking.
          </Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <KpiCard
          label={costed ? 'Effective enc/h' : 'Best enc/h'}
          value={formatNumber(
            costed ? leader?.metrics?.effectiveEncountersPerHour : leader?.metrics?.encountersPerHour
          )}
          hint={
            costed
              ? 'Encounters per hour of TOTAL time — combat plus the production time owed for everything consumed. The real ironcow rate.'
              : 'Encounters per hour of combat time, measured at the verification fidelity. Does not account for consumable production.'
          }
        />
        <KpiCard
          label="Vs current"
          value={leader?.isBaseline ? '—' : formatPct(leader?.marginPct)}
          hint="Change against your existing thresholds, both re-simulated on the same pinned seed."
        />
        <KpiCard
          label="Noise floor"
          value={cvPct == null ? 'not measured' : `${cvPct.toFixed(2)}%`}
          hint="Standard deviation of the objective across repeat runs of the same build on different seeds. Differences smaller than this mean nothing."
        />
        {costed ? (
          <KpiCard
            label="Time on cooking"
            value={`${(timeShare * 100).toFixed(1)}%`}
            hint={`${formatSeconds(consumableSeconds)} of production owed per hour of combat, for ${formatNumber(leader?.metrics?.consumablesPerHour, 1)} consumables. This is real time you do not spend fighting.`}
          />
        ) : (
          <KpiCard
            label="Candidates kept"
            value={`${screening?.initial ?? '—'} → ${screening?.coarse ?? '—'} → ${screening?.final ?? '—'}`}
            hint="Values surviving screening, then combinations after the beam search, then finalists verified."
          />
        )}
      </SimpleGrid>

      <Recommendation row={leader} />

      <Paper p="sm" radius="md" withBorder>
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            All finalists
          </Text>
          <Table.ScrollContainer minWidth={620}>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>#</Table.Th>
                  <Table.Th>Verdict</Table.Th>
                  {columns.map((column) => (
                    <Table.Th key={column.key} ta="right">
                      {column.label}
                    </Table.Th>
                  ))}
                  <Table.Th ta="right">Δ vs current</Table.Th>
                  <Table.Th ta="right">Changed</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td fw={600}>{row.rank}</Table.Td>
                    <Table.Td>
                      <RowBadge row={row} />
                    </Table.Td>
                    {columns.map((column) => (
                      <Table.Td key={column.key} ta="right" ff="monospace">
                        {formatNumber(row.metrics?.[column.key], column.decimals)}
                      </Table.Td>
                    ))}
                    <Table.Td ta="right" ff="monospace">
                      {row.isBaseline ? '—' : formatPct(row.marginPct)}
                    </Table.Td>
                    <Table.Td ta="right">{row.changedCount}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {rows.some((row) => row.metrics?.ranOutOfMana) && (
            <Text size="xs" c="orange">
              At least one configuration ran out of mana during the run. A mana threshold that starves the
              build can still score well on encounters per hour — check the recommended values before adopting
              them.
            </Text>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
