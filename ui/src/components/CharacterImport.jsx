import { useState, useMemo, useCallback } from 'react';
import { Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { Select } from './SearchSelect';
import { useGameData } from '../hooks/useGameData';
import { characterToCharacter } from '../utils/characterToStore';
import { snapshotOptions, USERSCRIPT_URL, loadPromptDismissed, savePromptDismissed } from '../utils/characterSnapshots';
import { useSnapshots, useUserscriptStatus } from '../hooks/useSnapshots';

// =============================================================================
// CharacterImport — "Load my character": one click from a game snapshot
// (utils/characterSnapshots.js) to a fully-populated player loadout, imported
// through the same merge as before (a stored character with the same game id is
// updated, otherwise one is created).
//
// Lists every snapshot the csim-import userscript (userscript/csim-import.user.js)
// has delivered; a snapshot is as of the last game load, so reload the game to refresh.
// =============================================================================

export function CharacterImport({ activeTab, onLoadCharacter, targetLabel }) {
  const target = targetLabel || `P${activeTab}`;
  const { data: gameData } = useGameData();
  const snapshots = useSnapshots();
  // Select options by game characterId, labelled with the in-game name.
  const characters = useMemo(() => snapshotOptions(snapshots)
    .map(o => ({ ...o, data: snapshots[o.value] })), [snapshots]);
  const scriptStatus = useUserscriptStatus(characters.length);
  const [dismissed, setDismissed] = useState(loadPromptDismissed);
  const setPromptDismissed = useCallback((value) => {
    savePromptDismissed(value);
    setDismissed(value);
  }, []);
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
        `(${names.join(', ')}) → ${target}${suffix}. As of the last game load: reload the game to refresh.`
      );
    } catch (e) {
      showMessage(`Failed to load character: ${e.message}`, true);
    } finally {
      setLoading(false);
    }
  }, [current, gameData, onLoadCharacter, showMessage, target]);

  return (
    <div>
      {scriptStatus === 'missing' && !dismissed && (
        <Alert role="status" color="orange" variant="light" mb={6} p="xs" title={<Text fw={700} size="sm">Userscript not installed</Text>}>
          <Text size="xs" mb={6}>
            The csim import userscript imports your characters and computes item times from the game.
            Needs Tampermonkey or Violentmonkey; after installing, reload the game tab, then this page.
          </Text>
          <Group gap={6}>
            <Button component="a" href={USERSCRIPT_URL} target="_blank" rel="noopener noreferrer" size="xs" color="orange">
              Install userscript
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={() => setPromptDismissed(true)}>
              Dismiss
            </Button>
          </Group>
        </Alert>
      )}
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
      {scriptStatus === 'empty' && (
        <Text size="xs" c="dimmed" mt={4}>Userscript installed: reload the game tab to capture your character.</Text>
      )}
      {scriptStatus === 'missing' && dismissed && (
        <Text size="xs" c="dimmed" mt={4}>
          No game snapshots:{' '}
          <Anchor href={USERSCRIPT_URL} target="_blank" rel="noopener noreferrer" size="xs">install the csim import userscript</Anchor>{' '}
          (<Anchor component="button" type="button" size="xs" onClick={() => setPromptDismissed(false)}>show the tip</Anchor>).
        </Text>
      )}
      {message && (
        <Text size="xs" c={message.isError ? 'red' : 'teal'} mt={4}>
          {message.text}
        </Text>
      )}
    </div>
  );
}
