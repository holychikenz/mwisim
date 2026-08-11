import { useMemo } from 'react';
import {
  Accordion,
  ActionIcon,
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
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  DEFAULT_TRIGGER_OPT_CONFIG,
  estimateSeconds,
  formatAge,
  formatDuration,
  formatSeconds,
  toStages,
  triggerKey,
} from '../utils/triggerOptimizer';

// =============================================================================
// TriggerOptimizerPanel — navbar view for the Trigger Optimizer mode.
//
// Presentational plus callbacks; every piece of state lives in App, following
// GuildTrialPanel. Its job is to let a user say WHICH threshold values to sweep,
// show why the rest cannot be swept, and be honest about what the run will cost
// before they start it.
//
// The cost matters more here than anywhere else in this UI. A default run is
// hundreds of candidate simulations, and the verification stage alone is 72
// simulated hours per finalist — so the workload and time estimate are given
// top billing rather than buried in an options popover.
// =============================================================================

const SLOT_LABELS = { abilities: 'Abilities', food: 'Food', drinks: 'Drinks' };

function lastSegment(hrid) {
  if (!hrid) return '';
  return String(hrid).split('/').pop().replace(/_/g, ' ');
}

/** One trigger row: a checkbox when it can be swept, a dimmed reason when not. */
function TriggerRow({ row, checked, disabled, onToggle }) {
  const summary = `${row.dependencyName} ${row.conditionName} ${row.comparatorName} ${row.value}`;

  if (!row.searchable) {
    return (
      <Tooltip label={row.reason} withArrow position="right" multiline w={240}>
        <Paper p={6} radius="sm" withBorder style={{ opacity: 0.55 }}>
          <Text size="xs" c="dimmed">
            {lastSegment(row.slotHrid)} — {summary}
          </Text>
          <Text size="xs" c="dimmed" fs="italic">
            {row.reason}
          </Text>
        </Paper>
      </Tooltip>
    );
  }

  return (
    <Paper p={6} radius="sm" withBorder>
      <Checkbox
        size="xs"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(row)}
        label={
          <Stack gap={0}>
            <Text size="xs" fw={600}>
              {lastSegment(row.slotHrid)}
            </Text>
            <Text size="xs" c="dimmed">
              {summary}
            </Text>
          </Stack>
        }
      />
    </Paper>
  );
}

/**
 * One consumable's cost: what the cow webapp said it takes to make, and what the
 * user says instead. Blank means "use the fetched time"; a typed 0 means free.
 *
 * The fetched figure is kept on screen next to the input rather than replaced by
 * it, because an override is a claim about one's own circumstances and is much
 * easier to sanity-check against the number it is displacing.
 */
function ConsumableCostRow({ row, disabled, onChange }) {
  const overridden = row.override != null;
  const name = lastSegment(row.hrid);

  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Text size="xs" fw={overridden ? 600 : 400} style={{ flex: 1, minWidth: 0 }} truncate>
        {name}
      </Text>
      <Tooltip
        label={row.fetched != null ? 'Fetched production time' : 'No production time fetched for this item'}
        withArrow
        withinPortal={false}
      >
        <Text size="xs" c="dimmed" w={52} ta="right" style={{ textDecoration: overridden ? 'line-through' : 'none' }}>
          {row.fetched != null ? formatSeconds(row.fetched) : '—'}
        </Text>
      </Tooltip>
      <NumberInput
        size="xs"
        w={72}
        min={0}
        hideControls
        placeholder={row.fetched != null ? 'fetched' : 'unknown'}
        value={row.override ?? ''}
        // Passed through raw: usePrices treats '' and anything not a finite
        // non-negative number as "no override", so a half-typed value simply falls
        // back to the fetched time until it parses.
        onChange={(value) => onChange(row.hrid, value)}
        disabled={disabled}
        aria-label={`Cost override for ${name}, seconds per unit`}
      />
      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        disabled={disabled || !overridden}
        onClick={() => onChange(row.hrid, null)}
        aria-label={`Clear cost override for ${name}`}
      >
        ↺
      </ActionIcon>
    </Group>
  );
}

