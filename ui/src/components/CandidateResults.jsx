import { Alert, Badge, Button, Group, Stack, Table, Text, Title } from '@mantine/core';
import { formatPct, formatSignedPct } from '../utils/equipmentOptimizer';
import { ClearResultsButton, NumTd, VerdictBadge } from './ResultParts';

// =============================================================================
// CandidateResults — a rankCandidates result (api/lib/equipmentScan/scan.js):
// what the member wears now, then every alternative best first, each with its
// paired delta, p-value, verdict and an Apply. Shared by Loadout and Abilities.
// =============================================================================

const COLUMNS = {
  zone: [
    ['effectiveEncountersPerHour', 'Effective EPH'],
    ['encountersPerHour', 'EPH'],
    ['deathsPerHour', 'Deaths/h']
  ],
  dungeon: [
    ['effectiveCompletionsPerHour', 'Effective runs/h'],
    ['completionsPerHour', 'Runs/h'],
    ['deathsPerHour', 'Deaths/h']
  ],
  labyrinth: [
    ['clearRatePercent', 'Clear %'],
    ['clearsPerHour', 'Clears/h'],
    ['roomDeathsPerHour', 'Deaths/h']
  ]
};

const OBJECTIVE_NAMES = {
  effectiveEncountersPerHour: 'effective EPH',
  encountersPerHour: 'EPH',
  effectiveCompletionsPerHour: 'effective completed runs per hour',
  completionsPerHour: 'completed runs per hour',
  clearRatePercent: 'clear rate'
};

const fmt = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');
const formatP = (p) => (p == null || !Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));
const formatDelta = (row) => (row.deltaPct == null
  ? fmt(row.delta)
  : `${formatSignedPct(row.deltaPct, 2)} ±${formatPct(row.marginPct, 2)}`);

export function CandidateResults({ results, title, currentLabel, applyLabel = 'Apply', onApply, onClear }) {
  const target = results.target || {};
  const kind = target.kind === 'labyrinth' ? 'labyrinth' : target.dungeon ? 'dungeon' : 'zone';
  const columns = COLUMNS[kind];
  const rows = results.rows || [];
  const objectiveName = OBJECTIVE_NAMES[results.objective] || results.objective;
  const best = rows.find((row) => row.significantFamilywise && row.delta > 0);

  let headline;
  if (results.saturated) {
    const ceiling = results.saturated === 'ceiling';
    headline = (
      <Alert color="grape" variant="light" p="xs"
        title={ceiling ? 'Every attempt already clears' : kind === 'dungeon' ? 'No run ever completes' : 'No attempt ever clears'}>
        <Text size="xs">
          Every row ties, so nothing here can be ranked. Move the {kind === 'labyrinth' ? 'room level' : 'tier'}{' '}
          {ceiling ? 'up' : 'down'} until the outcome is in doubt.
        </Text>
      </Alert>
    );
  } else if (best) {
    headline = (
      <Alert color="teal" variant="light" p="xs" title={`Best: ${best.label}`}>
        <Text size="xs">
          {formatDelta(best)} {objectiveName} against the current setup, beyond noise even allowing for{' '}
          {results.familySize} comparison{results.familySize === 1 ? '' : 's'}.
        </Text>
      </Alert>
    );
  } else {
    headline = (
      <Alert color="gray" variant="light" p="xs" title="Nothing beats the current setup beyond noise">
        <Text size="xs">Raise the replicates or the simulated hours to narrow the error bars.</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap="xs">
          <Title order={4}>{title}</Title>
          <Badge variant="light">{results.simulationsRun} simulations</Badge>
          <Badge variant="light" color="gray">{results.replicates} × {results.hours} h</Badge>
        </Group>
        <ClearResultsButton onClear={onClear} />
      </Group>

      {headline}

      <Text size="xs" c="dimmed">
        Ranked on {objectiveName}. Δ is against the current setup on the same seeds; ± is the 95% interval (Student-t).
        {kind === 'zone' && !results.consumableCostsKnown
          ? ' No production times were loaded, so effective EPH equals EPH.'
          : ''}
      </Text>

      <Table.ScrollContainer minWidth={640}>
        <Table striped highlightOnHover fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Candidate</Table.Th>
              {columns.map(([key, label]) => <Table.Th key={key} ta="right">{label}</Table.Th>)}
              <Table.Th ta="right">Δ</Table.Th>
              <Table.Th ta="right">p</Table.Th>
              <Table.Th>Verdict</Table.Th>
              {onApply && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>—</Table.Td>
              <Table.Td fw={600}>{currentLabel}</Table.Td>
              {columns.map(([key]) => <NumTd key={key}>{fmt(results.baseline?.metrics?.[key])}</NumTd>)}
              <NumTd>—</NumTd>
              <NumTd>—</NumTd>
              <Table.Td>—</Table.Td>
              {onApply && <Table.Td />}
            </Table.Tr>
            {rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td>{row.rank}</Table.Td>
                <Table.Td>{row.label}</Table.Td>
                {columns.map(([key]) => <NumTd key={key}>{fmt(row.metrics?.[key])}</NumTd>)}
                <NumTd>{formatDelta(row)}</NumTd>
                <NumTd>{formatP(row.statistics?.pValue)}</NumTd>
                <Table.Td><VerdictBadge row={row} /></Table.Td>
                {onApply && (
                  <Table.Td>
                    <Button size="compact-xs" variant="light" onClick={() => onApply(row)}>{applyLabel}</Button>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      {results.steps?.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" fw={600}>Search path</Text>
          {results.steps.map((step, i) => (
            <Text key={i} size="xs" c="dimmed">
              Pass {step.pass} · {step.label}: best of {step.tried} was {step.best} ({formatSignedPct(step.deltaPct, 2)})
              {step.taken ? ' — taken' : ''}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
