import { Badge, Group, Paper, Progress, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { formatTier, levelToTierIndex, TIER_BASE_LEVEL } from '../utils/trialTiers';

// =============================================================================
// GuildTrialResults — renders the aggregate produced by multiWorker's
// `simulation_result_guildTrial` message (see guildTrialStats.aggregateTrialResults).
// Three sections: headline KPIs, a tier-ladder table, and a max-tier
// distribution built from Mantine Progress bars (no chart dependency).
//
// DIALECT NOTE: every tier value in the aggregate is an engine LEVEL
// (100..300); the game counts tiers 0..20 (Tier 0 = Lv 100). All tier
// renderings go through formatTier() → "T3 · Lv 130" — display-only, the
// underlying fields stay level-valued.
// =============================================================================

function pct(x) {
  return `${((x || 0) * 100).toFixed(1)}%`;
}

function seconds(msValue) {
  if (msValue == null) return '—';
  return `${(msValue / 1000).toFixed(1)}s`;
}

// DPS: thousands separators; 1 decimal below 100 (small numbers keep meaning).
function fmtDps(x) {
  const n = Number(x) || 0;
  if (n < 100) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function KpiCard({ label, value }) {
  return (
    <Paper p="sm" radius="md" withBorder>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text size="lg" fw={700}>{value}</Text>
    </Paper>
  );
}

export function GuildTrialResults({ result }) {
  const agg = result?.aggregate;
  const meta = result?.meta || {};
  if (!agg) return null;

  // Debugging fields (may be absent against a pre-amendment engine build —
  // render "—" / hide when missing):
  //   endedAtTierCount:      { [tier]: count } runs ENDING at each tier (the
  //     tier in progress at the end — off by one from maxTierDistribution,
  //     which counts CLEARED tiers).
  //   avgFinalTierHpRemoved: { [tier]: 0..1 } avg fraction of the in-progress
  //     encounter's total max HP removed when runs ended there (1.0 = cleared).
  const endedAtTierCount = agg.endedAtTierCount || null;
  const avgFinalTierHpRemoved = agg.avgFinalTierHpRemoved || null;
  const hasEndDiagnostics =
    !!endedAtTierCount && Object.keys(endedAtTierCount).length > 0;

  // Modal ended-at tier (ties broken toward the lower tier) for the headline.
  let modalEnd = null;
  if (hasEndDiagnostics) {
    for (const [key, count] of Object.entries(endedAtTierCount)) {
      const tier = Number(key);
      if (!modalEnd || count > modalEnd.count || (count === modalEnd.count && tier < modalEnd.tier)) {
        modalEnd = { tier, count };
      }
    }
  }
  const modalHpRemoved = modalEnd != null ? avgFinalTierHpRemoved?.[modalEnd.tier] : null;

  // Debugging run? enemyScale is captured into meta at run time (ratio; 1 = official).
  const enemyScale = meta.enemyScale;
  const isScaledRun = typeof enemyScale === 'number' && enemyScale !== 1;

  // -- DPS by build (debugging: find the underperformers) --------------------
  // avgPlayerDps: { [hrid]: dps } is a new aggregate field (absent on older
  // engine builds); meta.hridToBuild: { [hrid]: { buildId, buildName } } is
  // captured by the UI at run time (absent on older stored results). The
  // section renders only when BOTH exist; hrids missing from the map (e.g. a
  // roster edited mid-flight) group under "Unknown".
  const avgPlayerDps = agg.avgPlayerDps || null;
  const hridToBuild = meta.hridToBuild || null;
  const hasDpsByBuild =
    !!avgPlayerDps && Object.keys(avgPlayerDps).length > 0 &&
    !!hridToBuild && Object.keys(hridToBuild).length > 0;

  let dpsRows = [];
  let dpsGrandTotal = 0;
  if (hasDpsByBuild) {
    const groups = new Map(); // buildId (or '__unknown') → accumulator
    for (const [hrid, dps] of Object.entries(avgPlayerDps)) {
      const link = hridToBuild[hrid];
      const key = link?.buildId || '__unknown';
      const group = groups.get(key) || {
        key,
        name: link?.buildName || 'Unknown',
        copies: 0,
        total: 0,
      };
      group.copies += 1;
      group.total += Number(dps) || 0;
      groups.set(key, group);
    }
    dpsRows = [...groups.values()]
      .map(g => ({ ...g, avgPerCopy: g.copies > 0 ? g.total / g.copies : 0 }))
      .sort((a, b) => b.total - a.total);
    dpsGrandTotal = dpsRows.reduce((sum, g) => sum + g.total, 0);
  }

  // Tier rows: union of clear-probability and ended-at keys, so a tier where
  // every run died without ever clearing anything still gets a row.
  const tiers = [...new Set([
    ...Object.keys(agg.perTierClearProbability || {}),
    ...Object.keys(endedAtTierCount || {})
  ])]
    .map(Number)
    .sort((a, b) => a - b);

  const distKeys = Object.keys(agg.maxTierDistribution || {})
    .map(Number)
    .sort((a, b) => a - b);
  const maxDistCount = distKeys.reduce(
    (m, k) => Math.max(m, agg.maxTierDistribution[k] || 0),
    1
  );

  // expectedMaxTierCleared is a LEVEL-valued mean (runs that cleared nothing
  // contribute 0), so it may be non-integral and even sit below Lv 100.
  // Render level-first; add the ≈tier-index only when it is meaningful.
  const expMaxLevel = agg.expectedMaxTierCleared || 0;
  const expMaxValue =
    expMaxLevel >= TIER_BASE_LEVEL
      ? `Lv ${expMaxLevel.toFixed(1)} (≈T${levelToTierIndex(expMaxLevel).toFixed(1)})`
      : `Lv ${expMaxLevel.toFixed(1)}`;

  const kpis = [
    { label: 'Expected max cleared', value: expMaxValue },
    { label: 'Expected tiers cleared', value: (agg.expectedTiersCleared || 0).toFixed(2) },
    // "completed" = cleared the cap tier (300) and ended the run. There are no
    // re-clears: completedRate + wipeRate + timeoutRate ≈ 1. completedRate may
    // be undefined against a pre-amendment engine build ⇒ render as 0.
    { label: 'Completed rate', value: pct(agg.completedRate) },
    { label: 'Wipe rate', value: pct(agg.wipeRate) },
    { label: 'Timeout rate', value: pct(agg.timeoutRate) },
    { label: 'Guild points (exp.)', value: Math.round(agg.expectedGuildPoints || 0).toLocaleString() },
    { label: 'Tokens / participant', value: (agg.expectedTokensPerParticipant || 0).toFixed(1) },
    // avgPartyDps is a new aggregate field — only card it when present.
    ...(agg.avgPartyDps != null
      ? [{ label: 'Party DPS', value: fmtDps(agg.avgPartyDps) }]
      : []),
  ];

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Title order={4}>Guild Trial — {meta.trialName || 'Results'}</Title>
        <Group gap="xs">
          {isScaledRun && (
            <Badge
              variant="filled"
              color="orange"
              title="Enemy effective level was scaled — debugging run, NOT an official projection"
            >
              DEBUG · enemy scale {Math.round(enemyScale * 100)}%
            </Badge>
          )}
          <Badge variant="light">Start {formatTier(meta.startTier ?? agg.startTier)}</Badge>
          <Badge variant="light" color="grape">{meta.participantCount ?? '—'} participants</Badge>
          <Badge variant="light" color="teal">{agg.iterations} runs</Badge>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
        {kpis.map(k => (
          <KpiCard key={k.label} label={k.label} value={k.value} />
        ))}
      </SimpleGrid>

      {modalEnd && (
        <Text size="sm">
          Most runs ended at <Text span fw={700}>{formatTier(modalEnd.tier)}</Text>
          {modalHpRemoved != null && (
            <> with <Text span fw={700}>{pct(modalHpRemoved)}</Text> of the encounter&apos;s HP removed (avg)</>
          )}
          {' '}
          <Text span c="dimmed">
            ({modalEnd.count}/{agg.iterations} runs)
          </Text>
        </Text>
      )}

      <div>
        <Text size="sm" fw={600} mb={6}>Tier ladder</Text>
        {tiers.length === 0 ? (
          <Text size="sm" c="dimmed">No tiers attempted.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tier</Table.Th>
                <Table.Th>P(clear)</Table.Th>
                <Table.Th ta="right">Avg time</Table.Th>
                <Table.Th ta="right">Deaths at tier</Table.Th>
                {hasEndDiagnostics && (
                  <Table.Th ta="right" title="Avg fraction of the in-progress encounter's HP removed by runs that ENDED at this tier">
                    HP removed when ended here
                  </Table.Th>
                )}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tiers.map(t => {
                const p = agg.perTierClearProbability?.[t] || 0;
                const endedHere = endedAtTierCount?.[t] || 0;
                const hpRemoved = avgFinalTierHpRemoved?.[t];
                return (
                  <Table.Tr key={t}>
                    <Table.Td fw={600} style={{ whiteSpace: 'nowrap' }}>{formatTier(t)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Progress value={p * 100} w={120} color={p >= 0.5 ? 'teal' : 'orange'} />
                        <Text size="xs" ff="monospace">{pct(p)}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right">{seconds(agg.avgTimePerTierMs?.[t])}</Table.Td>
                    <Table.Td ta="right">{agg.deathsByTier?.[t] || 0}</Table.Td>
                    {hasEndDiagnostics && (
                      <Table.Td ta="right">
                        {endedHere > 0 && hpRemoved != null ? (
                          <>
                            <Text span size="sm" ff="monospace">{pct(hpRemoved)}</Text>{' '}
                            <Text span size="xs" c="dimmed">({endedHere})</Text>
                          </>
                        ) : (
                          '—'
                        )}
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </div>

      {hasDpsByBuild && (
        <div>
          <Text size="sm" fw={600} mb={6}>DPS by build</Text>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Build</Table.Th>
                <Table.Th ta="right">Copies</Table.Th>
                <Table.Th ta="right" title="Mean per-unit DPS across this build's copies (each unit's DPS is its mean over iterations of damage / run duration)">
                  Avg DPS / copy
                </Table.Th>
                <Table.Th ta="right">Total DPS</Table.Th>
                <Table.Th>Share</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {dpsRows.map(row => {
                const share = dpsGrandTotal > 0 ? row.total / dpsGrandTotal : 0;
                return (
                  <Table.Tr key={row.key}>
                    <Table.Td fw={600}>{row.name}</Table.Td>
                    <Table.Td ta="right">{row.copies}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{fmtDps(row.avgPerCopy)}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{fmtDps(row.total)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Progress value={share * 100} w={120} color="indigo" />
                        <Text size="xs" ff="monospace">{pct(share)}</Text>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed" mt={6}>
            Σ builds: {fmtDps(dpsGrandTotal)} DPS
            {agg.avgPartyDps != null && <> · party avg: {fmtDps(agg.avgPartyDps)} DPS</>}
            {' '}— per-unit DPS is averaged over iterations (damage ÷ run duration).
          </Text>
        </div>
      )}

      <div>
        <Text size="sm" fw={600} mb={6}>Max tier reached (distribution)</Text>
        <Stack gap={4}>
          {distKeys.map(k => {
            const count = agg.maxTierDistribution[k] || 0;
            const share = agg.maxTierDistributionPct?.[k] || 0;
            return (
              <Group key={k} gap="xs" wrap="nowrap">
                <Text size="xs" w={110} ta="right" style={{ whiteSpace: 'nowrap' }}>
                  {k === 0 ? 'None' : formatTier(k)}
                </Text>
                <Progress
                  value={(count / maxDistCount) * 100}
                  w={220}
                  color={k === 0 ? 'red' : 'indigo'}
                />
                <Text size="xs" ff="monospace">{count} ({pct(share)})</Text>
              </Group>
            );
          })}
        </Stack>
        <Text size="xs" c="dimmed" mt={6}>
          &quot;None&quot; = runs that never cleared the starting tier.
        </Text>
      </div>
    </Stack>
  );
}
