import { useState, useCallback, useEffect } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { playerToExportFormat, exportFormatToPlayer } from '../utils/importSet';
import { saveSession, SESSION_KEY } from '../utils/session';

// `setSelectedPlayers` is gone from the props: its only reader was the restore
// effect, and the party selection is now restored in App's own initialiser.
export function ImportExport({
  players,
  setPlayers,
  selectedPlayers,
  activeTab,
  zone,
  setZone,
  difficultyTier,
  setDifficultyTier,
  duration,
  setDuration
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
      players,
      selectedPlayers,
      zone,
      difficultyTier,
      duration
    });
  }, [players, selectedPlayers, zone, difficultyTier, duration]);

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  // Export current player to clipboard
  const handleExportSolo = useCallback(async () => {
    const player = players[activeTab];
    const exportData = playerToExportFormat(player, zone, difficultyTier, duration);
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
      showMessage(`Player ${activeTab} exported to clipboard`);
    } catch (err) {
      showMessage('Failed to copy to clipboard: ' + err.message, true);
    }
  }, [players, activeTab, zone, difficultyTier, duration, showMessage]);

  // Export all selected players to clipboard
  const handleExportGroup = useCallback(async () => {
    const exportData = {};
    for (const playerId of selectedPlayers) {
      const player = players[playerId];
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
  }, [players, selectedPlayers, zone, difficultyTier, duration, showMessage]);

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
        // Solo format - import single player
        const player = exportFormatToPlayer(data, activeTab);
        setPlayers(prev => ({
          ...prev,
          [activeTab]: player
        }));

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
        const newPlayers = { ...players };
        let zoneSet = false;

        for (const [playerId, playerJson] of Object.entries(data)) {
          // Parse nested JSON string if needed
          const playerData = typeof playerJson === 'string' ? JSON.parse(playerJson) : playerJson;
          newPlayers[playerId] = exportFormatToPlayer(playerData, playerId);

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
        setPlayers(newPlayers);
        showMessage(`${Object.keys(data).length} player(s) imported successfully`);
      }

      setShowImportModal(false);
    } catch (err) {
      showMessage('Failed to parse import data: ' + err.message, true);
    }
  }, [importText, activeTab, players, setPlayers, setZone, setDifficultyTier, setDuration, showMessage]);

  // Clear localStorage
  const handleClearSaved = useCallback(() => {
    if (confirm('Clear all saved data from local storage?')) {
      localStorage.removeItem(SESSION_KEY);
      showMessage('Saved data cleared');
    }
  }, [showMessage]);

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
