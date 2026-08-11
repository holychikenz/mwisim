import { useMemo, useCallback } from 'react';
import { Accordion, Badge, Button, Group, Paper, ScrollArea, SimpleGrid, Stack, Table, Tabs, Text, Title, Tooltip } from '@mantine/core';
import { DropsEconomy } from './DropsEconomy';
import { effectiveRatePerHour, summariseConsumableCost } from '../utils/consumableCosts';
import { formatSeconds } from '../utils/triggerOptimizer';

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

function KpiCard({ label, value, hint, tip }) {
  const card = (
    <Paper p="sm" radius="md" withBorder>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text size="lg" fw={700}>{value}</Text>
      {hint && <Text size="xs" c="dimmed">{hint}</Text>}
    </Paper>
  );

  // A card only gets a tooltip when its number needs a caveat attached — chiefly
  // the effective rate, which is meaningless without knowing what was priced.
  if (!tip) return card;
  return (
    <Tooltip label={tip} withArrow multiline w={280} position="bottom">
      {card}
    </Tooltip>
  );
}

function SummaryStats({ results, monsters, pricing }) {
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
      { label: 'Labyrinth', value: monsters?.[results.labyrinthName]?.name || lastSegment(results.labyrinthName || '') },
      { label: 'Room Level', value: results.roomLevel },
      { label: 'Time Simulated', value: `${hoursSimulated.toFixed(2)} h` },
      { label: 'Attempts', value: attempts },
      { label: 'Completion Chance', value: attempts > 0 ? `${(completions / attempts * 100).toFixed(1)}%` : '—' },
      { label: 'Clears/Hour', value: formatNumber(completions / hoursSimulated) },
      { label: 'Timeouts/Hour', value: formatNumber(timeouts / hoursSimulated) }
    );
  } else {
    const encountersPerHour = results.encounters / hoursSimulated;
    kpis.push(
      { label: 'Zone', value: lastSegment(results.zoneName || '') },
      { label: 'Difficulty', value: `T${results.difficultyTier}` },
      { label: 'Time Simulated', value: `${hoursSimulated.toFixed(2)} h` },
      { label: 'Encounters', value: results.encounters },
      { label: 'Encounters/Hour', value: formatNumber(encountersPerHour) }
    );

    // Encounters per hour of TOTAL time — combat plus the production owed for
    // everything eaten. The same objective the trigger optimiser ranks on, and
    // worth having here for the same reason: raw throughput cannot see the food
    // bill, so two builds that look a percent apart on it can be twenty percent
    // apart in practice. Measured on jungle_planet, a build spending 44% of its
    // time cooking made 229 encounters/hour of combat but 128 of real time.
    if (consumableCost.known) {
      const unpriced = consumableCost.unpriced.length;
      kpis.push({
        label: 'Effective Enc/Hour',
        value: formatNumber(effectiveRatePerHour(encountersPerHour, consumableCost.secondsPerHour)),
        hint: `${(consumableCost.timeShare * 100).toFixed(0)}% of time cooking`,
        tip:
          `Encounters per hour of total time — combat plus the ` +
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
    label: 'Experience/Hour',
    value: consumableCost.known
      ? `${formatNumber(experiencePerHour)} (${formatNumber(
          effectiveRatePerHour(experiencePerHour, consumableCost.secondsPerHour)
        )})`
      : formatNumber(experiencePerHour),
    hint: consumableCost.known ? 'raw (effective)' : undefined,
    tip: consumableCost.known
      ? `Total experience across every player and skill. The second figure is per hour of ` +
        `total time, counting the ${formatSeconds(consumableCost.secondsPerHour)} per hour of ` +
        `production owed for everything consumed.`
      : undefined
  });

  // Player deaths (only players that actually appear in the result)
  const totalPlayerDeaths = PLAYER_HRIDS
    .map(p => results.deaths?.[p] || 0)
    .reduce((a, b) => a + b, 0);
  kpis.push({
    label: 'Player Deaths/Hour',
    value: formatNumber(totalPlayerDeaths / hoursSimulated)
  });

  if (results.isDungeon) {
    kpis.push(
      { label: 'Dungeons Completed', value: results.dungeonsCompleted },
      { label: 'Dungeons Failed', value: results.dungeonsFailed },
      { label: 'Max Wave', value: results.maxWaveReached }
    );
  }

  if (results.maxEnrageStack > 0) {
    kpis.push({ label: 'Max Enrage Stack', value: results.maxEnrageStack });
  }

  return (
    <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
      {kpis.map(kpi => (
        <KpiCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} tip={kpi.tip} />
      ))}
    </SimpleGrid>
  );
}

