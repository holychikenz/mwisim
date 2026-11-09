import { Avatar, Badge, ComboboxChevron, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { combatLevel } from '../utils/combatLevel';

// The main character, far right of the header: initials, name and CL (avatar
// only below sm). The menu switches main among the stored characters; with
// none stored it is a muted "Import character" that opens P1's sheet.
export function MainCharacterChip({ characters, main, onChange, onImport }) {
  const list = Object.values(characters?.characters || {})
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  if (!list.length) {
    return (
      <UnstyledButton onClick={onImport} aria-label="Import character">
        <Group gap={6} wrap="nowrap">
          <Avatar size="sm" />
          <Text size="sm" c="dimmed" visibleFrom="sm">Import character</Text>
        </Group>
      </UnstyledButton>
    );
  }

  return (
    <Menu position="bottom-end" shadow="md">
      <Menu.Target>
        <UnstyledButton aria-label={main ? `Main character: ${main.name || main.id}` : 'Choose main character'}>
          <Group gap={6} wrap="nowrap">
            <Avatar size="sm" color="moss" name={main?.name || main?.id} />
            <Group gap={6} wrap="nowrap" visibleFrom="sm">
              {main ? (
                <>
                  <Text size="sm" fw={600} truncate maw={140}>{main.name || main.id}</Text>
                  <Badge size="xs" variant="light">CL {combatLevel(main)}</Badge>
                </>
              ) : (
                <Text size="sm" c="dimmed">Choose main</Text>
              )}
            </Group>
            <ComboboxChevron size="xs" />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown mah={360} style={{ overflowY: 'auto' }}>
        <Menu.Label>Main character</Menu.Label>
        {list.map(c => (
          <Menu.Item
            key={c.id}
            onClick={() => onChange(c)}
            fw={c.id === main?.id ? 600 : undefined}
            rightSection={<Text size="xs" c="dimmed">CL {combatLevel(c)}</Text>}
          >
            {c.name || c.id}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
