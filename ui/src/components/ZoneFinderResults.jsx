import { Button, Group, Stack, Table, Text } from '@mantine/core';
import { formatSignedPct } from '../utils/equipmentOptimizer';
import { compact } from '../utils/candidateOptimizer';
import { nameOf } from '../utils/names';
import { FINALISTS, QUICK_HOURS, VERIFY_HOURS } from '../utils/zoneProgress';
import { NumTd } from './ResultParts';

// Under the Progress table: "Find top 10 zones" and, once both passes finish
// (or a pass stops early, ranked from the rows it had), the zones ranked by
// progress per hour (hooks/useZoneFinder.js). Errors show in App, above the
// results. `current` is false when a newer Progress result has replaced the one
// the finder scored.
export function ZoneFinderResults({ finder, current, onFind, disabled, zones, items }) {
  const { job, top, stopped, runs } = finder;
  const done = finder.stage === 'done';
  const showTable = current && (done || stopped);
  const variantOf = (row) => job?.variants.find((x) => x.key === row.variant);
  const coffee = job?.variants.some((v) => v.coffee);
  return (
    <Stack gap="xs">
      <Group>
        <Button onClick={onFind} disabled={disabled} loading={finder.running}>Find top 10 zones</Button>
      </Group>
      {showTable && (top.length === 0 ? (
        <Text size="sm">{runs.failed > 0 ? 'No zone could be ranked: runs failed.'
          : stopped ? 'No zone had earned progress when the run stopped.' : 'No zone earned any progress.'}</Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Zone</Table.Th>
                <Table.Th>Charm</Table.Th>
                {coffee && <Table.Th>Coffee</Table.Th>}
                <Table.Th ta="right">Progress / h</Table.Th>
                <Table.Th ta="right">XP / h</Table.Th>
                <Table.Th ta="right">Books / h</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {top.map((row, i) => {
                const v = variantOf(row);
                return (
                  <Table.Tr key={`${row.zoneHrid}#${row.difficultyTier}`}>
                    <Table.Td>{i + 1}</Table.Td>
                    <Table.Td>{(zones || []).find((z) => z.hrid === row.zoneHrid)?.name ?? row.zoneHrid} T{row.difficultyTier}</Table.Td>
                    <Table.Td>{v?.charm ? nameOf(v.charm, { items }) : 'none'}</Table.Td>
                    {coffee && <Table.Td>{v?.coffee ? nameOf(v.coffee, { items }) : '—'}</Table.Td>}
                    <NumTd strong>{formatSignedPct(row.progressPerHour, 4)}</NumTd>
                    <NumTd>{compact(row.xpPerHour)}</NumTd>
                    <NumTd>{row.booksPerHour.toFixed(2)}</NumTd>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ))}
      {showTable && (
        <Stack gap={2}>
          {stopped && (
            <Text size="xs" c="yellow">
              Stopped early during the {finder.stage === 'quick' ? `${QUICK_HOURS} h quick pass` : `${VERIFY_HOURS} h finalists pass`}: ranked from the {finder.rows.length} of {finder.meta?.total ?? 0} runs that finished.
            </Text>
          )}
          {runs.failed > 0 && (
            <Text size="xs" c="yellow">{runs.failed} of {runs.runs} runs failed; their zones are left out.</Text>
          )}
          {done && (
            <Text size="xs" c="dimmed">
              Every zone and tier ran {QUICK_HOURS} h per variant; the best {FINALISTS} were rerun at {VERIFY_HOURS} h with their best variant.
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Gains per level were measured at the Progress run&apos;s target zone and are applied to every zone&apos;s XP and book rates: an approximation.
          </Text>
          <Text size="xs" c="dimmed">
            The worn charm is tried, plus one for each stat Progress measured (tick Defense, Stamina or Intelligence there to try theirs), at the worn charm&apos;s tier and enhancement, where the level requirement is met. Dungeon chests are not modelled, so dungeons count XP only.
          </Text>
          {!job.variants[0].charm && (
            <Text size="xs" c="dimmed">No charm is equipped, so only the current loadout was tried.</Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
