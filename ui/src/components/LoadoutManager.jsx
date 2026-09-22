import { useState, useCallback, useMemo } from 'react';
import { ActionIcon, Button, Collapse, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { setLoadout, splitPlayer, uniqueLoadoutName } from '../utils/characterStore';

// =============================================================================
// LoadoutManager — the CURRENT CHARACTER's named loadouts.
//
// It no longer has a store of its own. The old flat loadout blob held whole
// players, so saving a loadout copied the character's levels, houses,
// achievements and shrines alongside the gear — and loading one put that copy
// back, silently overwriting whatever the character had become in the meantime.
// A loadout now holds gear, ability slots and consumables and NOTHING ELSE
// (utils/characterStore.js `sanitizeLoadout` drops the rest physically), so a
// save cannot fork a level and a load cannot un-level you.
// =============================================================================

export function LoadoutManager({
  characters,
  setCharacters,
  slotRef,
  slotId,
  setParty,
  player,
  onDeleteLoadout,
  onDeleteCharacter,
  onRenameCharacter
}) {
  const [saveName, setSaveName] = useState('');
  const [showManager, setShowManager] = useState(false);

  const character = slotRef?.characterId ? characters?.characters?.[slotRef.characterId] : null;
  const loadoutNames = useMemo(
    () => Object.keys(character?.loadouts || {}).sort(),
    [character]
  );

  const handleSave = useCallback(() => {
    if (!saveName.trim() || !character || !player) return;
    // Only the loadout half is written. The character half is already stored and
    // is shared by every loadout, which is what makes this safe.
    const name = character.loadouts?.[saveName.trim()]
      ? saveName.trim()
      : uniqueLoadoutName(saveName.trim(), character.loadouts);
    const { loadout } = splitPlayer(player);
    setCharacters(prev => setLoadout(prev, character.id, name, loadout));
    setParty(prev => ({ ...prev, [slotId]: { characterId: character.id, loadoutName: name } }));
    setSaveName('');
  }, [saveName, character, player, setCharacters, setParty, slotId]);

  const handleLoad = useCallback((name) => {
    if (!character) return;
    // Loading is now a REBIND, not a replacement: the slot points at a different
    // loadout of the same character. Nothing is copied.
    setParty(prev => ({ ...prev, [slotId]: { characterId: character.id, loadoutName: name } }));
  }, [character, setParty, slotId]);

  const handleDelete = useCallback((name) => {
    if (!character) return;
    if (!confirm(`Delete loadout "${name}"?`)) return;
    // ONE helper, in App, rewriting the party AND the trial roster together.
    // This component used to repair its own slot and nothing else — repointing
    // it at a surviving loadout the user never chose — while App's handler
    // repaired the roster and nothing else. See utils/refRepair.js.
    onDeleteLoadout({ characterId: character.id, loadoutName: name });
  }, [character, onDeleteLoadout]);

  if (!character) {
    return (
      <Text size="xs" c="dimmed">
        Bind a character to P{slotId} to manage its loadouts.
      </Text>
    );
  }

  return (
    <Stack gap={6}>
      <Button
        variant="default"
        size="compact-xs"
        onClick={() => setShowManager(!showManager)}
      >
        {showManager ? 'Hide Loadouts' : `Loadouts (${loadoutNames.length})`}
      </Button>

      <Collapse expanded={showManager}>
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Loadouts of {character.name}. They share this character's levels,
            houses, achievements, shrines and seals — only gear, abilities and
            consumables differ.
          </Text>
          {/* Renaming and deleting the CHARACTER itself. There was no UI for
              either outside the trial panel, which made a recovered orphan
              un-removable in practice. Both are ordinary characters now. */}
          <Group gap={6} wrap="nowrap">
            <TextInput
              key={character.id}
              size="xs"
              style={{ flex: 1 }}
              defaultValue={character.name}
              onBlur={(e) =>
                onRenameCharacter(character.id, e.currentTarget.value.trim() || character.name)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            <Button
              size="compact-xs"
              color="red"
              variant="light"
              onClick={() => {
                if (confirm(`Delete character "${character.name}" and all ${loadoutNames.length} of its loadouts?`)) {
                  onDeleteCharacter(character.id);
                }
              }}
            >
              Delete character
            </Button>
          </Group>
          <Group gap={6} wrap="nowrap">
            <TextInput
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Loadout name…"
              size="xs"
              style={{ flex: 1 }}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
            <Button size="compact-xs" onClick={handleSave} disabled={!saveName.trim()}>
              Save
            </Button>
          </Group>

          {loadoutNames.length === 0 ? (
            <Text size="xs" c="dimmed">No saved loadouts</Text>
          ) : (
            <Stack gap={4}>
              {loadoutNames.map(name => (
                <Paper key={name} p={6} radius="sm" withBorder>
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" fw={600} truncate>{name}</Text>
                      {slotRef?.loadoutName === name && (
                        <Text size="xs" c="dimmed">worn by P{slotId}</Text>
                      )}
                    </div>
                    <Group gap={4} wrap="nowrap">
                      <Button size="compact-xs" variant="light" onClick={() => handleLoad(name)}>
                        Load
                      </Button>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => handleDelete(name)}
                        title={`Delete loadout ${name}`}
                      >
                        ×
                      </ActionIcon>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}