export function TriggerOptimizerPanel({
  preview,
  previewing,
  apiReachable,
  selection = [],
  onSelectionChange,
  config = DEFAULT_TRIGGER_OPT_CONFIG,
  onConfigChange,
  loading,
  onRun,
  onCancel,
  sealCount = 0,
  pricing,
  consumableCostRows = [],
}) {
  const selectedKeys = useMemo(() => new Set(selection.map(triggerKey)), [selection]);

  const overrideCount = useMemo(
    () => consumableCostRows.filter((row) => row.override != null).length,
    [consumableCostRows]
  );

  /** " 4 items priced, 1 by hand." — the tail of the costed-objective alert. */
  const pricedSummary = useMemo(() => {
    const priced = preview?.pricedConsumables?.length || 0;
    if (!priced) return '';
    const parts = [`${priced} item${priced === 1 ? '' : 's'} priced`];
    if (overrideCount > 0) parts.push(`${overrideCount} by hand`);
    return ` ${parts.join(', ')}.`;
  }, [preview, overrideCount]);

  const grouped = useMemo(() => {
    const rows = preview?.triggers || [];
    const groups = { abilities: [], food: [], drinks: [] };
    for (const row of rows) {
      if (groups[row.slotKind]) groups[row.slotKind].push(row);
    }
    return groups;
  }, [preview]);

  const searchableRows = useMemo(
    () => (preview?.triggers || []).filter((row) => row.searchable),
    [preview]
  );

  // How many of the RESOLVED search parameters sit on a consumable. Those are the
  // ones whose recommendation is untrustworthy without a production-time cost.
  const consumableParamCount = useMemo(
    () => (preview?.params || []).filter((param) => param.slotKind !== 'abilities').length,
    [preview]
  );

  const stages = useMemo(() => toStages(config), [config]);
  const workerCount = config.workers || preview?.poolSize || 4;
  const seconds = estimateSeconds(preview?.workload, stages, workerCount);

  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });

  const toggle = (row) => {
    const key = triggerKey(row);
    const next = selectedKeys.has(key)
      ? selection.filter((entry) => triggerKey(entry) !== key)
      : [...selection, row];
    onSelectionChange?.(next);
  };

  if (apiReachable === false) {
    return (
      <Alert color="orange" title="csim API not running" variant="light">
        <Text size="xs">
          Unlike the other modes, the Trigger Optimizer runs its simulations on the server — hundreds of
          them, across a thread pool.
        </Text>
        <Text size="xs" mt={6}>
          Start it with <Text span ff="monospace">npm start</Text> in <Text span ff="monospace">csim/api</Text>,
          then reopen this panel.
        </Text>
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      {sealCount > 0 && (
        <Alert color="yellow" variant="light" title="Seals will not be applied">
          <Text size="xs">
            You have {sealCount} personal seal{sealCount === 1 ? '' : 's'} enabled. Those are honoured by the
            browser worker but not by the API path this optimiser uses, so thresholds will be tuned against a
            build without them. Values that depend on your real damage or attack speed may be a little off.
          </Text>
        </Alert>
      )}

      {/* Price source. This normally lives in the results pane (DropsEconomy), but
          that pane is not rendered in this mode — so without a control here there
          would be no way to reach the Iron source, and the consumable cost function
          could never engage. Only Iron yields production time in seconds. */}
      {pricing && consumableParamCount > 0 && (
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
                  // Include the remembered character even when it is absent from the
                  // fetched list — the cow webapp may be offline, and a Select that
                  // renders blank makes it look as though the setting were lost when
                  // it is merely unverified.
                  data={[...new Set([...(pricing.characters || []), pricing.ironCharacter].filter(Boolean))].map(
                    (name) => ({ value: name, label: name })
                  )}
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
                {/* Cached values persist across reloads and are never refetched on
                    their own, so the age is the only cue that a figure may have
                    drifted. */}
                {pricing.fetchedLabel && (
                  <Text size="xs" c="dimmed">
                    {pricing.fetchedLabel}
                    {formatAge(pricing.fetchedAt) ? ` · cached ${formatAge(pricing.fetchedAt)}` : ''}
                  </Text>
                )}
                {pricing.staleCharacter && (
                  <Text size="xs" c="orange">
                    Cached times are for {pricing.staleCharacter}. Refetch to cost food at{' '}
                    {pricing.ironCharacter}&apos;s rates.
                  </Text>
                )}
                {!pricing.fetchedLabel && !pricing.error && (
                  <Text size="xs" c="dimmed">
                    Nothing cached yet — fetch once and it is kept until you refetch.
                  </Text>
                )}

                {/* Per-item overrides. A fetched production time answers "what would
                    it cost me to make this?", which is not always the question: an
                    item that arrives free — a daily, a guild handout, a stockpile
                    already paid for — costs nothing at the margin, and 0 is then the
                    honest figure. Overrides are remembered across refetches, source
                    switches and reloads, so this is worth setting once. */}
                {consumableCostRows.length > 0 && (
                  <>
                    <Divider my={2} />
                    <Group justify="space-between" gap={4}>
                      <Text size="xs" fw={600}>
                        Per-item cost (s / unit)
                      </Text>
                      {overrideCount > 0 && (
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          color="gray"
                          onClick={pricing.clearConsumableCostOverrides}
                          disabled={loading}
                        >
                          Reset {overrideCount}
                        </Button>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      Blank uses the fetched time. Enter <Text span fw={600}>0</Text> for anything that reaches
                      you free, and the optimiser will stop charging you to eat it.
                    </Text>
                    <Stack gap={2}>
                      {consumableCostRows.map((row) => (
                        <ConsumableCostRow
                          key={row.hrid}
                          row={row}
                          disabled={loading}
                          onChange={pricing.setConsumableCostOverride}
                        />
                      ))}
                    </Stack>
                  </>
                )}
              </>
            )}
            {pricing.source === 'market' && (
              <Text size="xs" c="dimmed">
                Coins are not comparable with combat time, so they cannot be used to cost consumables here. Use
                Iron time.
              </Text>
            )}
            {pricing.error && (
              <Text size="xs" c="red">
                {pricing.error.message}
              </Text>
            )}
          </Stack>
        </Paper>
      )}

      {/* The single most important caveat in this panel. A consumable threshold
          optimised without a production-time cost is optimised toward eating
          constantly: measured, driving a food threshold from 400 down to 1 bought
          +0.37% encounters/hour and 44 donuts an hour from a standing start. */}
      {preview && !preview.consumableCostsKnown && consumableParamCount > 0 && (
        <Alert color="yellow" variant="light" title="Food and drink cost is not counted">
          <Text size="xs">
            {consumableParamCount} of the selected threshold{consumableParamCount === 1 ? ' is' : 's are'} on a
            consumable. Without production times the optimiser cannot see what eating costs, so it will lean
            toward eating more often for a fraction of a percent of throughput.
          </Text>
          <Text size="xs" mt={6}>
            Set the price source to <Text span fw={600}>Iron</Text> in the results pane to supply per-item
            production time in seconds. The objective then becomes encounters per hour of{' '}
            <Text span fs="italic">total</Text> time — combat plus cooking.
          </Text>
        </Alert>
      )}

      {preview?.consumableCostsKnown && consumableParamCount > 0 && (
        <Alert color="teal" variant="light" title="Costing food in production time">
          <Text size="xs">
            Ranking on encounters per hour of total time, counting the time owed to produce everything consumed.
            {pricedSummary}
          </Text>
        </Alert>
      )}

      <Text size="xs" fw={600}>
        Thresholds to search
      </Text>

      {previewing && !preview && (
        <Text size="xs" c="dimmed">
          Reading your triggers…
        </Text>
      )}

      {preview && searchableRows.length === 0 && (
        <Alert color="yellow" variant="light" title="Nothing to search">
          <Text size="xs">
            None of this build&apos;s triggers carries a value worth sweeping. Only seven trigger conditions
            take a number — current/missing HP and MP, lowest HP %, and the two unit counts. Everything else
            is an is-active/is-inactive buff check whose value the engine ignores.
          </Text>
        </Alert>
      )}

      {preview && searchableRows.length > 0 && (
        <>
          <Group gap={4}>
            <Button
              variant="default"
              size="compact-xs"
              onClick={() => onSelectionChange?.(searchableRows)}
              disabled={loading}
            >
              All ({searchableRows.length})
            </Button>
            <Button
              variant="default"
              size="compact-xs"
              onClick={() => onSelectionChange?.([])}
              disabled={loading}
            >
              None
            </Button>
          </Group>

          <ScrollArea.Autosize mah={300} type="hover">
            <Stack gap="xs">
              {Object.entries(grouped).map(([slotKind, rows]) =>
                rows.length === 0 ? null : (
                  <Stack gap={4} key={slotKind}>
                    <Text size="xs" c="dimmed" tt="uppercase">
                      {SLOT_LABELS[slotKind]}
                    </Text>
                    {rows.map((row) => (
                      <TriggerRow
                        key={triggerKey(row)}
                        row={row}
                        checked={selectedKeys.has(triggerKey(row))}
                        disabled={loading}
                        onToggle={toggle}
                      />
                    ))}
                  </Stack>
                )
              )}
            </Stack>
          </ScrollArea.Autosize>
        </>
      )}

      {preview?.params?.length > 0 && (
        <Paper p="xs" radius="sm" withBorder>
          <Stack gap={4}>
            <Group justify="space-between">
              <Text size="xs" fw={600}>
                Workload
              </Text>
              <Badge size="sm" variant="light">
                {preview.workload.total} sims
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {preview.workload.calibration} calibration · {preview.workload.initial} screen ·{' '}
              {preview.workload.coarse} beam · {preview.workload.fine} refine · {preview.workload.verify} verify
            </Text>
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {workerCount} worker{workerCount === 1 ? '' : 's'}
              </Text>
              <Text size="xs" fw={600}>
                {formatDuration(seconds)}
              </Text>
            </Group>
            {/* Ranges matter: they are what the grids are built from, and a wildly
                wrong ceiling is the most likely reason a search finds nothing. */}
            <Divider my={2} />
            {preview.params.map((param) => {
              // Counts start at 0 and are swept exhaustively, so their range reads
              // differently from a threshold's — and "1–1" on a single-spawn zone
              // looked like a bug rather than a fact about the zone.
              const range =
                param.kind === 'percentage'
                  ? '0–100%'
                  : param.kind === 'count'
                    ? `0–${param.maxValue} (every value)`
                    : `1–${param.maxValue}`;
              return (
                <Text size="xs" c="dimmed" key={`${param.slotKind}-${param.slotIndex}-${param.triggerIndex}`}>
                  {lastSegment(param.slotHrid)}: {range}
                </Text>
              );
            })}
          </Stack>
        </Paper>
      )}

      <Accordion variant="separated" chevronPosition="left">
        <Accordion.Item value="stages">
          <Accordion.Control>
            <Text size="xs" fw={600}>
              Stages &amp; fidelity
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <NumberInput
                label="Noise calibration runs"
                description="Measures this build's run-to-run spread. Every ranking threshold is derived from it. 0 disables it and falls back to a fixed 0.1%, which is far below the real noise on a hard zone."
                value={config.calibrationRepeats}
                onChange={(v) => setCfg({ calibrationRepeats: Math.max(0, Math.min(20, Number(v) || 0)) })}
                min={0}
                max={20}
                size="xs"
                disabled={loading}
              />
              <Divider my={2} />
              <SimpleGrid cols={2} spacing="xs">
                <NumberInput
                  label="Screen hours"
                  value={config.initialHours}
                  onChange={(v) => setCfg({ initialHours: Math.max(0.1, Number(v) || 1) })}
                  min={0.1}
                  size="xs"
                  disabled={loading}
                />
                <NumberInput
                  label="Keep / parameter"
                  value={config.keepPerParam}
                  onChange={(v) => setCfg({ keepPerParam: Math.max(1, Math.min(10, Number(v) || 1)) })}
                  min={1}
                  max={10}
                  size="xs"
                  disabled={loading}
                />
                <NumberInput
                  label="Beam hours"
                  value={config.coarseHours}
                  onChange={(v) => setCfg({ coarseHours: Math.max(0.1, Number(v) || 1) })}
                  min={0.1}
                  size="xs"
                  disabled={loading}
                />
                <NumberInput
                  label="Beam width"
                  description="Combinations carried forward"
                  value={config.beamWidth}
                  onChange={(v) => setCfg({ beamWidth: Math.max(1, Math.min(32, Number(v) || 1)) })}
                  min={1}
                  max={32}
                  size="xs"
                  disabled={loading}
                />
                <NumberInput
                  label="Refine hours"
                  value={config.fineHours}
                  onChange={(v) => setCfg({ fineHours: Math.max(0.1, Number(v) || 1) })}
                  min={0.1}
                  size="xs"
                  disabled={loading}
                />
                <NumberInput
                  label="Finalists"
                  value={config.keep}
                  onChange={(v) => setCfg({ keep: Math.max(1, Math.min(20, Number(v) || 1)) })}
                  min={1}
                  max={20}
                  size="xs"
                  disabled={loading}
                />
              </SimpleGrid>
              <NumberInput
                label="Verify hours"
                description="Finalists and the baseline re-run together on one pinned seed"
                value={config.verifyHours}
                onChange={(v) => setCfg({ verifyHours: Math.max(0.1, Number(v) || 1) })}
                min={0.1}
                size="xs"
                disabled={loading}
              />
              <Switch
                size="xs"
                label="Stable mode (120h verification)"
                checked={config.verifyHours >= 120}
                onChange={(e) => setCfg({ verifyHours: e.currentTarget.checked ? 120 : 72 })}
                disabled={loading}
              />
              <NumberInput
                label="Workers"
                description={`Blank = server default (${preview?.poolSize ?? '?'})`}
                value={config.workers ?? ''}
                onChange={(v) => setCfg({ workers: v === '' ? null : Math.max(1, Math.min(16, Number(v) || 1)) })}
                min={1}
                max={16}
                size="xs"
                disabled={loading}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      {loading ? (
        <Button color="red" variant="light" size="sm" onClick={onCancel}>
          Stop optimising
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={onRun}
          disabled={!preview || selection.length === 0 || previewing}
        >
          Optimise {selection.length} threshold{selection.length === 1 ? '' : 's'}
        </Button>
      )}
    </Stack>
  );
}
