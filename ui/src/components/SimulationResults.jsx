import { useMemo, useCallback } from 'react';
import { Accordion, Badge, Button, Group, Progress, ScrollArea, SimpleGrid, Stack, Table, Tabs, Text, Title } from '@mantine/core';
import { DropsEconomy } from './DropsEconomy';
import { NumTd, Section, StatGroup } from './ResultParts';
import { nameOf } from '../utils/names';
import { effectiveRatePerHour, summariseConsumableCost } from '../utils/consumableCosts';
import { formatSeconds } from '../utils/triggerOptimizer';
import { usePersistentState } from '../hooks/usePersistentState';

const LAB_TABS = ['labstats', 'outcomes'];
const COMMON_TABS = ['experience', 'kills', 'drops', 'consumables', 'damage'];
const RESULT_TABS = [...LAB_TABS, ...COMMON_TABS];
// null = the user has not picked a tab yet, so each kind of run opens on its
// own natural first tab.
const isResultTab = (v) => v === null || RESULT_TABS.includes(v);

const ONE_SECOND = 1e9;
const ONE_HOUR = 60 * 60 * ONE_SECOND;

const PLAYER_HRIDS = ['player1', 'player2', 'player3', 'player4', 'player5'];

function formatNumber(num, decimals = 2) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(decimals) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(decimals) + 'K';
  }
  return num.toFixed(decimals);
}

function lastSegment(hrid) {
  return String(hrid).split('/').pop();
}

function fmtCount(n) {
  return Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : n;
}

