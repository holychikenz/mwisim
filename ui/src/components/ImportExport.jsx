import { useState, useCallback, useEffect } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { playerToExportFormat, exportFormatToPlayer } from '../utils/importSet';
import { saveSession, SESSION_KEY } from '../utils/session';
import { CHARACTERS_KEY } from '../utils/characterStore';
import { GUILD_TRIAL_KEY } from '../utils/roster';

// `setSelectedPlayers` is gone from the props: its only reader was the restore
// effect, and the party selection is now restored in App's own initialiser.
//
// The WIRE FORMAT IS UNCHANGED. A set is still exactly what the webpack UI and
// upstream users paste, in both directions — utils/importSet.js is not edited.
// What it does not carry is the character→loadouts GROUPING added in
// schemaVersion 2, because there is no such thing in the format: an export is
// one resolved player, and an import lands as a new character with one loadout.
export function ImportExport({
  resolvedParty,
  party,
  onImportPlayer,
  selectedPlayers,
  activeTab,
  zone,
  setZone,
  difficultyTier,
  setDifficultyTier,
  duration,
  setDuration,
  onClearSaved
}) {
  const [importText, setImportText] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [message, setMessage] = useState(null);

  // Auto-save the working session. The matching RESTORE deliberately does not
  // live here any more: it ran in an effect below this one, so on every mount
  // this save wrote the app's blank defaults over the stored session and the
  // restore read back the emptiness it had just been handed — the session never
  // once survived a reload. It is now read in App.jsx's state initialisers, the
  // same way every other persisted slice in this UI is read. See utils/session.js.
  useEffect(() => {
    saveSession({
      party,
      selectedPlayers,
      zone,
      difficultyTier,
      duration
    });
  }, [party, selectedPlayers, zone, difficultyTier, duration]);

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  // Export current player to clipboard
  const handleExportSolo = useCallback(async () => {
    const player = resolvedParty[activeTab];
    if (!player) {
      showMessage(`P${activeTab} is empty — bind a character first`, true);
      return;
    }
    const exportData = playerToExportFormat(player, zone, difficultyTier, duration);
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
      showMessage(`Player ${activeTab} exported to clipboard`);
    } catch (err) {
      showMessage('Failed to copy to clipboard: ' + err.message, true);
    }
  }, [resolvedParty, activeTab, zone, difficultyTier, duration, showMessage]);

  // Export all selected players to clipboard
  const handleExportGroup = useCallback(async () => {
    const exportData = {};
    for (const playerId of selectedPlayers) {
      const player = resolvedParty[playerId];
      if (!player) continue;
      exportData[playerId] = JSON.stringify(
        playerToExportFormat(player, zone, difficultyTier, duration)
      );
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
      showMessage(`${selectedPlayers.length} player(s) exported to clipboard`);
    } catch (err) {
      showMessage('Failed to copy to clipboard: ' + err.message, true);
    }
  }, [resolvedParty, selectedPlayers, zone, difficultyTier, duration, showMessage]);

  // Open import modal
  const handleOpenImport = useCallback(() => {
    setImportText('');
    setShowImportModal(true);
  }, []);

  // Detect if data is group format (keys are player IDs like "1", "2", etc.)
  const isGroupFormat = (data) => {
    const keys = Object.keys(data);
    // Group format has numeric string keys and no 'player' key
    return keys.length > 0 &&
           keys.every(k => /^[1-5]$/.test(k)) &&
           !data.player;
  };

  // Process import
  const handleImport = useCallback(() => {
    try {
      const data = JSON.parse(importText);

      // Auto-detect format
      const isGroup = isGroupFormat(data);

      if (!isGroup) {
        // Solo format - import single player. Adapted ON ARRIVAL into a
        // character with one loadout; the format itself is unchanged.
        onImportPlayer(activeTab, exportFormatToPlayer(data, activeTab));

        // Also import zone settings if present
        if (data.zone) {
          setZone(data.zone);
        }
        if (typeof data.difficultyTier === 'number') {
          setDifficultyTier(data.difficultyTier);
        }
        if (typeof data.simulationTime === 'number') {
          setDuration(data.simulationTime);
        }

        showMessage(`Player ${activeTab} imported successfully`);
      } else {
        // Group format - import multiple players
        let zoneSet = false;

        for (const [playerId, playerJson] of Object.entries(data)) {
          // Parse nested JSON string if needed
          const playerData = typeof playerJson === 'string' ? JSON.parse(playerJson) : playerJson;
          onImportPlayer(Number(playerId), exportFormatToPlayer(playerData, playerId));

          // Use zone from first player only
          if (!zoneSet) {
            if (playerData.zone) {
              setZone(playerData.zone);
            }
            if (typeof playerData.difficultyTier === 'number') {
              setDifficultyTier(playerData.difficultyTier);
            }
            if (typeof playerData.simulationTime === 'number') {
              setDuration(playerData.simulationTime);
            }
            zoneSet = true;
          }
        }
        showMessage(`${Object.keys(data).length} player(s) imported successfully`);
      }

      setShowImportModal(false);
    } catch (err) {
      showMessage('Failed to parse import data: ' + err.message, true);
    }
  }, [importText, activeTab, onImportPlayer, setZone, setDifficultyTier, setDuration, showMessage]);

  // Clearing is a STATE reset first and a storage wipe second: removing the
  // keys alone was undone milliseconds later by the three autosave effects,
  // which rewrote every key from the still-in-memory state. The removeItem
  // calls stay as belt-and-braces for effects that may not have run yet, and
  // `csim_guild_trial` — which this used to forget entirely — is now among
  // them. The legacy backups (csim_loadouts and the .v1 keys) are deliberately
  // NOT cleared: destroying a backup is never what "Clear Saved" means.
  const handleClearSaved = useCallback(() => {
    if (!confirm('Clear the saved session, the guild-trial roster AND every stored character (with all their loadouts) from local storage?')) return;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CHARACTERS_KEY);
    localStorage.removeItem(GUILD_TRIAL_KEY);
    onClearSaved();
    showMessage('Saved session, roster and characters cleared');
  }, [onClearSaved, showMessage]);

  return (
    <Stack gap={6}>
      <Group gap={6}>
        <Button variant="default" size="compact-xs" onClick={handleExportSolo}>
          Export P{activeTab}
        </Button>
        <Button variant="default" size="compact-xs" onClick={handleExportGroup}>
          Export All
        </Button>
        <Button variant="default" size="compact-xs" onClick={handleOpenImport}>
          Import
        </Button>
        <Button variant="default" size="compact-xs" color="red" onClick={handleClearSaved}>
          Clear Saved
        </Button>
      </Group>

      {message && (
        <Text size="xs" c={message.isError ? 'red' : 'teal'}>
          {message.text}
        </Text>
      )}

      <Modal
        opened={showImportModal}
        onClose={() => setShowImportModal(false)}
        title="Import Configuration"
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Paste JSON data exported from this UI or the original combat simulator.
            Format is auto-detected (single player or group).
          </Text>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste JSON here…"
            autosize
            minRows={8}
            maxRows={16}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setShowImportModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!importText.trim()}>
              Import
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
