import {
  Alert,
  Badge,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text
} from '@mantine/core';
import { Select } from './SearchSelect';
import { ConsumableCostSource } from './ConsumableCostSource';
import { estimateSeconds } from '../utils/equipmentOptimizer';
import { formatDuration } from '../utils/triggerOptimizer';
import { DEFAULT_LOADOUT_OPT_CONFIG, OBJECTIVE_OPTIONS } from '../utils/candidateOptimizer';

// =============================================================================
// CandidateOptimizerPanel — the settings of a tool that ranks alternatives for
// ONE party member (Loadout, Abilities, Progress, Swaps): whose, what to rank on, the price
// source, the workload and the fidelity. The tool's own options are children.
// Presentational; every piece of state lives in App.
// =============================================================================

export function CandidateOptimizerPanel({
  title,
  blurb,
  preview,
  previewing,
  apiReachable,
  loading,
  config,
  onConfigChange,
  subjectOptions,
  subject,
  onSubjectChange,
  subjectNotice,
  pricing,
  consumableCostRows = [],
  children
}) {
  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });

  if (apiReachable === false) {
    return (
      <Alert color="orange" title="csim API not running" variant="light">
        <Text size="xs">
          Like the other optimisers, {title} runs its simulations on the server, across a thread pool.
        </Text>
        <Text size="xs" mt={6}>
          Start it with <Text span ff="monospace">npm start</Text> in{' '}
          <Text span ff="monospace">csim/api</Text>, then reopen this panel.
        </Text>
      </Alert>
    );
  }

  // Read from the preview: the server echoes the target it will actually run.
  const labyrinth = preview?.target?.kind === 'labyrinth';
  const dungeon = !labyrinth && !!preview?.target?.dungeon;
  const workload = preview?.workload;
  const workerCount = preview?.poolSize || 4;

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
      <Stack gap="xs">
        <Group justify="space-between" gap={4}>
          <Text size="sm" fw={600}>{title}</Text>
          {previewing && <Text size="10px" c="dimmed">checking…</Text>}
        </Group>
        <Text size="xs" c="dimmed">{blurb}</Text>

        {subjectOptions?.length ? (
          <Select
            size="xs"
            label="Character"
            data={subjectOptions}
            value={subject}
            onChange={(v) => v && onSubjectChange(v)}
            allowDeselect={false}
            disabled={loading}
          />
        ) : (
          <Text size="xs" c="dimmed">Tick a party member on the left.</Text>
        )}
        {subjectNotice && <Text size="xs" c="orange">{subjectNotice}</Text>}

        {labyrinth || dungeon ? (
          <Alert color="grape" variant="light" p="xs"
            title={labyrinth ? 'Ranking on clear rate' : 'Ranking on completed runs per hour'}>
            <Text size="xs">
              {labyrinth
                ? 'EPH does not apply in a lab room: the share of attempts cleared inside the timer decides, and food, drinks and teas are stripped on entry as the game strips them.'
                : 'EPH does not apply inside a dungeon, where an encounter is a wave: the measure is whole runs completed per hour.'}
            </Text>
          </Alert>
        ) : (
          <Stack gap={4}>
            <SegmentedControl
              size="xs"
              fullWidth
              data={OBJECTIVE_OPTIONS}
              value={config.objective}
              onChange={(objective) => setCfg({ objective })}
              disabled={loading}
            />
            {preview && !preview.consumableCostsKnown && (
              <Text size="10px" c="dimmed">No production times loaded, so effective EPH equals EPH.</Text>
            )}
          </Stack>
        )}

        {children}
      </Stack>

      <Stack gap="xs">
        {!labyrinth && pricing && (
          <ConsumableCostSource pricing={pricing} loading={loading} consumableCostRows={consumableCostRows} />
        )}

        <Paper p="xs" radius="sm" withBorder>
          <Group justify="space-between" gap={4}>
            <Text size="xs" fw={600}>Workload</Text>
            <Badge size="xs" variant="light">
              {preview?.search === 'best' ? 'up to ' : ''}{workload?.total ?? 0} sims
            </Badge>
          </Group>
          {workload && (
            <Text size="xs" c="dimmed" mt={2}>
              {workload.simulatedHours.toLocaleString()} simulated hours ·{' '}
              {formatDuration(estimateSeconds(workload, workerCount))} on {workerCount} worker
              {workerCount === 1 ? '' : 's'}
            </Text>
          )}
        </Paper>

        <Paper p="xs" radius="sm" withBorder>
          <Stack gap={8}>
            <Text size="xs" fw={600}>Fidelity</Text>
            <NumberInput
              size="xs"
              label="Simulated hours"
              description="Per simulation. Noise falls as 1/sqrt(hours)."
              min={1}
              max={1000}
              value={config.hours}
              onChange={(value) => setCfg({ hours: Number(value) || DEFAULT_LOADOUT_OPT_CONFIG.hours })}
              disabled={loading}
            />
            <NumberInput
              size="xs"
              label="Replicates"
              description="Repeats per candidate on shared seeds. This is what buys the error bar."
              min={2}
              max={40}
              value={config.replicates}
              onChange={(value) => setCfg({ replicates: Number(value) || DEFAULT_LOADOUT_OPT_CONFIG.replicates })}
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
              onChange={(value) => setCfg({ alpha: Number(value) || DEFAULT_LOADOUT_OPT_CONFIG.alpha })}
              disabled={loading}
            />
          </Stack>
        </Paper>
      </Stack>
    </SimpleGrid>
  );
}