function SummaryStats({ results, monsters, pricing, zones }) {
  const hoursSimulated = results.simulatedTime / ONE_HOUR;

  // What the run's eating actually cost, in production time. Only the iron price
  // source can answer — coins are not commensurable with combat time — so on any
  // other source this comes back unknown and the effective rate is omitted rather
  // than printed equal to the raw one, which would read as "your food is free".
  const consumableCost = useMemo(
    () =>
      summariseConsumableCost({
        consumablesUsed: results.consumablesUsed,
        hours: hoursSimulated,
        pricing
      }),
    [results.consumablesUsed, hoursSimulated, pricing]
  );

  const kpis = [];

  if (results.isLabyrinth) {
    // Labyrinth: one attempt per getMonster() call; an attempt either
    // clears (counted in encounters) or times out after 120s.
    const attempts = results.labyAttemptCount || 0;
    const completions = results.encounters || 0;
    const timeouts = Math.max(0, attempts - completions);
    kpis.push(
      { group: 'run', lead: true, label: 'Labyrinth', value: monsters?.[results.labyrinthName]?.name || lastSegment(results.labyrinthName || '') },
      { group: 'run', label: 'Room Level', value: results.roomLevel },
      { group: 'run', label: 'Time Simulated', value: `${hoursSimulated.toFixed(2)} h` },
      { group: 'pace', lead: true, label: 'Clears/Hour', value: formatNumber(completions / hoursSimulated) },
      { group: 'pace', label: 'Timeouts/Hour', value: formatNumber(timeouts / hoursSimulated) },
      { group: 'pace', label: 'Attempts', value: fmtCount(attempts) },
      { group: 'outcome', label: 'Completion Chance', value: attempts > 0 ? `${(completions / attempts * 100).toFixed(1)}%` : '—' }
    );
  } else {
    // A dungeon is paid out per finished RUN, and inside one the engine counts
    // every cleared wave as an encounter — so "encounters per hour" there is
    // waves per hour, a number nobody is chasing. Show completed runs instead,
    // over the full simulated time: the same rate the trigger optimiser ranks a
    // dungeon on (api/lib/triggerSearch/score.js dungeonMetrics) and the All
    // Zones sweep reports as Clears/h.
    const dungeon = !!results.isDungeon;
    const ratePerHour = dungeon
      ? (results.dungeonsCompleted || 0) / hoursSimulated
      : results.encounters / hoursSimulated;
    kpis.push(
      {
        group: 'run', lead: true, label: dungeon ? 'Dungeon' : 'Zone',
        value: zones?.find(z => z.hrid === results.zoneName)?.name || lastSegment(results.zoneName || '')
      },
      { group: 'run', label: 'Difficulty', value: `T${results.difficultyTier}` },
      { group: 'run', label: 'Time Simulated', value: `${hoursSimulated.toFixed(2)} h` },
      dungeon
        ? { group: 'pace', lead: true, label: 'Completions/Hour', value: formatNumber(ratePerHour) }
        : { group: 'pace', lead: true, label: 'Encounters/Hour', value: formatNumber(ratePerHour) },
      dungeon
        ? { group: 'pace', label: 'Dungeons Completed', value: fmtCount(results.dungeonsCompleted || 0) }
        : { group: 'pace', label: 'Encounters', value: fmtCount(results.encounters) }
    );

    // The rate per hour of TOTAL time — combat plus the production owed for
    // everything eaten. The same objective the trigger optimiser ranks on, and
    // worth having here for the same reason: raw throughput cannot see the food
    // bill, so two builds that look a percent apart on it can be twenty percent
    // apart in practice. Measured on jungle_planet, a build spending 44% of its
    // time cooking made 229 encounters/hour of combat but 128 of real time.
    if (consumableCost.known) {
      const unpriced = consumableCost.unpriced.length;
      const rateNoun = dungeon ? 'Completions' : 'Encounters';
      kpis.push({
        group: 'pace',
        label: dungeon ? 'Effective Completions/Hour' : 'Effective Enc/Hour',
        value: formatNumber(effectiveRatePerHour(ratePerHour, consumableCost.secondsPerHour)),
        // A run that ate nothing owes no production time, so its effective rate
        // IS its raw rate — said plainly, rather than as "0 items priced", which
        // reads like a failure to price something.
        hint: consumableCost.nothingConsumed
          ? 'nothing consumed'
          : `${(consumableCost.timeShare * 100).toFixed(0)}% of time cooking`,
        tip: consumableCost.nothingConsumed
          ? `Nothing was eaten or drunk during this run, so no production time is owed — ` +
            `the effective rate is the raw rate.`
          : `${rateNoun} per hour of total time — combat plus the ` +
            `${formatSeconds(consumableCost.secondsPerHour)} per hour of production owed for ` +
            `everything consumed. ${consumableCost.priced.length} item` +
            `${consumableCost.priced.length === 1 ? '' : 's'} priced from your iron times` +
            `${consumableCost.overrides.length ? `, ${consumableCost.overrides.length} overridden by hand` : ''}` +
            `${unpriced ? `; ${unpriced} unpriced and counted as free` : ''}.`
      });
    }
  }

  // Total experience across every player and skill — the figure a levelling run
  // is actually chasing, and the one the per-skill table below cannot show at a
  // glance. Every value is summed rather than the seven known skill keys being
  // picked out, so a skill added by a future patch counts without an edit here.
  let experienceTotal = 0;
  for (const bySkill of Object.values(results.experienceGained || {})) {
    for (const amount of Object.values(bySkill || {})) experienceTotal += Number(amount) || 0;
  }
  const experiencePerHour = experienceTotal / hoursSimulated;

  // Raw, with the effective figure in parentheses when the food can be priced.
  // Experience is worth restating on the real clock for exactly the reason
  // encounters are: a build that out-levels another while spending half its day
  // cooking is not in fact levelling faster.
  kpis.push({
    group: 'outcome',
    lead: true,
    label: 'Experience/Hour',
    value: formatNumber(experiencePerHour),
    hint: consumableCost.known ? 'raw, combat time only' : undefined,
  });
  if (consumableCost.known) kpis.push({
    group: 'outcome',
    label: 'Effective Experience/Hour',
    value: formatNumber(effectiveRatePerHour(experiencePerHour, consumableCost.secondsPerHour)),
    tip: !consumableCost.known
      ? undefined
      : consumableCost.nothingConsumed
        ? `Total experience across every player and skill. Nothing was consumed, so no ` +
          `production time is owed and the two figures agree.`
        : `Total experience across every player and skill. The second figure is per hour of ` +
          `total time, counting the ${formatSeconds(consumableCost.secondsPerHour)} per hour of ` +
          `production owed for everything consumed.`
  });

  // Player deaths (only players that actually appear in the result)
  const totalPlayerDeaths = PLAYER_HRIDS
    .map(p => results.deaths?.[p] || 0)
    .reduce((a, b) => a + b, 0);
  kpis.push({
    group: 'outcome',
    label: 'Player Deaths/Hour',
    value: formatNumber(totalPlayerDeaths / hoursSimulated)
  });

  if (results.isDungeon) {
    // Completed runs are already up with the rate they feed.
    kpis.push(
      { group: 'outcome', label: 'Dungeons Failed', value: fmtCount(results.dungeonsFailed) },
      { group: 'outcome', label: 'Max Wave', value: results.maxWaveReached }
    );
    // Only a run-count simulation carries dungeonsTimedOut (see
    // shared/dungeonRuns.js), and only there is every run finished or failed.
    if (typeof results.dungeonsTimedOut === 'number') {
      const runs = (results.dungeonsCompleted || 0) + (results.dungeonsFailed || 0);
      kpis.push(
        { group: 'outcome', label: 'Completion Rate', value: runs > 0 ? `${((results.dungeonsCompleted || 0) / runs * 100).toFixed(1)}%` : '—' },
        { group: 'outcome', label: 'Timed Out', value: fmtCount(results.dungeonsTimedOut) }
      );
    }
  }

  if (results.maxEnrageStack > 0) {
    kpis.push({ group: 'outcome', label: 'Max Enrage Stack', value: results.maxEnrageStack });
  }

  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
      <StatGroup title="Run" kpis={kpis.filter(k => k.group === 'run')} />
      <StatGroup title="Pace" kpis={kpis.filter(k => k.group === 'pace')} />
      <StatGroup title="Outcome" kpis={kpis.filter(k => k.group === 'outcome')} />
    </SimpleGrid>
  );
}

