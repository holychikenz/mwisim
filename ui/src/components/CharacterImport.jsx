import { useState, useMemo, useCallback } from 'react';
import { Button, Group, Text } from '@mantine/core';
import { Select } from './SearchSelect';
import { useGameData } from '../hooks/useGameData';
import { characterToCharacter } from '../utils/characterToStore';
import { loadSnapshots } from '../utils/characterSnapshots';

// =============================================================================
// CharacterImport — "Load my character": one click from a stored character's
// game snapshot (utils/characterSnapshots.js) to a fully-populated player
// loadout, re-imported through the same merge as before.
//
// Lists the stored characters (characterStore) that have a snapshot. Snapshots
// come from the csim-import userscript, which is not built yet, so until then
// the list is empty; stored characters keep working through LoadoutManager.
// =============================================================================

export function CharacterImport({ activeTab, onLoadCharacter, targetLabel, characters: store }) {
  const target = targetLabel || `P${activeTab}`;
  const { data: gameData } = useGameData();
  const snapshots = useMemo(loadSnapshots, []);
  // The stored characters with a snapshot (by game characterId), as Select options.
  const characters = useMemo(() => Object.values(store?.characters || {})
    .filter(c => c?.game?.id != null && snapshots[c.game.id])
    .map(c => ({ value: c.id, label: c.name, data: snapshots[c.game.id] })), [store, snapshots]);
  const [selected, setSelected] = useState(null);
  const current = characters.find(c => c.value === selected) || characters[0] || null;
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  const handleLoad = useCallback(async () => {
    if (!current) return;
    const characterData = current.data;
    // The in-game name, as the webapp import used: a rename then lands on the old record with the new name.
    const name = characterData.character?.name || current.label;
    setLoading(true);
    try {
      // EVERY combat loadout the character owns comes across, not just the
      // active one — the two-level model has somewhere to put them all. The
      // slot is bound to whichever one the game is actually running.
      const { character, defaultLoadoutName, skipped } = characterToCharacter(
        characterData,
        gameData,
        name
      );
      onLoadCharacter(character, defaultLoadoutName);

      const skippedCount = Object.values(skipped).reduce((n, arr) => n + arr.length, 0);
      const suffix = skippedCount > 0 ? ` (${skippedCount} unknown item(s) skipped)` : '';
      const names = Object.keys(character.loadouts);
      showMessage(
        `Loaded ${name} — ${names.length} loadout${names.length === 1 ? '' : 's'} ` +
        `(${names.join(', ')}) → ${target}${suffix}`
      );
    } catch (e) {
      showMessage(`Failed to load character: ${e.message}`, true);
    } finally {
      setLoading(false);
    }
  }, [current, gameData, onLoadCharacter, showMessage, target]);

  return (
    <div>
      <Group gap={6} wrap="nowrap" align="flex-end">
        <Select
          label="Load my character"
          data={characters.map(({ value, label }) => ({ value, label }))}
          value={current?.value ?? null}
          onChange={setSelected}
          placeholder={characters.length ? 'Character…' : 'No game snapshots yet'}
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
          disabled={!current}
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
