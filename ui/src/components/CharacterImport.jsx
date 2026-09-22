import { useState, useEffect, useCallback } from 'react';
import { Button, Group, Select, Text } from '@mantine/core';
import { useGameData } from '../hooks/useGameData';
import { characterToCharacter } from '../utils/characterToStore';

// =============================================================================
// CharacterImport — "Load my character": one click from the cow/webapp
// character store to a fully-populated player loadout.
//
// Talks to cow/webapp (Flask, port 12345) directly — its CORS is open, so
// this works both under the Vite dev server and the static /sim/ mount on
// start-server.py. Endpoints:
//   GET /api/characters          → { characters: [name, ...] }
//   GET /api/character/raw?character=<name> → { character, characterData }
//
// Degrades gracefully when the webapp is not running.
// =============================================================================

import { IRON_API_BASE } from '../hooks/usePrices';

const COW_BASE = IRON_API_BASE;

export function CharacterImport({ activeTab, onLoadCharacter, targetLabel }) {
  const target = targetLabel || `P${activeTab}`;
  const { data: gameData } = useGameData();
  const [characters, setCharacters] = useState(null); // null = unknown/offline
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchCharacters = useCallback(async () => {
    try {
      const res = await fetch(`${COW_BASE}/api/characters`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const names = data.characters || [];
      setCharacters(names);
      setSelected(prev => prev || names[0] || null);
    } catch {
      setCharacters(null);
    }
  }, []);

  useEffect(() => {
    fetchCharacters();
  }, [fetchCharacters]);

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${COW_BASE}/api/character/raw?character=${encodeURIComponent(selected)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // EVERY combat loadout the character owns comes across, not just the
      // active one — the two-level model has somewhere to put them all. The
      // slot is bound to whichever one the game is actually running.
      const { character, defaultLoadoutName, skipped } = characterToCharacter(
        data.characterData,
        gameData,
        selected
      );
      onLoadCharacter(character, defaultLoadoutName);

      const skippedCount = Object.values(skipped).reduce((n, arr) => n + arr.length, 0);
      const suffix = skippedCount > 0 ? ` (${skippedCount} unknown item(s) skipped)` : '';
      const names = Object.keys(character.loadouts);
      showMessage(
        `Loaded ${selected} — ${names.length} loadout${names.length === 1 ? '' : 's'} ` +
        `(${names.join(', ')}) → ${target}${suffix}`
      );
    } catch (e) {
      showMessage(`Failed to load character: ${e.message}`, true);
    } finally {
      setLoading(false);
    }
  }, [selected, gameData, onLoadCharacter, showMessage, target]);

  if (characters === null) {
    // cow/webapp unreachable — stay quiet but offer a retry.
    return (
      <Group gap={6}>
        <Text size="xs" c="dimmed">cow webapp offline</Text>
        <Button variant="subtle" size="compact-xs" onClick={fetchCharacters}>
          retry
        </Button>
      </Group>
    );
  }

  return (
    <div>
      <Group gap={6} wrap="nowrap" align="flex-end">
        <Select
          label="Load my character"
          data={characters}
          value={selected}
          onChange={setSelected}
          placeholder={characters.length ? 'Character…' : 'No characters saved'}
          searchable
          size="xs"
          style={{ flex: 1 }}
          disabled={characters.length === 0}
        />
        <Button
          size="xs"
          variant="light"
          onClick={handleLoad}
          loading={loading}
          disabled={!selected}
        >
          Load → {target}
        </Button>
      </Group>
      {message && (
        <Text size="xs" c={message.isError ? 'red' : 'teal'} mt={4}>
          {message.text}
        </Text>
      )}
    </div>
  );
}
