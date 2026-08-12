import { useMemo } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  DEFAULT_EQUIPMENT_OPT_CONFIG,
  estimateSeconds,
  formatDuration,
} from '../utils/equipmentOptimizer';
import { formatAge, formatSeconds } from '../utils/triggerOptimizer';

// =============================================================================
// EquipmentOptimizerPanel — navbar view for the Equipment Optimizer mode.
//
// Presentational plus callbacks; every piece of state lives in App, following
// GuildTrialPanel and TriggerOptimizerPanel.
//
// The consumable-cost block below is deliberately a near-twin of the trigger
// panel's rather than a shared component. What must never diverge is the
// ARITHMETIC — which item costs what, and whether a 0 means free or unknown —
// and that already lives in one place (utils/consumableCosts.js over
// shared/consumableCost.js). The chrome around it is presentation, and factoring
// presentation out of a working 600-line panel to save a Select and a Button is
// a poor trade in risk. It is here at all because the results pane, which
// normally carries the price source, is not rendered in this mode.
// =============================================================================

/** One equipment row: a checkbox when it can be probed, a dimmed reason when not. */
function SlotRow({ row, checked, disabled, onToggle }) {
  const level = `+${row.currentLevel}`;

  if (!row.scannable) {
    return (
      <Tooltip label={row.reason} withArrow position="right" multiline w={240}>
        <Paper p={6} radius="sm" withBorder style={{ opacity: 0.55 }}>
          <Group gap={6} wrap="nowrap" justify="space-between">
            <Text size="xs" truncate>
              {row.slotName} · {row.itemName}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {level}
            </Text>
          </Group>
          <Text size="10px" c="dimmed" mt={2}>
            {row.reason}
          </Text>
        </Paper>
      </Tooltip>
    );
  }

  return (
    <Paper p={6} radius="sm" withBorder>
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Checkbox
          size="xs"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(row)}
          mt={2}
        />
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap" justify="space-between">
            <Text size="xs" fw={600} truncate>
              {row.slotName}
            </Text>
            <Text size="xs" ff="monospace" c="dimmed">
              {level} → +{row.targetLevel}
            </Text>
          </Group>
          <Text size="10px" c="dimmed" truncate>
            {row.itemName}
          </Text>
          {row.caveat && (
            <Tooltip label={row.caveat} withArrow position="right" multiline w={260}>
              <Text size="10px" c="orange">
                caveat — hover
              </Text>
            </Tooltip>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}

export function EquipmentOptimizerPanel({
  preview,
  previewing,
  apiReachable,
  selection,
  onSelectionChange,
  config,
  onConfigChange,
  loading,
  onRun,
  onCancel,
  sealCount = 0,
  pricing,
  consumableCostRows = [],
}) {
  // Memoised rather than `preview?.equipment || []`: the fallback literal would be
  // a fresh array every render and re-run both filters below on each one.
  const equipment = useMemo(() => preview?.equipment || [], [preview?.equipment]);
  const scannable = useMemo(() => equipment.filter((row) => row.scannable), [equipment]);
  const unscannable = useMemo(() => equipment.filter((row) => !row.scannable), [equipment]);

  const selectedIds = useMemo(() => new Set((selection || []).map(String)), [selection]);
  const workerCount = config.workers || preview?.poolSize || 4;

  // The preview's workload counts every scannable slot; the user may have ticked
  // fewer, so recompute rather than showing a bill they are not paying.
  const workload = useMemo(() => {
    const count = selectedIds.size;
    const perReplicate = count + 1;
    const total = perReplicate * (config.replicates || 1);
    return { total, simulatedHours: total * (config.hours || 0) };
  }, [selectedIds.size, config.replicates, config.hours]);

  const seconds = estimateSeconds(workload, workerCount);
  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });

  const toggle = (row) => {
    const next = selectedIds.has(row.id)
      ? (selection || []).filter((id) => id !== row.id)
      : [...(selection || []), row.id];
    onSelectionChange?.(next);
  };

  const costed = !!preview?.consumableCostsKnown;
  const overrideCount = consumableCostRows.filter((row) => row.override != null).length;

  if (apiReachable === false) {
    return (
      <Alert color="orange" title="csim API not running" variant="light">
        <Text size="xs">
          Like the Trigger Optimizer, the Equipment Optimizer runs its simulations on the server —
          dozens of them, across a thread pool.
        </Text>
        <Text size="xs" mt={6}>
          Start it with <Text span ff="monospace">npm start</Text> in{' '}
          <Text span ff="monospace">csim/api</Text>, then reopen this panel.
        </Text>
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" gap={4}>
        <Text size="sm" fw={600}>
          Equipment Optimizer
        </Text>
        {previewing && (
          <Text size="10px" c="dimmed">
            checking…
          </Text>
        )}
      </Group>

      <Text size="xs" c="dimmed">
        Measures what one enhancement level on each piece is worth. Each slot is probed at
        +{config.step} — a single level is beneath the simulation noise — and the result divided back
        down.
      </Text>

      {sealCount > 0 && (
        <Alert color="yellow" variant="light" title="Seals will not be applied">
          <Text size="xs">
            You have {sealCount} personal seal{sealCount === 1 ? '' : 's'} enabled. Those are honoured
            by the browser worker but not by the API path this scan uses, so gains are measured
            against a build without them.
          </Text>
        </Alert>
      )}

      {/* Price source. Only the Iron source yields production time in seconds, and
          only seconds are commensurable with combat time — so without it the scan
          ranks on raw throughput and cannot see the food bill at all. */}
      {pricing && (
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
      )}

      <Alert
        color={costed ? 'teal' : 'yellow'}
        variant="light"
        p="xs"
        title={costed ? 'Ranking on effective enc/hour' : 'Ranking on raw enc/hour'}
      >
        <Text size="xs">
          {costed
            ? 'Gains are measured in encounters per hour of TOTAL time — combat plus the production owed for every consumable burned.'
            : 'No production times are loaded, so the food bill is not counted. An enhancement that lets the build eat less will not be rewarded.'}
        </Text>
      </Alert>

      <Divider label="Slots to probe" labelPosition="center" />

      <Group gap={4}>
        <Button
          variant="default"
          size="compact-xs"
          disabled={loading || !scannable.length}
          onClick={() => onSelectionChange?.(scannable.map((row) => row.id))}
        >
          All
        </Button>
        <Button
          variant="default"
          size="compact-xs"
          disabled={loading || !selectedIds.size}
          onClick={() => onSelectionChange?.([])}
        >
          None
        </Button>
        <Text size="xs" c="dimmed" ml="auto">
          {selectedIds.size} of {scannable.length}
        </Text>
      </Group>

      <ScrollArea.Autosize mah={300}>
        <Stack gap={4}>
          {scannable.map((row) => (
            <SlotRow
              key={row.id}
              row={row}
              checked={selectedIds.has(row.id)}
              disabled={loading}
              onToggle={toggle}
            />
          ))}
          {unscannable.length > 0 && (
            <>
              <Text size="10px" c="dimmed" mt={4}>
                Not probed ({unscannable.length})
              </Text>
              {unscannable.map((row) => (
                <SlotRow key={row.id} row={row} checked={false} disabled onToggle={toggle} />
              ))}
            </>
          )}
          {!equipment.length && !previewing && (
            <Text size="xs" c="dimmed">
              No equipment found on the selected players.
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>

      <Paper p="xs" radius="sm" withBorder>
        <Group justify="space-between" gap={4}>
          <Text size="xs" fw={600}>
            Workload
          </Text>
          <Badge size="xs" variant="light">
            {workload.total} sims
          </Badge>
        </Group>
        <Text size="xs" c="dimmed" mt={2}>
          {workload.simulatedHours.toLocaleString()} simulated hours · {formatDuration(seconds)} on{' '}
          {workerCount} worker{workerCount === 1 ? '' : 's'}
        </Text>
      </Paper>

      <Accordion variant="separated" chevronPosition="right">
        <Accordion.Item value="fidelity">
          <Accordion.Control>
            <Text size="xs" fw={600}>
              Fidelity
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={8}>
              <NumberInput
                size="xs"
                label="Probe size (+N)"
                description="A single level is beneath the noise. Six clears it; the result is divided by six."
                min={1}
                max={20}
                value={config.step}
                onChange={(value) => setCfg({ step: Number(value) || DEFAULT_EQUIPMENT_OPT_CONFIG.step })}
                disabled={loading}
              />
              <NumberInput
                size="xs"
                label="Simulated hours"
                description="Per simulation. Noise falls as 1/sqrt(hours)."
                min={1}
                max={1000}
                value={config.hours}
                onChange={(value) => setCfg({ hours: Number(value) || DEFAULT_EQUIPMENT_OPT_CONFIG.hours })}
                disabled={loading}
              />
              <NumberInput
                size="xs"
                label="Replicates"
                description="Repeats per slot on shared seeds. This is what buys the error bar — two is the minimum for having one at all."
                min={2}
                max={40}
                value={config.replicates}
                onChange={(value) =>
                  setCfg({ replicates: Number(value) || DEFAULT_EQUIPMENT_OPT_CONFIG.replicates })
                }
                disabled={loading}
              />
              <NumberInput
                size="xs"
                label="Significance level"
                description="0.05 is a 95% confidence interval. Lower demands stronger evidence."
                min={0.001}
                max={0.5}
                step={0.01}
                decimalScale={3}
                value={config.alpha}
                onChange={(value) => setCfg({ alpha: Number(value) || DEFAULT_EQUIPMENT_OPT_CONFIG.alpha })}
                disabled={loading}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Button
        fullWidth
        color={loading ? 'red' : 'indigo'}
        disabled={!loading && !selectedIds.size}
        onClick={loading ? onCancel : onRun}
      >
        {loading ? 'Stop' : 'Run equipment scan'}
      </Button>
    </Stack>
  );
}
