import { useMemo } from 'react';
import {
  Accordion,
  Badge,
  Group,
  Stack,
  Table,
  Text
} from '@mantine/core';

// =============================================================================
// TrialMonsterCards — a read-only reference of the monsters in the selected
// guild trial, shown in the main viewport above the results. One collapsible
// card per UNIQUE monster (a trial may list the same hrid more than once — the
// badger fields two — so duplicates collapse into a single card with a ×N
// badge). Stats are read straight off the bundled combatMonsterDetailMap:
// trials always run at difficultyTier 0, so the base JSON values ARE the
// Tier 0 · Lv 100 stats (see src/combatsimulator/guildTrial.js).
// =============================================================================

// The five attack styles carried in every monster's combatDetails. A monster
// only actually attacks with the style(s) in combatStats.combatStyleHrids; the
// other rows hold placeholder floor ratings, so we dim them (but still show
// their evasion, which matters for every incoming style).
const STYLES = [
  { key: 'stab', label: 'Stab' },
  { key: 'slash', label: 'Slash' },
  { key: 'smash', label: 'Smash' },
  { key: 'ranged', label: 'Ranged' },
  { key: 'magic', label: 'Magic' }
];

// "/damage_types/physical" → "Physical", "/combat_styles/slash" → "Slash".
function tailLabel(hrid) {
  if (!hrid) return '';
  const tail = hrid.split('/').pop().replace(/_/g, ' ');
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function num(v) {
  return Number(v || 0).toLocaleString();
}

// Preserve first-occurrence order while collapsing repeats into counts.
function dedupe(monsterHrids) {
  const order = [];
  const counts = new Map();
  for (const hrid of monsterHrids || []) {
    if (!counts.has(hrid)) order.push(hrid);
    counts.set(hrid, (counts.get(hrid) || 0) + 1);
  }
  return order.map(hrid => ({ hrid, count: counts.get(hrid) }));
}

function MonsterPanel({ monster, abilities }) {
  const cd = monster.combatDetails || {};
  const stats = cd.combatStats || {};
  const styleSet = new Set(stats.combatStyleHrids || []);
  const combatStyleLabels = (stats.combatStyleHrids || []).map(tailLabel).join(', ');
  // Trials run at difficultyTier 0, so only tier-0 abilities are in play.
  const trialAbilities = (monster.abilities || []).filter(a => (a.minDifficultyTier ?? 0) <= 0);

  return (
    <Stack gap="sm">
      <Group gap="lg" wrap="wrap">
        <Text size="sm">
          <Text span fw={600}>HP</Text> {num(cd.maxHitpoints)}
        </Text>
        <Text size="sm">
          <Text span fw={600}>Attack interval</Text> {((cd.attackInterval || 0) / 1e9).toFixed(2)}s
        </Text>
        {combatStyleLabels && (
          <Text size="sm">
            <Text span fw={600}>Style</Text> {combatStyleLabels}
          </Text>
        )}
      </Group>

      <Table withTableBorder withColumnBorders horizontalSpacing="sm" verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Style</Table.Th>
            <Table.Th>Accuracy</Table.Th>
            <Table.Th>Max dmg</Table.Th>
            <Table.Th>Evasion</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {STYLES.map(({ key, label }) => {
            const active = styleSet.has(`/combat_styles/${key}`);
            return (
              <Table.Tr key={key} c={active ? undefined : 'dimmed'}>
                <Table.Td>{label}</Table.Td>
                <Table.Td>{num(cd[`${key}AccuracyRating`])}</Table.Td>
                <Table.Td>{num(cd[`${key}MaxDamage`])}</Table.Td>
                <Table.Td>{num(cd[`${key}EvasionRating`])}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <Group gap="lg" wrap="wrap">
        <Text size="sm">
          <Text span fw={600}>Armor</Text> {num(cd.totalArmor)}
        </Text>
        <Text size="sm">
          <Text span fw={600}>Resist</Text>{' '}
          Water {num(cd.totalWaterResistance)} · Nature {num(cd.totalNatureResistance)} · Fire {num(cd.totalFireResistance)}
        </Text>
      </Group>

      {trialAbilities.length > 0 && (
        <Stack gap={4}>
          <Text size="sm" fw={600}>Abilities</Text>
          <Group gap={6} wrap="wrap">
            {trialAbilities.map((a, i) => (
              <Badge key={`${a.abilityHrid}-${i}`} variant="light" color="grape" size="sm">
                {abilities?.[a.abilityHrid]?.name || tailLabel(a.abilityHrid)} · Lv {a.level}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

export function TrialMonsterCards({ trial, monsters, abilities }) {
  const cards = useMemo(() => dedupe(trial?.monsterHrids), [trial]);

  if (!trial || cards.length === 0) return null;

  // All cards expanded by default — the reference is meant to be read at a
  // glance; users can collapse ones they don't care about.
  const defaultValue = cards.map(c => c.hrid);

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>{trial.name} — monsters</Text>
      {/* key remounts the (uncontrolled) accordion when the trial changes, so
          the new trial's cards start expanded rather than inheriting the old
          open/closed state for unfamiliar item values. */}
      <Accordion key={trial.hrid} multiple variant="separated" radius="md" defaultValue={defaultValue}>
        {cards.map(({ hrid, count }) => {
          const monster = monsters?.[hrid];
          if (!monster) return null; // skip unknown monster hrids gracefully
          const damageType = monster.combatDetails?.combatStats?.damageType;
          return (
            <Accordion.Item key={hrid} value={hrid}>
              <Accordion.Control>
                <Group gap="xs" wrap="wrap">
                  <Text size="sm" fw={600}>{monster.name}</Text>
                  {count > 1 && (
                    <Badge variant="filled" color="indigo" size="sm">×{count}</Badge>
                  )}
                  {damageType && (
                    <Badge variant="light" color="gray" size="sm">{tailLabel(damageType)}</Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {num(monster.combatDetails?.maxHitpoints)} HP
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <MonsterPanel monster={monster} abilities={abilities} />
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
      <Text size="xs" c="dimmed">
        Base stats at Tier 0 · Lv 100 — higher tiers scale stats and ability
        levels proportionally; +1% HP per participant.
      </Text>
    </Stack>
  );
}
