import { Badge, Group, Progress, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { ClearResultsButton, NumTd, Section, ShareBar, StatGroup } from './ResultParts';
import { formatTier, levelToTierIndex, TIER_BASE_LEVEL } from '../utils/trialTiers';

// =============================================================================
// GuildTrialResults — renders the aggregate produced by multiWorker's
// `simulation_result_guildTrial` message (see guildTrialStats.aggregateTrialResults).
// Sections: three grouped stat cards (Climb · Ending · Rewards), a tier-ladder table, and a max-tier
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

export function GuildTrialResults({ result, onClear }) {
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
  // engine builds); meta.hridToLoadout: { [hrid]: { characterId, loadoutName,
  // label } } is captured by the UI at run time (absent on older stored
  // results). The section renders only when BOTH exist; hrids missing from the
  // map (e.g. a roster edited mid-flight) group under "Unknown".
  const avgPlayerDps = agg.avgPlayerDps || null;
  const hridToLoadout = meta.hridToLoadout || null;
  const hasDpsByBuild =
    !!avgPlayerDps && Object.keys(avgPlayerDps).length > 0 &&
    !!hridToLoadout && Object.keys(hridToLoadout).length > 0;

  let dpsRows = [];
  let dpsGrandTotal = 0;
  if (hasDpsByBuild) {
    // Grouped by the (character, loadout) pair: two loadouts of one character
    // are two different answers to "how much damage does this seat do".
    const groups = new Map();
    for (const [hrid, dps] of Object.entries(avgPlayerDps)) {
      const link = hridToLoadout[hrid];
      const key = link ? `${link.characterId}\u0000${link.loadoutName}` : '__unknown';
      const group = groups.get(key) || {
        key,
        name: link?.label || 'Unknown',
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

  // Three grouped cards; each figure keeps its own row. Party DPS is a newer
  // aggregate field, so it gets a row only when present.
  const climb = [
    { label: 'Expected tiers cleared', value: (agg.expectedTiersCleared || 0).toFixed(2), lead: true },
    { label: 'Expected max cleared', value: expMaxValue },
    ...(agg.avgPartyDps != null
      ? [{ label: 'Party DPS', value: fmtDps(agg.avgPartyDps) }]
      : []),
  ];
  // "completed" = cleared the cap tier (300) and ended the run. There are no
  // re-clears: completedRate + wipeRate + timeoutRate ≈ 1. completedRate may
  // be undefined against a pre-amendment engine build ⇒ render as 0.
  const ending = [
    { label: 'Completed rate', value: pct(agg.completedRate), lead: true },
    { label: 'Wipe rate', value: pct(agg.wipeRate) },
    { label: 'Timeout rate', value: pct(agg.timeoutRate) },
  ];
  const rewards = [
    { label: 'Guild points (exp.)', value: Math.round(agg.expectedGuildPoints || 0).toLocaleString(), lead: true },
    { label: 'Tokens / eligible member', value: (agg.expectedTokensPerEligibleMember || 0).toFixed(1) },
    { label: 'Tokens / participant (signed up)', value: (agg.expectedTokensPerParticipant || 0).toFixed(1) },
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
          <ClearResultsButton onClear={onClear} />
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <StatGroup title="Climb" kpis={climb} />
        <StatGroup title="Ending" kpis={ending} />
        <StatGroup title="Rewards" kpis={rewards} />
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

      <Section title="Tier ladder">
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
                        <Text size="xs">{pct(p)}</Text>
                      </Group>
                    </Table.Td>
                    <NumTd>{seconds(agg.avgTimePerTierMs?.[t])}</NumTd>
                    <NumTd faded={!agg.deathsByTier?.[t]}>{agg.deathsByTier?.[t] || 0}</NumTd>
                    {hasEndDiagnostics && (
                      <NumTd faded={!(endedHere > 0 && hpRemoved != null)}>
                        {endedHere > 0 && hpRemoved != null ? (
                          <>
                            <Text span size="sm">{pct(hpRemoved)}</Text>{' '}
                            <Text span size="xs" c="dimmed">({endedHere})</Text>
                          </>
                        ) : (
                          '—'
                        )}
                      </NumTd>
                    )}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Section>

      {hasDpsByBuild && (
        <Section title="DPS by build">
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
                    <NumTd>{row.copies}</NumTd>
                    <NumTd>{fmtDps(row.avgPerCopy)}</NumTd>
                    <NumTd strong>{fmtDps(row.total)}</NumTd>
                    <Table.Td>
                      <ShareBar value={share} w={200} />
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed">
            Σ builds: {fmtDps(dpsGrandTotal)} DPS
            {agg.avgPartyDps != null && <> · party avg: {fmtDps(agg.avgPartyDps)} DPS</>}
            {' '}— per-unit DPS is averaged over iterations (damage ÷ run duration).
          </Text>
        </Section>
      )}

      <Section title="Max tier reached (distribution)">
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
                  color={k === 0 ? 'red' : 'sand'}
                />
                <Text size="xs">{count} ({pct(share)})</Text>
              </Group>
            );
          })}
        </Stack>
        <Text size="xs" c="dimmed">
          &quot;None&quot; = runs that never cleared the starting tier.
        </Text>
      </Section>
    </Stack>
  );
}