function ExperienceTable({ experienceGained, simulatedTime }) {
  const players = Object.keys(experienceGained || {});
  const hoursSimulated = simulatedTime / ONE_HOUR;

  if (players.length === 0) {
    return <Text size="sm" c="dimmed">No experience data.</Text>;
  }

  const skills = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];

  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Player</Table.Th>
          {skills.map(s => (
            <Table.Th key={s} style={{ textTransform: 'capitalize' }}>{s}</Table.Th>
          ))}
          <Table.Th>Total</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {players.map(player => {
          const exp = experienceGained[player];
          const total = skills.reduce((s, k) => s + (exp[k] || 0), 0);
          return (
            <Table.Tr key={player}>
              <Table.Td>{player}</Table.Td>
              {skills.map(s => (
                <Table.Td key={s}>{formatNumber((exp[s] || 0) / hoursSimulated)}/hr</Table.Td>
              ))}
              <Table.Td fw={600}>{formatNumber(total / hoursSimulated)}/hr</Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

function KillsTable({ deaths, monsters, simulatedTime }) {
  const hoursSimulated = simulatedTime / ONE_HOUR;

  const monsterRows = useMemo(() => {
    return Object.entries(deaths || {})
      .filter(([hrid]) => !PLAYER_HRIDS.includes(hrid))
      .map(([hrid, count]) => ({
        hrid,
        name: monsters?.[hrid]?.name || lastSegment(hrid),
        count,
        perHour: count / hoursSimulated
      }))
      .sort((a, b) => b.count - a.count);
  }, [deaths, monsters, hoursSimulated]);

  const playerRows = PLAYER_HRIDS
    .filter(p => (deaths?.[p] || 0) >= 0 && p in (deaths || {}))
    .map(p => ({ hrid: p, count: deaths[p], perHour: deaths[p] / hoursSimulated }));

  return (
    <Stack gap="md">
      <div>
        <Text size="sm" fw={600} mb={6}>Monster kills</Text>
        {monsterRows.length === 0 ? (
          <Text size="sm" c="dimmed">No kills recorded.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Monster</Table.Th>
                <Table.Th>Kills</Table.Th>
                <Table.Th>Kills/Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {monsterRows.map(r => (
                <Table.Tr key={r.hrid}>
                  <Table.Td>{r.name}</Table.Td>
                  <Table.Td>{r.count}</Table.Td>
                  <Table.Td>{r.perHour.toFixed(1)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>
      <div>
        <Text size="sm" fw={600} mb={6}>Player deaths</Text>
        {playerRows.length === 0 ? (
          <Text size="sm" c="dimmed">No player deaths. A flawless performance.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Player</Table.Th>
                <Table.Th>Deaths</Table.Th>
                <Table.Th>Deaths/Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {playerRows.map(r => (
                <Table.Tr key={r.hrid}>
                  <Table.Td>{r.hrid}</Table.Td>
                  <Table.Td>{r.count}</Table.Td>
                  <Table.Td>{r.perHour.toFixed(2)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>
    </Stack>
  );
}

/** Generic per-player, per-source rate table for restoration/usage maps. */
function SourceRateTable({ title, data, simulatedTime, emptyText }) {
  const hoursSimulated = simulatedTime / ONE_HOUR;
  const rows = [];
  for (const [player, sources] of Object.entries(data || {})) {
    for (const [source, amount] of Object.entries(sources || {})) {
      if (!amount) continue;
      rows.push({ player, source: lastSegment(source), amount, perHour: amount / hoursSimulated });
    }
  }
  rows.sort((a, b) => a.player.localeCompare(b.player) || b.amount - a.amount);

  return (
    <div>
      <Text size="sm" fw={600} mb={6}>{title}</Text>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">{emptyText}</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Player</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th>Total</Table.Th>
              <Table.Th>Per Hour</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={`${r.player}-${r.source}-${i}`}>
                <Table.Td>{r.player}</Table.Td>
                <Table.Td>{r.source}</Table.Td>
                <Table.Td>{formatNumber(r.amount, 0)}</Table.Td>
                <Table.Td>{formatNumber(r.perHour)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}

function ConsumablesPanel({ results }) {
  const hoursSimulated = results.simulatedTime / ONE_HOUR;
  const players = Object.keys(results.consumablesUsed || {});

  return (
    <Stack gap="md">
      <div>
        <Text size="sm" fw={600} mb={6}>Consumables used</Text>
        {players.length === 0 ? (
          <Text size="sm" c="dimmed">No consumables used.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Player</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th>Total Used</Table.Th>
                <Table.Th>Per Hour</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {players.flatMap(player =>
                Object.entries(results.consumablesUsed[player]).map(([item, count]) => (
                  <Table.Tr key={`${player}-${item}`}>
                    <Table.Td>{player}</Table.Td>
                    <Table.Td>{lastSegment(item)}</Table.Td>
                    <Table.Td>{count}</Table.Td>
                    <Table.Td>{formatNumber(count / hoursSimulated)}</Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        )}
      </div>

      <SourceRateTable
        title="Health restored"
        data={results.hitpointsGained}
        simulatedTime={results.simulatedTime}
        emptyText="No healing recorded."
      />
      <SourceRateTable
        title="Mana restored"
        data={results.manapointsGained}
        simulatedTime={results.simulatedTime}
        emptyText="No mana restoration recorded."
      />
      <SourceRateTable
        title="Mana used"
        data={results.manaUsed}
        simulatedTime={results.simulatedTime}
        emptyText="No mana usage recorded."
      />
      <SourceRateTable
        title="Hitpoints spent (blood magic etc.)"
        data={results.hitpointsSpent}
        simulatedTime={results.simulatedTime}
        emptyText="No hitpoints spent."
      />
    </Stack>
  );
}

function DamageBreakdown({ attacks }) {
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
            ability: lastSegment(ability),
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

  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Source</Table.Th>
          <Table.Th>Target</Table.Th>
          <Table.Th>Ability</Table.Th>
          <Table.Th>Total Damage</Table.Th>
          <Table.Th>Hits</Table.Th>
          <Table.Th>Avg Damage</Table.Th>
          <Table.Th>Hit Rate</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {breakdown.slice(0, 30).map((row, i) => (
          <Table.Tr key={i}>
            <Table.Td>{lastSegment(row.source)}</Table.Td>
            <Table.Td>{lastSegment(row.target)}</Table.Td>
            <Table.Td>{row.ability}</Table.Td>
            <Table.Td>{formatNumber(row.totalDamage, 0)}</Table.Td>
            <Table.Td>{row.totalHits}</Table.Td>
            <Table.Td>{formatNumber(row.avgDamage, 1)}</Table.Td>
            <Table.Td>{row.hitRate.toFixed(1)}%</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
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

function playerLabel(hrid) {
  const m = /^player(\d+)$/.exec(String(hrid || ''));
  return m ? `Player ${m[1]}` : String(hrid || 'Player');
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
            <Table.Td ta="right" ff="monospace">{fmtStatValue(k, v)}</Table.Td>
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
          <Table.Th>Level</Table.Th>
          <Table.Th>Mana</Table.Th>
          <Table.Th>Cooldown</Table.Th>
          <Table.Th>Cast</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {abilities.map((a, i) => (
          <Table.Tr key={`${a.hrid}-${i}`}>
            <Table.Td>{a.name || lastSegment(a.hrid)}</Table.Td>
            <Table.Td>{a.level}</Table.Td>
            <Table.Td>{a.manaCost ?? 0}</Table.Td>
            <Table.Td>{fmtStatValue('cooldownDuration', a.cooldownDuration)}</Table.Td>
            <Table.Td>{fmtStatValue('castDuration', a.castDuration)}</Table.Td>
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
              <Table.Td ta="right" ff="monospace">{base}</Table.Td>
              <Table.Td ta="right" ff="monospace" c={delta ? 'teal' : 'dimmed'}>
                {delta ? `+${delta}` : '—'}
              </Table.Td>
              <Table.Td ta="right" ff="monospace" fw={600}>{Number(final.toFixed(2))}</Table.Td>
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
              <Table.Td ta="right" ff="monospace">{fmtBuffValue(b)}</Table.Td>
            </Table.Tr>
          ))
        )}
      </Table.Tbody>
    </Table>
  );
}

function LabStatsPanel({ results, monsters }) {
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
                <Text fw={600}>{playerLabel(p.hrid)}</Text>
                {p.combatStyleHrid && (
                  <Badge size="sm" variant="light">{lastSegment(p.combatStyleHrid)}</Badge>
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
                <Text fw={600}>{monsters?.[m.hrid]?.name || lastSegment(m.hrid)}</Text>
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
  const outcomes = Array.isArray(results.labRoomOutcomes) ? results.labRoomOutcomes : [];

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
      <Group gap="xs">
        <Badge color="teal" variant="light">{summary.win} clears</Badge>
        <Badge color="red" variant="light">{summary.death} deaths</Badge>
        <Badge color="yellow" variant="light">{summary.timeout} timeouts</Badge>
        <Text size="xs" c="dimmed">{outcomes.length} resolved rooms · mob HP% remaining (0 on a clear)</Text>
      </Group>
      <ScrollArea h={420} type="auto">
        <Table striped highlightOnHover withTableBorder stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Outcome</Table.Th>
              <Table.Th ta="right">Mob HP%</Table.Th>
              <Table.Th ta="right">Room Time (s)</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((o, i) => (
              <Table.Tr key={i}>
                <Table.Td>{i + 1}</Table.Td>
                <Table.Td>
                  <Badge color={colorOf(o.outcome)} variant="light" size="sm">{labelOf(o.outcome)}</Badge>
                </Table.Td>
                <Table.Td ta="right">{(o.monsterHpPct ?? 0).toFixed(1)}%</Table.Td>
                <Table.Td ta="right">{(((o.time || 0) - (o.startTime || 0)) / ONE_SECOND).toFixed(1)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {outcomes.length > CAP && (
        <Text size="xs" c="dimmed">Showing first {CAP} of {outcomes.length} rooms.</Text>
      )}
    </Stack>
  );
}

export function SimulationResults({ results, monsters, items, pricing }) {
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

  if (!results) return null;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={4}>Results</Title>
        <Button variant="default" size="compact-xs" onClick={handleDownload}>
          Download JSON
        </Button>
      </Group>
      <SummaryStats results={results} monsters={monsters} pricing={pricing} />

      <Tabs defaultValue={results.isLabyrinth ? 'labstats' : 'experience'} keepMounted={false}>
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
            <LabStatsPanel results={results} monsters={monsters} />
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
          />
        </Tabs.Panel>

        <Tabs.Panel value="kills" pt="sm">
          <KillsTable
            deaths={results.deaths}
            monsters={monsters}
            simulatedTime={results.simulatedTime}
          />
        </Tabs.Panel>

        <Tabs.Panel value="drops" pt="sm">
          <DropsEconomy
            results={results}
            monsters={monsters}
            items={items}
            pricing={pricing}
          />
        </Tabs.Panel>

        <Tabs.Panel value="consumables" pt="sm">
          <ConsumablesPanel results={results} />
        </Tabs.Panel>

        <Tabs.Panel value="damage" pt="sm">
          <DamageBreakdown attacks={results.attacks} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
