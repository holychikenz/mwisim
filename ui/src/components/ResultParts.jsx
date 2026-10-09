import { Fragment } from 'react';
import { Group, Paper, Progress, Stack, Table, Text, Title, Tooltip } from '@mantine/core';

// =============================================================================
// ResultParts — the shared building blocks of every result view, so all modes
// read alike: grouped stat cards, sectioned tables, right-aligned tabular
// numbers, faded zeros (.num-faded) and sand share bars. Components only.
// =============================================================================

// A tooltip only where a number needs a caveat attached — chiefly the
// effective rate, which is meaningless without knowing what was priced.
function withTip(tip, node) {
  if (!tip) return node;
  return (
    <Tooltip label={tip} withArrow multiline w={280} position="bottom">
      {node}
    </Tooltip>
  );
}

// A summary card (e.g. Run · Pace · Outcome). The lead figure is shown large;
// every other figure keeps its own labelled row beneath it.
export function StatGroup({ title, kpis }) {
  if (kpis.length === 0) return null;
  const lead = kpis.find(k => k.lead) || kpis[0];
  const rest = kpis.filter(k => k !== lead);
  return (
    <Paper p="sm" radius="md" withBorder>
      <Stack gap={6}>
        <Title order={6}>{title}</Title>
        {withTip(lead.tip, (
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>{lead.label}</Text>
            <Text fz={22} fw={700} lh={1.2} c={lead.color}>{lead.value}</Text>
            {lead.hint && <Text size="xs" c="dimmed">{lead.hint}</Text>}
          </div>
        ))}
        {/* Keyed on the Fragment: withTip may wrap the row in a Tooltip, which
            would otherwise hide the row's key from the list. */}
        {rest.map(k => <Fragment key={k.label}>{withTip(k.tip, (
          <div>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" c="dimmed">{k.label}</Text>
              <Text size="sm" fw={600} c={k.color}>{k.value}</Text>
            </Group>
            {k.hint && <Text size="xs" c="dimmed" ta="right">{k.hint}</Text>}
          </div>
        ))}</Fragment>)}
      </Stack>
    </Paper>
  );
}

// One stand-alone figure, styled like StatGroup's lead.
export function StatCard({ label, value, hint, tip, color }) {
  return withTip(tip, (
    <Paper p="sm" radius="md" withBorder>
      <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>{label}</Text>
      <Text fz={22} fw={700} lh={1.2} c={color}>{value}</Text>
      {hint && <Text size="xs" c="dimmed">{hint}</Text>}
    </Paper>
  ));
}

// A numeric table cell: right-aligned, never wrapped; zeros fade.
export function NumTd({ faded, strong, children, style, ...rest }) {
  return (
    <Table.Td
      ta="right"
      className={faded ? 'num-faded' : undefined}
      fw={strong ? 600 : undefined}
      style={{ whiteSpace: 'nowrap', ...style }}
      {...rest}
    >
      {children}
    </Table.Td>
  );
}

// A share of a whole (0..1) as a sand bar with its percentage.
export function ShareBar({ value, color = 'sand', w }) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  return (
    <Group gap="sm" wrap="nowrap" w={w}>
      <Progress value={pct} color={color} size="sm" style={{ flex: 1 }} />
      <Text size="sm" w={56} ta="right">{pct.toFixed(1)}%</Text>
    </Group>
  );
}

// A titled paper around one table or block of a result view.
export function Section({ title, right, children }) {
  return (
    <Paper p="sm" radius="md" withBorder>
      <Stack gap="xs">
        {(title || right) && (
          <Group justify="space-between" wrap="wrap" gap="xs">
            {title && <Text size="sm" fw={600}>{title}</Text>}
            {right}
          </Group>
        )}
        {children}
      </Stack>
    </Paper>
  );
}
