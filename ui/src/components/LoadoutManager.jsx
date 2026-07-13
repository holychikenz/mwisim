import { useState, useCallback } from 'react';
import { ActionIcon, Button, Collapse, Group, Paper, Stack, Text, TextInput } from '@mantine/core';

const LOADOUTS_KEY = 'csim_loadouts';

// Get loadouts from localStorage
function getLoadouts() {
  try {
    return JSON.parse(localStorage.getItem(LOADOUTS_KEY)) || {};
  } catch {
    return {};
  }
}

// Save loadouts to localStorage
function saveLoadouts(loadouts) {
  localStorage.setItem(LOADOUTS_KEY, JSON.stringify(loadouts));
}

export function LoadoutManager({ player, onLoadPlayer, playerId }) {
  // Lazy initializer reads localStorage once on mount
  const [loadouts, setLoadouts] = useState(getLoadouts);
  const [saveName, setSaveName] = useState('');
  const [showManager, setShowManager] = useState(false);

  const handleSave = useCallback(() => {
    if (!saveName.trim()) return;

    const name = saveName.trim();
    const newLoadouts = {
      ...loadouts,
      [name]: {
        savedAt: new Date().toISOString(),
        player: {
          staminaLevel: player.staminaLevel,
          intelligenceLevel: player.intelligenceLevel,
          attackLevel: player.attackLevel,
          meleeLevel: player.meleeLevel,
          defenseLevel: player.defenseLevel,
          rangedLevel: player.rangedLevel,
          magicLevel: player.magicLevel,
          equipment: player.equipment,
          food: player.food,
          drinks: player.drinks,
          abilities: player.abilities,
          houseRooms: player.houseRooms || {},
          achievements: player.achievements || {}
        }
      }
    };

    saveLoadouts(newLoadouts);
    setLoadouts(newLoadouts);
    setSaveName('');
  }, [saveName, player, loadouts]);

  const handleLoad = useCallback((name) => {
    const loadout = loadouts[name];
    if (!loadout) return;

    onLoadPlayer({
      ...loadout.player,
      hrid: `player${playerId}`,
      debuffOnLevelGap: 0
    });
  }, [loadouts, onLoadPlayer, playerId]);

  const handleDelete = useCallback((name) => {
    if (!confirm(`Delete loadout "${name}"?`)) return;

    const newLoadouts = { ...loadouts };
    delete newLoadouts[name];
    saveLoadouts(newLoadouts);
    setLoadouts(newLoadouts);
  }, [loadouts]);

  const loadoutNames = Object.keys(loadouts).sort();

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
              {loadoutNames.map(name => {
                const loadout = loadouts[name];
                const savedDate = new Date(loadout.savedAt).toLocaleDateString();
                return (
                  <Paper key={name} p={6} radius="sm" withBorder>
                    <Group justify="space-between" wrap="nowrap">
                      <div style={{ minWidth: 0 }}>
                        <Text size="xs" fw={600} truncate>{name}</Text>
                        <Text size="xs" c="dimmed">{savedDate}</Text>
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
                );
              })}
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}
