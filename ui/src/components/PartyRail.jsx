import { Badge, Checkbox, Group, Stack, Text, UnstyledButton } from '@mantine/core';

// =============================================================================
// PartyRail — the left rail: one card per party slot. A card shows who is in
// the slot (character · loadout), their combat level, what is equipped, and
// whether the slot takes part in the run. Clicking a card opens that member in
// the editor sheet; the checkbox only toggles membership of the run.
// =============================================================================

const SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

// The game's combat level: 0.1 × (sta + int + att + def + best offence)
// + 0.5 × the single best of att / def / mel / rng / mag.
function combatLevel(p) {
  const lv = Object.fromEntries(SKILLS.map(s => [s, Number(p?.[`${s}Level`]) || 1]));
  const offence = Math.max(lv.melee, lv.ranged, lv.magic);
  const best = Math.max(lv.attack, lv.defense, lv.melee, lv.ranged, lv.magic);
  return Math.floor(0.1 * (lv.stamina + lv.intelligence + lv.attack + lv.defense + offence) + 0.5 * best);
}

function MemberCard({ id, label, player, inSim, active, onSelect, onToggle, showFoodWarning }) {
  const empty = !player;
  const gear = player ? Object.values(player.equipment || {}).filter(Boolean).length : 0;
  const eats = player
    ? (player.food || []).some(Boolean) || (player.drinks || []).some(Boolean)
    : false;
  return (
    <div className="member-card" data-active={active || undefined} data-out={!inSim || undefined}>
      <Checkbox
        size="xs"
        checked={inSim}
        onChange={() => onToggle(id)}
        aria-label={`Include P${id} in the run`}
        mt={2}
      />
      <UnstyledButton onClick={() => onSelect(id)} style={{ flex: 1, minWidth: 0 }} aria-pressed={active}>
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="sm" fw={600} truncate>
            {empty ? `P${id}` : label.name}
          </Text>
          {!empty && <Badge size="xs" variant="light">CL {combatLevel(player)}</Badge>}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {empty ? 'Empty — click to set up' : `P${id} · ${label.loadout} · ${gear} gear`}
        </Text>
        {!empty && showFoodWarning && !eats && (
          <Badge size="xs" variant="light" color="yellow" mt={4}>no food or drink</Badge>
        )}
      </UnstyledButton>
    </div>
  );
}

export function PartyRail({
  slots,
  labels,
  resolvedParty,
  selectedPlayers,
  activeTab,
  sheetOpen,
  onSelect,
  onToggle,
  showFoodWarning = true,
}) {
  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.08em' }}>Party</Text>
        <Text size="xs" c="dimmed">{selectedPlayers.length} of {slots.length} in run</Text>
      </Group>
      {slots.map(id => (
        <MemberCard
          key={id}
          id={id}
          label={labels[id]}
          player={resolvedParty[id]}
          inSim={selectedPlayers.includes(id)}
          active={sheetOpen && activeTab === id}
          onSelect={onSelect}
          onToggle={onToggle}
          showFoodWarning={showFoodWarning}
        />
      ))}
    </Stack>
  );
}