/** One change at a time or a best-combination descent, and its passes: shared by Abilities and Swaps. */
function SearchModeControls({ config, onConfigChange, loading }) {
  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });
  return (
    <>
      <SegmentedControl
        size="xs"
        fullWidth
        data={[{ value: 'swaps', label: 'One change at a time' }, { value: 'best', label: 'Best combination' }]}
        value={config.search}
        onChange={(search) => setCfg({ search })}
        disabled={loading}
      />
      {config.search === 'best' && (
        <NumberInput
          size="xs"
          label="Passes"
          description="Each pass revisits every slot and keeps only clear gains; it stops early on a pass that changes nothing."
          min={1}
          max={3}
          value={config.passes}
          onChange={(value) => setCfg({ passes: Number(value) || 2 })}
          disabled={loading}
        />
      )}
    </>
  );
}

/** The Abilities tool's own options: one change at a time or a descent, and which slots to vary. */
export function AbilitySearchOptions({ preview, config, onConfigChange, loading }) {
  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });
  const ticked = new Set(config.coordinates);
  const toggle = (key) => setCfg({
    coordinates: ticked.has(key) ? config.coordinates.filter((k) => k !== key) : [...config.coordinates, key]
  });
  return (
    <Stack gap={6}>
      <SearchModeControls config={config} onConfigChange={onConfigChange} loading={loading} />
      {(preview?.slots || []).map((s) => (
        <Checkbox
          key={s.key}
          size="xs"
          label={s.unlocked ? `${s.label} · ${s.count} to try` : `${s.label} · unlocks at intelligence ${s.unlockLevel}`}
          checked={s.unlocked && ticked.has(s.key)}
          onChange={() => toggle(s.key)}
          disabled={!s.unlocked || loading}
        />
      ))}
      {preview?.skipped > 0 && (
        <Text size="xs" c="orange">{preview.skipped} more not tried: untick a slot to fit them in.</Text>
      )}
      {preview?.refusal && <Text size="xs" c="orange">{preview.refusal}</Text>}
      <Text size="xs" c="dimmed">
        Tries every ability this character has a level for: imported from the game, or set by slotting it on its
        Abilities tab. Each goes in with the triggers this loadout last gave it, else the game&apos;s defaults.
      </Text>
    </Stack>
  );
}

const EXTRA_STAT_OPTIONS = [['defense', 'Defense'], ['stamina', 'Stamina'], ['intelligence', 'Intelligence']]; // api/lib/progressSearch.js EXTRA_STATS

/** The Progress tool's own options: how many levels each probe adds, and which extra stats to probe. */
export function ProgressOptions({ preview, config, onConfigChange, loading }) {
  const setCfg = (patch) => onConfigChange?.({ ...config, ...patch });
  const ticked = new Set(config.stats);
  const probes = preview?.probes || [];
  return (
    <Stack gap={6}>
      <NumberInput size="xs" label="Levels per probe" min={1} max={200} value={config.levels} disabled={loading}
        description="Each stat and ability is raised this many levels (never past 200); the gain is divided by the levels added."
        onChange={(value) => setCfg({ levels: Number(value) || 10 })} />
      <Group gap="xs">
        {EXTRA_STAT_OPTIONS.map(([key, label]) => (
          <Checkbox key={key} size="xs" label={label} checked={ticked.has(key)} disabled={loading}
            onChange={() => setCfg({ stats: ticked.has(key) ? config.stats.filter((k) => k !== key) : [...config.stats, key] })} />
        ))}
      </Group>
      {probes.some((p) => p.scannable) && (
        <Text size="xs" c="dimmed">Probes: {probes.filter((p) => p.scannable).map((p) => p.label).join(', ')}.</Text>
      )}
      {probes.filter((p) => !p.scannable).map((p) => <Text key={p.id} size="xs" c="orange">{p.label}: {p.reason}</Text>)}
    </Stack>
  );
}

/** The Swaps tool's own options: one swap at a time or a descent, and which owned items to try, grouped by slot. */
export function SwapOptions({ preview, config, onConfigChange, loading, allowed, onAllowedChange, hasInventory, ready }) {
  const groups = preview?.groups || [];
  // `allowed` null = the server's defaults, read from the preview; the first tick turns them into an explicit list,
  // so it waits until the preview answers this payload (`ready`): the groups on screen may be another subject's.
  const ticked = new Set(allowed ?? groups.flatMap((g) => g.items.filter((item) => item.default).map((item) => item.hrid)));
  const toggle = (hrid) => onAllowedChange([...ticked].filter((h) => h !== hrid).concat(ticked.has(hrid) ? [] : [hrid]));
  return (
    <Stack gap={6}>
      <SearchModeControls config={config} onConfigChange={onConfigChange} loading={loading} />
      {!hasInventory && (
        <Text size="xs" c="orange">Import this character from the game (again) to list what it owns; until then only what it wears is known.</Text>
      )}
      {groups.map((g) => (
        <Stack key={g.key} gap={2}>
          <Text size="xs" fw={600}>{g.label} · now {g.current}</Text>
          {g.items.map((item) => (
            <Checkbox key={item.hrid} size="xs" label={item.label} checked={ticked.has(item.hrid)} onChange={() => toggle(item.hrid)}
              disabled={loading || (allowed == null && !ready)} />
          ))}
        </Stack>
      ))}
      {preview?.skipped > 0 && <Text size="xs" c="orange">{preview.skipped} more not tried: untick some items to fit them in.</Text>}
      {preview?.refusal && <Text size="xs" c="orange">{preview.refusal}</Text>}
    </Stack>
  );
}
