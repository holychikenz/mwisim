import { Fragment, useMemo } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Stack,
  Table,
  Text
} from '@mantine/core';
import { simulableZones, zoneTiers, maxTierAcross, maxTierFor } from '../utils/zones';
import { comboKey, estimateSweepSeconds } from '../utils/allZones';
import { formatDuration } from '../utils/triggerOptimizer';

// =============================================================================
// AllZonesModal — pick the (zone × tier) grid to sweep
//
// A checkbox per combination the game actually offers: planets to T5, dungeons
// to T2 (action.maxDifficulty). Cells past a zone's ceiling are struck out
// rather than omitted, so the grid stays rectangular and the tier columns keep
// lining up.
//
// The column header and the zone name are both toggles — 78 individual clicks
// is not a selection interface — and the footer states the size of what you are
// about to start before you start it.
// =============================================================================

function tierColumns(zones) {
  return Array.from({ length: maxTierAcross(zones) + 1 }, (_, tier) => tier);
}

export function AllZonesModal({
  opened,
  onClose,
  zones,
  selection,          // Set of comboKey strings
  onSelectionChange,
  hours,
  onHoursChange,
  workers,
  onWorkersChange,
  onRun,
  running
}) {
  const list = useMemo(() => simulableZones(zones), [zones]);
  const tiers = useMemo(() => tierColumns(zones), [zones]);
  // Planets first, then dungeons, each under its own sub-header row — still one
  // table, so the tier-column checkboxes cover both groups.
  const groups = useMemo(
    () => [
      { label: 'Planets', zones: list.filter(zone => !zone.isDungeon) },
      { label: 'Dungeons', zones: list.filter(zone => zone.isDungeon) },
    ].filter(group => group.zones.length > 0),
    [list]
  );

  // Every combination the game offers — the "select all" target, and the
  // denominator for the header checkboxes' indeterminate state.
  const allKeys = useMemo(() => {
    const keys = [];
    for (const zone of list) {
      for (const tier of zoneTiers(zone)) keys.push(comboKey(zone.hrid, tier));
    }
    return keys;
  }, [list]);

  // Counted against the grid, not against the Set: a persisted selection may
  // hold combinations this data no longer offers, and the run drops those. A
  // footer promising 80 runs when 78 will happen is a footer that lies.
  const selectedCount = useMemo(
    () => allKeys.filter(key => selection.has(key)).length,
    [allKeys, selection]
  );
  const estimate = estimateSweepSeconds(selectedCount, hours, workers);

  const setKeys = (keys, checked) => {
    const next = new Set(selection);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onSelectionChange(next);
  };

  const toggleRow = (zone, checked) =>
    setKeys(zoneTiers(zone).map(tier => comboKey(zone.hrid, tier)), checked);

  const toggleColumn = (tier, checked) =>
    setKeys(
      list.filter(zone => tier <= maxTierFor(zone)).map(zone => comboKey(zone.hrid, tier)),
      checked
    );

  const rowState = (zone) => {
    const keys = zoneTiers(zone).map(tier => comboKey(zone.hrid, tier));
    const on = keys.filter(k => selection.has(k)).length;
    return { checked: on === keys.length && on > 0, indeterminate: on > 0 && on < keys.length };
  };

  const columnState = (tier) => {
    const keys = list
      .filter(zone => tier <= maxTierFor(zone))
      .map(zone => comboKey(zone.hrid, tier));
    const on = keys.filter(k => selection.has(k)).length;
    return { checked: on === keys.length && on > 0, indeterminate: on > 0 && on < keys.length };
  };

  return (
    <Modal opened={opened} onClose={onClose} title="All Zones — pick what to sweep" size="xl">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Every ticked combination is simulated in its own web worker and reported
          in one table. Solo monsters are not zones and are not offered; dungeons
          stop at T2, which is where the game stops them.
        </Text>

        <Group gap="xs" wrap="wrap">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
            Quick select
          </Text>
          <Button size="compact-sm" variant="default" onClick={() => onSelectionChange(new Set(allKeys))}>
            Select all
          </Button>
          <Button size="compact-sm" variant="default" onClick={() => onSelectionChange(new Set())}>
            Clear
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            onClick={() =>
              onSelectionChange(
                new Set(
                  list
                    .filter(z => !z.isDungeon)
                    .flatMap(z => zoneTiers(z).map(t => comboKey(z.hrid, t)))
                )
              )
            }
          >
            Planets only
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            onClick={() =>
              onSelectionChange(
                new Set(
                  list
                    .filter(z => z.isDungeon)
                    .flatMap(z => zoneTiers(z).map(t => comboKey(z.hrid, t)))
                )
              )
            }
          >
            Dungeons only
          </Button>
        </Group>

        <ScrollArea.Autosize mah={420} type="hover">
          <Table striped highlightOnHover withTableBorder stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ minWidth: 200 }}>Zone</Table.Th>
                {tiers.map(tier => {
                  const state = columnState(tier);
                  return (
                    <Table.Th key={tier} style={{ textAlign: 'center' }}>
                      <Checkbox
                        size="xs"
                        label={`T${tier}`}
                        checked={state.checked}
                        indeterminate={state.indeterminate}
                        onChange={(e) => toggleColumn(tier, e.currentTarget.checked)}
                      />
                    </Table.Th>
                  );
                })}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.map(group => (
                <Fragment key={group.label}>
                  <Table.Tr>
                    <Table.Td colSpan={tiers.length + 1} py={4}>
                      <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                        {group.label}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                  {group.zones.map(zone => {
                    const state = rowState(zone);
                    return (
                      <Table.Tr key={zone.hrid}>
                        <Table.Td>
                          <Checkbox
                            size="xs"
                            label={zone.name}
                            checked={state.checked}
                            indeterminate={state.indeterminate}
                            onChange={(e) => toggleRow(zone, e.currentTarget.checked)}
                          />
                        </Table.Td>
                        {tiers.map(tier => {
                          if (tier > maxTierFor(zone)) {
                            return (
                              <Table.Td key={tier} style={{ textAlign: 'center' }}>
                                <Text size="xs" className="num-faded">—</Text>
                              </Table.Td>
                            );
                          }
                          const key = comboKey(zone.hrid, tier);
                          return (
                            <Table.Td key={tier} style={{ textAlign: 'center' }}>
                              <Checkbox
                                size="xs"
                                checked={selection.has(key)}
                                onChange={(e) => setKeys([key], e.currentTarget.checked)}
                                aria-label={`${zone.name} T${tier}`}
                                styles={{ inner: { margin: '0 auto' } }}
                              />
                            </Table.Td>
                          );
                        })}
                      </Table.Tr>
                    );
                  })}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>

        <Divider />

        <Group justify="space-between" align="flex-end" gap="md" wrap="wrap">
          <Group gap="md" align="flex-end">
            <NumberInput
              label="Hours per zone"
              description="Combat simulated for each combination"
              value={hours}
              onChange={(v) => onHoursChange(Math.max(1, Math.min(1000, Number(v) || 1)))}
              min={1}
              max={1000}
              w={160}
              size="xs"
            />
            <NumberInput
              label="Workers"
              description="Parallel simulations"
              value={workers}
              onChange={(v) => onWorkersChange(Math.max(1, Math.min(32, Number(v) || 1)))}
              min={1}
              max={32}
              w={140}
              size="xs"
            />
          </Group>
          <Text size="sm" c="dimmed" ta="right">
            {selectedCount} combination{selectedCount === 1 ? '' : 's'} × {hours} h ={' '}
            <Text span fw={600} c="var(--mantine-color-text)">
              {(selectedCount * hours).toLocaleString()} simulated hours
            </Text>{' '}
            · {formatDuration(estimate)}
          </Text>
        </Group>

        {selectedCount === 0 && (
          <Alert color="yellow" variant="light" p="xs">
            Nothing selected — tick at least one zone and tier.
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRun} disabled={selectedCount === 0} loading={running}>
            Run sweep
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