function ExperienceTable({ experienceGained, simulatedTime, playerNames }) {
  const players = Object.keys(experienceGained || {});
  const hoursSimulated = simulatedTime / ONE_HOUR;

  if (players.length === 0) {
    return <Text size="sm" c="dimmed">No experience data.</Text>;
  }

  const skills = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];
  const totals = Object.fromEntries(players.map(p => [
    p, skills.reduce((s, k) => s + (experienceGained[p][k] || 0), 0)
  ]));
  const partyTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  // Zero cells stay in the table (nothing is hidden) but fade, so the skills a
  // run actually trains stand out at a glance.
  const faded = { color: 'color-mix(in srgb, var(--mantine-color-dimmed) 55%, transparent)' };

  return (
    <Stack gap="sm">
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Player</Table.Th>
            {skills.map(s => (
              <Table.Th key={s} ta="right" style={{ textTransform: 'capitalize' }}>{s}</Table.Th>
            ))}
            <Table.Th ta="right">Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {players.map(player => {
            const exp = experienceGained[player];
            return (
              <Table.Tr key={player}>
                <Table.Td>{playerNames?.[player] || player}</Table.Td>
                {skills.map(s => {
                  const v = exp[s] || 0;
                  return (
                    <Table.Td key={s} ta="right" fw={v > 0 ? 600 : undefined} style={v > 0 ? undefined : faded}>
                      {formatNumber(v / hoursSimulated)}/hr
                    </Table.Td>
                  );
                })}
                <Table.Td ta="right" fw={700}>{formatNumber(totals[player] / hoursSimulated)}/hr</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {players.length > 1 && partyTotal > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">Share of party experience</Text>
          {players.map(player => {
            const share = totals[player] / partyTotal;
            return (
              <Group key={player} gap="sm" wrap="nowrap">
                <Text size="sm" w={160} truncate>{playerNames?.[player] || player}</Text>
                <Progress value={share * 100} color="sand" size="sm" style={{ flex: 1 }} />
                <Text size="sm" w={56} ta="right">{(share * 100).toFixed(1)}%</Text>
              </Group>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

function KillsTable({ deaths, monsters, simulatedTime, playerNames }) {
  const hoursSimulated = simulatedTime / ONE_HOUR;

  const monsterRows = useMemo(() => {
    return Object.entries(deaths || {})
      .filter(([hrid]) => !PLAYER_HRIDS.includes(hrid))
      .map(([hrid, count]) => ({
        hrid,
        name: nameOf(hrid, { monsters }),
        count,
        perHour: count / hoursSimulated
      }))
      .sort((a, b) => b.count - a.count);
  }, [deaths, monsters, hoursSimulated]);

  const playerRows = PLAYER_HRIDS
    .filter(p => (deaths?.[p] || 0) >= 0 && p in (deaths || {}))
    .map(p => ({ hrid: p, count: deaths[p], perHour: deaths[p] / hoursSimulated }));

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
      <Section title="Monster kills">
        {monsterRows.length === 0 ? (
          <Text size="sm" c="dimmed">No kills recorded.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Monster</Table.Th>
                <Table.Th ta="right">Kills</Table.Th>
                <Table.Th ta="right">Kills/Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {monsterRows.map(r => (
                <Table.Tr key={r.hrid}>
                  <Table.Td>{r.name}</Table.Td>
                  <NumTd faded={!r.count}>{fmtCount(r.count)}</NumTd>
                  <NumTd faded={!r.count}>{r.perHour.toFixed(1)}</NumTd>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>
      <Section title="Player deaths">
        {playerRows.length === 0 ? (
          <Text size="sm" c="dimmed">No player deaths. A flawless performance.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Player</Table.Th>
                <Table.Th ta="right">Deaths</Table.Th>
                <Table.Th ta="right">Deaths/Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {playerRows.map(r => (
                <Table.Tr key={r.hrid}>
                  <Table.Td>{nameOf(r.hrid, { playerNames })}</Table.Td>
                  <NumTd faded={!r.count}>{fmtCount(r.count)}</NumTd>
                  <NumTd faded={!r.count}>{r.perHour.toFixed(2)}</NumTd>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>
    </SimpleGrid>
  );
}

/** Generic per-player, per-source rate table for restoration/usage maps. */
function SourceRateTable({ title, data, simulatedTime, emptyText, names }) {
  const hoursSimulated = simulatedTime / ONE_HOUR;
  const rows = [];
  for (const [player, sources] of Object.entries(data || {})) {
    for (const [source, amount] of Object.entries(sources || {})) {
      if (!amount) continue;
      rows.push({ player, source, amount, perHour: amount / hoursSimulated });
    }
  }
  rows.sort((a, b) => a.player.localeCompare(b.player) || b.amount - a.amount);

  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">{emptyText}</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Player</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th ta="right">Total</Table.Th>
              <Table.Th ta="right">Per Hour</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={`${r.player}-${r.source}-${i}`}>
                <Table.Td>{nameOf(r.player, names)}</Table.Td>
                <Table.Td>{nameOf(r.source, names)}</Table.Td>
                <NumTd>{formatNumber(r.amount, 0)}</NumTd>
                <NumTd>{formatNumber(r.perHour)}</NumTd>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Section>
  );
}

function ConsumablesPanel({ results, items, abilities, playerNames }) {
  const hoursSimulated = results.simulatedTime / ONE_HOUR;
  const players = Object.keys(results.consumablesUsed || {});
  const names = { items, abilities, playerNames };

  return (
    <Stack gap="sm">
      <Section title="Consumables used">
        {players.length === 0 ? (
          <Text size="sm" c="dimmed">No consumables used.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Player</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th ta="right">Total Used</Table.Th>
                <Table.Th ta="right">Per Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {players.flatMap(player =>
                Object.entries(results.consumablesUsed[player]).map(([item, count]) => (
                  <Table.Tr key={`${player}-${item}`}>
                    <Table.Td>{nameOf(player, names)}</Table.Td>
                    <Table.Td>{nameOf(item, names)}</Table.Td>
                    <NumTd faded={!count}>{fmtCount(count)}</NumTd>
                    <NumTd faded={!count}>{formatNumber(count / hoursSimulated)}</NumTd>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        )}
      </Section>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
        <SourceRateTable
          title="Health restored"
          data={results.hitpointsGained}
          simulatedTime={results.simulatedTime}
          emptyText="No healing recorded."
          names={names}
        />
        <SourceRateTable
          title="Mana restored"
          data={results.manapointsGained}
          simulatedTime={results.simulatedTime}
          emptyText="No mana restoration recorded."
          names={names}
        />
        <SourceRateTable
          title="Mana used"
          data={results.manaUsed}
          simulatedTime={results.simulatedTime}
          emptyText="No mana usage recorded."
          names={names}
        />
        <SourceRateTable
          title="Hitpoints spent (blood magic etc.)"
          data={results.hitpointsSpent}
          simulatedTime={results.simulatedTime}
          emptyText="No hitpoints spent."
          names={names}
        />
      </SimpleGrid>
    </Stack>
  );
}

function DamageBreakdown({ attacks, names }) {
  const breakdown = useMemo(() => {
    if (!attacks) return [];
    const results = [];

    for (const [source, targets] of Object.entries(attacks)) {
      for (const [target, abilities] of Object.entries(targets)) {
        for (const [ability, hits] of Object.entries(abilities)) {
          let totalDamage = 0;
          let totalHits = 0;
          let misses = 0;

          for (const [damage, count] of Object.entries(hits)) {
            if (damage === 'miss') {
              misses += count;
            } else {
              totalDamage += Number(damage) * count;
              totalHits += count;
            }
          }

          results.push({
            source,
            target,
            ability,
            totalDamage,
            totalHits,
            misses,
            avgDamage: totalHits > 0 ? totalDamage / totalHits : 0,
            hitRate: totalHits + misses > 0 ? (totalHits / (totalHits + misses) * 100) : 0
          });
        }
      }
    }

    return results.sort((a, b) => b.totalDamage - a.totalDamage);
  }, [attacks]);

  if (breakdown.length === 0) {
    return <Text size="sm" c="dimmed">No damage data.</Text>;
  }

  const CAP = 30;
  return (
    <Section
      title="Damage by source, target and ability"
      right={breakdown.length > CAP && (
        <Text size="xs" c="dimmed">Top {CAP} of {breakdown.length} rows by total damage</Text>
      )}
    >
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Source</Table.Th>
            <Table.Th>Target</Table.Th>
            <Table.Th>Ability</Table.Th>
            <Table.Th ta="right">Total Damage</Table.Th>
            <Table.Th ta="right">Hits</Table.Th>
            <Table.Th ta="right">Avg Damage</Table.Th>
            <Table.Th ta="right">Hit Rate</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {breakdown.slice(0, CAP).map((row, i) => (
            <Table.Tr key={i}>
              <Table.Td>{nameOf(row.source, names)}</Table.Td>
              <Table.Td>{nameOf(row.target, names)}</Table.Td>
              <Table.Td>{nameOf(row.ability, names)}</Table.Td>
              <NumTd faded={!row.totalDamage}>{formatNumber(row.totalDamage, 0)}</NumTd>
              <NumTd faded={!row.totalHits}>{fmtCount(row.totalHits)}</NumTd>
              <NumTd faded={!row.avgDamage}>{formatNumber(row.avgDamage, 1)}</NumTd>
              <NumTd faded={!row.hitRate}>{row.hitRate.toFixed(1)}%</NumTd>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

// ---- Lab Stats panel ----------------------------------------------------
// Renders the ACTUAL player & monster combat stats the engine used during a
// labyrinth run (captured into results.playerStats / results.monsterStats by
// the engine). Purpose: spot any divergence from the live game's lab numbers.

const ONE_SECOND_NS = 1e9;

function prettyKey(key) {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .replace(/\bHrid\b/, 'HRID')
    .replace(/\bHp\b/, 'HP')
    .replace(/\bMp\b/, 'MP')
    .trim();
}

function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function fmtStatValue(key, val) {
  if (val == null) return '—';
  if (typeof val === 'boolean') return val ? 'yes' : 'no';
  if (typeof val === 'string') return val ? lastSegment(val) : '—';
  if (typeof val !== 'number') return String(val);
  // Nanosecond time fields → seconds.
  if (/(Duration|Interval)$/.test(key)) {
    return `${Number((val / ONE_SECOND_NS).toFixed(3))}s`;
  }
  if (Number.isInteger(val)) return val.toLocaleString();
  return Number(val.toFixed(4)).toString();
}

/** Two-column key/value table of an object's scalar fields. */
function StatKVTable({ obj }) {
  if (!obj) return null;
  const entries = Object.entries(obj).filter(
    ([, v]) => v === null || typeof v !== 'object'
  );
  if (entries.length === 0) return null;
  return (
    <Table withTableBorder striped verticalSpacing={2} fz="xs" layout="fixed">
      <Table.Tbody>
        {entries.map(([k, v]) => (
          <Table.Tr key={k}>
            <Table.Td>{prettyKey(k)}</Table.Td>
            <NumTd faded={v === 0 || v == null}>{fmtStatValue(k, v)}</NumTd>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function AbilitiesTable({ abilities }) {
  if (!abilities || abilities.length === 0) {
    return <Text size="xs" c="dimmed">No abilities.</Text>;
  }
  return (
    <Table withTableBorder striped verticalSpacing={2} fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Ability</Table.Th>
          <Table.Th ta="right">Level</Table.Th>
          <Table.Th ta="right">Mana</Table.Th>
          <Table.Th ta="right">Cooldown</Table.Th>
          <Table.Th ta="right">Cast</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {abilities.map((a, i) => (
          <Table.Tr key={`${a.hrid}-${i}`}>
            <Table.Td>{a.name || lastSegment(a.hrid)}</Table.Td>
            <NumTd>{a.level}</NumTd>
            <NumTd faded={!a.manaCost}>{a.manaCost ?? 0}</NumTd>
            <NumTd faded={!a.cooldownDuration}>{fmtStatValue('cooldownDuration', a.cooldownDuration)}</NumTd>
            <NumTd faded={!a.castDuration}>{fmtStatValue('castDuration', a.castDuration)}</NumTd>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function UnitStatSections({ combatDetails }) {
  if (!combatDetails) return null;
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <div>
        <Text size="sm" fw={600} mb={4}>Derived combat details</Text>
        <StatKVTable obj={combatDetails} />
      </div>
      <div>
        <Text size="sm" fw={600} mb={4}>Combat stats</Text>
        <StatKVTable obj={combatDetails.combatStats} />
      </div>
    </SimpleGrid>
  );
}

const LEVEL_SKILLS = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];

function buffStatLabel(typeHrid) {
  return lastSegment(typeHrid)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function fmtBuffValue(b) {
  const parts = [];
  if (b.flatBoost) parts.push(`+${Number(b.flatBoost.toFixed(4))}`);
  if (b.ratioBoost) parts.push(`+${Number((b.ratioBoost * 100).toFixed(2))}%`);
  return parts.join('  ') || '—';
}

/** Base skill level → buffs → final, so base-vs-derived is unambiguous. */
function PlayerLevelsTable({ baseLevels, combatDetails }) {
  if (!baseLevels || !combatDetails) return null;
  return (
    <Table withTableBorder striped verticalSpacing={2} fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Skill</Table.Th>
          <Table.Th ta="right">Base</Table.Th>
          <Table.Th ta="right">Buffs</Table.Th>
          <Table.Th ta="right">Final (used)</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {LEVEL_SKILLS.map((s) => {
          const base = baseLevels[s] ?? 0;
          const final = combatDetails[s + 'Level'] ?? base;
          const delta = Number((final - base).toFixed(2));
          return (
            <Table.Tr key={s}>
              <Table.Td tt="capitalize">{s}</Table.Td>
              <NumTd>{base}</NumTd>
              <NumTd faded={!delta} c={delta ? 'teal' : undefined}>
                {delta ? `+${delta}` : '—'}
              </NumTd>
              <NumTd strong>{Number(final.toFixed(2))}</NumTd>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

/** Every permanent buff grouped by where it came from (Dojo, crate, ...). */
function BuffSourcesTable({ buffSources }) {
  if (!buffSources || buffSources.length === 0) {
    return <Text size="xs" c="dimmed">No permanent buffs active.</Text>;
  }
  return (
    <Table withTableBorder striped verticalSpacing={2} fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Source</Table.Th>
          <Table.Th>Stat</Table.Th>
          <Table.Th ta="right">Bonus</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {buffSources.flatMap((src) =>
          src.buffs.map((b, i) => (
            <Table.Tr key={`${src.source}-${b.typeHrid}-${i}`}>
              <Table.Td>{i === 0 ? <Text fw={600} size="xs">{src.source}</Text> : null}</Table.Td>
              <Table.Td>{buffStatLabel(b.typeHrid)}</Table.Td>
              <NumTd>{fmtBuffValue(b)}</NumTd>
            </Table.Tr>
          ))
        )}
      </Table.Tbody>
    </Table>
  );
}

function LabStatsPanel({ results, monsters, playerNames }) {
  const playerStats = results.playerStats || [];
  const monsterStats = results.monsterStats || [];

  if (playerStats.length === 0 && monsterStats.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No stat snapshot in this result. Re-run the simulation to capture the
        actual player and monster stats.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        The exact stats the engine computed and used during this labyrinth run.
        Player values include all permanent buffs active at combat start
        (house, achievements, labyrinth crates, lab-shop upgrades).
      </Text>
      <Accordion
        multiple
        defaultValue={monsterStats.map((_, i) => `monster-${i}`)}
        variant="separated"
        radius="md"
      >
        {playerStats.map((p, i) => (
          <Accordion.Item key={`player-${i}`} value={`player-${i}`}>
            <Accordion.Control>
              <Group gap="xs">
                <Text fw={600}>{nameOf(p.hrid, { playerNames })}</Text>
                {p.combatStyleHrid && (
                  <Badge size="sm" variant="light">{nameOf(p.combatStyleHrid)}</Badge>
                )}
                <Badge size="sm" variant="light" color="red">HP {fmtInt(p.combatDetails?.maxHitpoints)}</Badge>
                <Badge size="sm" variant="light" color="blue">MP {fmtInt(p.combatDetails?.maxManapoints)}</Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="md">
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                  <div>
                    <Text size="sm" fw={600} mb={4}>Levels (base → final)</Text>
                    <PlayerLevelsTable baseLevels={p.baseLevels} combatDetails={p.combatDetails} />
                  </div>
                  <div>
                    <Text size="sm" fw={600} mb={4}>Buffs by source</Text>
                    <BuffSourcesTable buffSources={p.buffSources} />
                  </div>
                </SimpleGrid>
                <UnitStatSections combatDetails={p.combatDetails} />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}

        {monsterStats.map((m, i) => (
          <Accordion.Item key={`monster-${i}`} value={`monster-${i}`}>
            <Accordion.Control>
              <Group gap="xs">
                <Text fw={600}>{nameOf(m.hrid, { monsters })}</Text>
                <Badge size="sm" variant="light" color="grape">Room Lv {m.roomLevel}</Badge>
                <Badge size="sm" variant="light" color="red">HP {fmtInt(m.combatDetails?.maxHitpoints)}</Badge>
                <Badge size="sm" variant="light">{(m.abilities?.length || 0)} abilities</Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="md">
                <UnitStatSections combatDetails={m.combatDetails} />
                <div>
                  <Text size="sm" fw={600} mb={4}>Abilities</Text>
                  <AbilitiesTable abilities={m.abilities} />
                </div>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}

// Per-room labyrinth outcome log. One row per RESOLVED room (win / death /
// timeout) with the monster's HP% remaining at the moment the room ended —
// 0 on a clear, the surviving fraction on a death or timeout. The data comes
// from simResult.labRoomOutcomes, recorded by the engine. The final,
// window-truncated room is intentionally absent (it never resolved).
function LabOutcomesPanel({ results }) {
  const outcomes = useMemo(
    () => (Array.isArray(results.labRoomOutcomes) ? results.labRoomOutcomes : []),
    [results.labRoomOutcomes]
  );

  const summary = useMemo(() => {
    const c = { win: 0, death: 0, timeout: 0 };
    for (const o of outcomes) c[o.outcome] = (c[o.outcome] || 0) + 1;
    return c;
  }, [outcomes]);

  if (outcomes.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No per-room outcomes recorded. Run a labyrinth simulation to capture them.
      </Text>
    );
  }

  const CAP = 1000;
  const shown = outcomes.slice(0, CAP);
  const colorOf = (o) => (o === 'win' ? 'teal' : o === 'timeout' ? 'yellow' : 'red');
  const labelOf = (o) => (o === 'win' ? 'WIN' : o === 'timeout' ? 'TIMEOUT' : 'DEATH');

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <StatGroup
          title="Rooms"
          kpis={[
            { lead: true, label: 'Clears', value: fmtCount(summary.win) },
            { label: 'Deaths', value: fmtCount(summary.death) },
            { label: 'Timeouts', value: fmtCount(summary.timeout) },
            { label: 'Resolved rooms', value: fmtCount(outcomes.length) }
          ]}
        />
      </SimpleGrid>
      <Section
        title="Per room"
        right={<Text size="xs" c="dimmed">mob HP% remaining (0 on a clear)</Text>}
      >
        <ScrollArea h={420} type="auto">
          <Table striped highlightOnHover withTableBorder stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th ta="right">#</Table.Th>
                <Table.Th>Outcome</Table.Th>
                <Table.Th ta="right">Mob HP%</Table.Th>
                <Table.Th ta="right">Room Time (s)</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((o, i) => (
                <Table.Tr key={i}>
                  <NumTd>{i + 1}</NumTd>
                  <Table.Td>
                    <Badge color={colorOf(o.outcome)} variant="light" size="sm">{labelOf(o.outcome)}</Badge>
                  </Table.Td>
                  <NumTd faded={!o.monsterHpPct}>{(o.monsterHpPct ?? 0).toFixed(1)}%</NumTd>
                  <NumTd>{(((o.time || 0) - (o.startTime || 0)) / ONE_SECOND).toFixed(1)}</NumTd>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        {outcomes.length > CAP && (
          <Text size="xs" c="dimmed">Showing first {CAP} of {outcomes.length} rooms.</Text>
        )}
      </Section>
    </Stack>
  );
}

// `focusHrid` names the player the Drops tab answers for — the member whose
// config is open in the left panel's P-tab. Per-character drop stats (magnetic
// gloves, lucky coffee) mean the party does not share one loot table.
export function SimulationResults({ results, monsters, items, abilities, pricing, focusHrid, zones, playerNames }) {
  const handleDownload = useCallback(() => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const target = results.isLabyrinth
      ? `lab-${lastSegment(results.labyrinthName || 'unknown')}-lv${results.roomLevel}`
      : `${lastSegment(results.zoneName || 'zone')}-t${results.difficultyTier}`;
    a.download = `csim-results-${target}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  // Controlled and remembered, so a re-run (or a reload) keeps the open tab.
  // A remembered tab this run does not offer (Lab Stats after a zone run)
  // falls back without being written back, so it returns on the next Lab run.
  const [storedTab, setStoredTab] = usePersistentState('csim_ui_result_tab', null, isResultTab);
  const isLab = !!results?.isLabyrinth;
  const available = isLab ? RESULT_TABS : COMMON_TABS;
  const tab = available.includes(storedTab) ? storedTab : (isLab ? 'labstats' : 'experience');

  if (!results) return null;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={4}>Results</Title>
        <Button variant="default" size="compact-xs" onClick={handleDownload}>
          Download JSON
        </Button>
      </Group>
      <SummaryStats results={results} monsters={monsters} pricing={pricing} zones={zones} />

      <Tabs value={tab} onChange={(v) => v && setStoredTab(v)} keepMounted={false}>
        <Tabs.List>
          {results.isLabyrinth && <Tabs.Tab value="labstats">Lab Stats</Tabs.Tab>}
          {results.isLabyrinth && <Tabs.Tab value="outcomes">Outcomes</Tabs.Tab>}
          <Tabs.Tab value="experience">Experience</Tabs.Tab>
          <Tabs.Tab value="kills">Kills</Tabs.Tab>
          <Tabs.Tab value="drops">Drops</Tabs.Tab>
          <Tabs.Tab value="consumables">Consumables</Tabs.Tab>
          <Tabs.Tab value="damage">Damage</Tabs.Tab>
        </Tabs.List>

        {results.isLabyrinth && (
          <Tabs.Panel value="labstats" pt="sm">
            <LabStatsPanel results={results} monsters={monsters} playerNames={playerNames} />
          </Tabs.Panel>
        )}

        {results.isLabyrinth && (
          <Tabs.Panel value="outcomes" pt="sm">
            <LabOutcomesPanel results={results} />
          </Tabs.Panel>
        )}

        <Tabs.Panel value="experience" pt="sm">
          <ExperienceTable
            experienceGained={results.experienceGained}
            simulatedTime={results.simulatedTime}
            playerNames={playerNames}
          />
        </Tabs.Panel>

        <Tabs.Panel value="kills" pt="sm">
          <KillsTable
            deaths={results.deaths}
            monsters={monsters}
            simulatedTime={results.simulatedTime}
            playerNames={playerNames}
          />
        </Tabs.Panel>

        <Tabs.Panel value="drops" pt="sm">
          <DropsEconomy
            results={results}
            monsters={monsters}
            items={items}
            pricing={pricing}
            focusHrid={focusHrid}
            playerNames={playerNames}
          />
        </Tabs.Panel>

        <Tabs.Panel value="consumables" pt="sm">
          <ConsumablesPanel results={results} items={items} abilities={abilities} playerNames={playerNames} />
        </Tabs.Panel>

        <Tabs.Panel value="damage" pt="sm">
          <DamageBreakdown attacks={results.attacks} names={{ monsters, items, abilities, playerNames }} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
