import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  Tooltip
} from '@mantine/core';
import { listRosterEntries, buildSummary, loadSavedLoadouts, MAX_ROW_COUNT } from '../utils/roster';
import { exportFormatToPlayer } from '../utils/importSet';

// Group export format = all keys are player IDs ("1".."5") with no `player`
// key (same detection as ImportExport.isGroupFormat). Values may be nested
// JSON strings, one per participant.
function isGroupFormat(data) {
  const keys = Object.keys(data);
  return keys.length > 0 && keys.every(k => /^[1-5]$/.test(k)) && !data.player;
}

// =============================================================================
// GuildTrialPanel — the trial-mode navbar view: a compact, scrollable roster
// of COUNTED rows (one row per build, "BuildName ×20"), each with an inline
// ×N count input plus Duplicate / Save-as-new / Delete, a "Duplicate ×N"
// stamp, affordances to seed builds (from P1–P5, a saved zone/lab loadout,
// blank, or an existing/orphaned build), and roster JSON import/export.
//
// A row LINKS to a master build; clicking it selects the row so the editor
// (rendered by App with the existing PlayerConfig) edits the linked build.
// Editing a build applies to all ×N participants of its row.
// =============================================================================

export function GuildTrialPanel({
  masterBuilds,
  roster,
  selectedEntryId,
  participantCount,
  items,
  players,
  trialConfig,
  onSelectEntry,
  onDuplicate,
  onSetCount,
  onSaveAsNew,
  onDelete,
  onAddEntryFromBuild,
  onAddBuildFromSlot,
  onAddBuildFromLoadout,
  onAddBlankBuild,
  onImportRoster,
  onImportBuild
}) {
  const [dupCount, setDupCount] = useState(20);
  const [existingBuildId, setExistingBuildId] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  // Separate modal from the roster import: this brings in a single BUILD (or a
  // group of builds) in the game/simulator export format, not a whole roster.
  const [showBuildImport, setShowBuildImport] = useState(false);
  const [buildImportText, setBuildImportText] = useState('');
  const [message, setMessage] = useState(null);
  // Saved zone/lab loadouts (LoadoutManager's store) — re-read every time the
  // "Add build" menu opens so freshly-saved loadouts appear without a reload.
  const [savedLoadouts, setSavedLoadouts] = useState(() => loadSavedLoadouts());

  const entries = useMemo(
    () => listRosterEntries(roster, masterBuilds),
    [roster, masterBuilds]
  );

  const buildOptions = useMemo(
    () =>
      Object.values(masterBuilds || {})
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(b => ({ value: b.id, label: b.name })),
    [masterBuilds]
  );

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const handleExport = useCallback(async () => {
    const payload = { masterBuilds, roster, trialConfig };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      showMessage('Roster copied to clipboard');
    } catch (err) {
      showMessage('Copy failed: ' + err.message, true);
    }
  }, [masterBuilds, roster, trialConfig, showMessage]);

  const handleImport = useCallback(() => {
    try {
      const data = JSON.parse(importText);
      if (!data || typeof data !== 'object' || !data.masterBuilds || !Array.isArray(data.roster)) {
        throw new Error('Expected { masterBuilds, roster }');
      }
      onImportRoster(data);
      setShowImport(false);
      showMessage(`Imported ${data.roster.length} roster entr${data.roster.length === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      showMessage('Import failed: ' + err.message, true);
    }
  }, [importText, onImportRoster, showMessage]);

  // Import a build (or a group of builds) from the game/simulator export
  // format via exportFormatToPlayer — the same shape ImportExport accepts on
  // the other pages. Group format seeds one build per entry.
  const handleImportBuild = useCallback(() => {
    try {
      const data = JSON.parse(buildImportText);
      if (!data || typeof data !== 'object') {
        throw new Error('Expected an export-format JSON object');
      }
      if (isGroupFormat(data)) {
        const entries = Object.entries(data);
        entries.forEach(([playerId, playerJson]) => {
          const playerData = typeof playerJson === 'string' ? JSON.parse(playerJson) : playerJson;
          onImportBuild?.(exportFormatToPlayer(playerData, playerId), 'Imported build');
        });
        setShowBuildImport(false);
        showMessage(`Imported ${entries.length} build${entries.length === 1 ? '' : 's'}`);
      } else {
        onImportBuild?.(exportFormatToPlayer(data, 1), 'Imported build');
        setShowBuildImport(false);
        showMessage('Imported 1 build');
      }
    } catch (err) {
      showMessage('Import failed: ' + err.message, true);
    }
  }, [buildImportText, onImportBuild, showMessage]);

  const slotIds = Object.keys(players || {}).map(Number).sort((a, b) => a - b);

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>Roster</Text>
        <Badge variant="light" color="grape" title="Participants drive the +1% monster-HP scaling">
          {participantCount} participant{participantCount === 1 ? '' : 's'}
        </Badge>
      </Group>

      {/* Add / seed builds */}
      <Group gap={6} wrap="wrap">
        <Menu
          shadow="md"
          position="bottom-start"
          withinPortal={false}
          onOpen={() => setSavedLoadouts(loadSavedLoadouts())}
        >
          <Menu.Target>
            <Button variant="default" size="compact-xs">Add build ▾</Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>New master build</Menu.Label>
            <Menu.Item onClick={onAddBlankBuild}>Blank build</Menu.Item>
            <Menu.Item onClick={() => { setBuildImportText(''); setShowBuildImport(true); }}>
              Import from JSON…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Label>Import from zone/lab slots</Menu.Label>
            {slotIds.map(id => (
              <Menu.Item key={id} onClick={() => onAddBuildFromSlot(id)}>
                From P{id}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Label>From saved loadout</Menu.Label>
            {savedLoadouts.length === 0 ? (
              <Menu.Item disabled>No saved loadouts</Menu.Item>
            ) : (
              savedLoadouts.map(l => (
                <Menu.Item key={l.name} onClick={() => onAddBuildFromLoadout(l)}>
                  {l.name}
                </Menu.Item>
              ))
            )}
          </Menu.Dropdown>
        </Menu>

        {buildOptions.length > 0 && (
          <Group gap={4} wrap="nowrap">
            <Select
              data={buildOptions}
              value={existingBuildId}
              onChange={setExistingBuildId}
              placeholder="Existing build…"
              size="xs"
              w={150}
              comboboxProps={{ withinPortal: false }}
              searchable
            />
            <Button
              variant="default"
              size="compact-xs"
              disabled={!existingBuildId}
              onClick={() => existingBuildId && onAddEntryFromBuild(existingBuildId)}
              title="Adds one participant of this build (increments its row if already rostered)"
            >
              Add entry
            </Button>
          </Group>
        )}
      </Group>

      {/* Duplicate ×N (adds N to the selected row's count) */}
      <Group gap={6} wrap="nowrap">
        <NumberInput
          value={dupCount}
          onChange={(v) => setDupCount(Math.max(1, Math.min(MAX_ROW_COUNT, Number(v) || 1)))}
          min={1}
          max={MAX_ROW_COUNT}
          size="xs"
          w={80}
          aria-label="Clone count"
        />
        <Button
          variant="default"
          size="compact-xs"
          disabled={!selectedEntryId}
          onClick={() => selectedEntryId && onDuplicate(selectedEntryId, dupCount)}
          title={`Add ${dupCount} to the selected row's participant count (caps at ${MAX_ROW_COUNT})`}
        >
          Duplicate selected ×{dupCount}
        </Button>
      </Group>

      {/* Roster list */}
      {entries.length === 0 ? (
        <Paper p="md" radius="md" withBorder>
          <Text size="sm" c="dimmed">
            Roster is empty. Add a build from P1–P5, a saved loadout, or import
            one from JSON via the “Add build” menu above — then crank its ×N
            count to fill the guild.
          </Text>
        </Paper>
      ) : (
        <ScrollArea.Autosize mah={320} type="hover">
          <Stack gap={4}>
            {entries.map(entry => {
              const selected = entry.id === selectedEntryId;
              return (
                <Paper
                  key={entry.id}
                  p={6}
                  radius="sm"
                  withBorder
                  onClick={() => onSelectEntry(entry.id)}
                  style={{
                    cursor: 'pointer',
                    borderColor: selected ? 'var(--mantine-color-indigo-5)' : undefined,
                    background: selected ? 'var(--mantine-color-indigo-light)' : undefined
                  }}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text size="xs" fw={600} truncate>{entry.displayName}</Text>
                      <Text size="xs" c="dimmed" truncate>
                        {buildSummary(entry.build, items)}
                      </Text>
                    </div>
                    {/* Count + actions: clicks here must not toggle row selection. */}
                    <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                      <NumberInput
                        value={entry.count}
                        onChange={(v) => onSetCount(entry.id, v)}
                        min={1}
                        max={MAX_ROW_COUNT}
                        size="xs"
                        w={64}
                        prefix="×"
                        aria-label={`Participant count for ${entry.displayName}`}
                      />
                      <Tooltip label="Add one (count +1)" withinPortal={false}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          onClick={() => onDuplicate(entry.id, 1)}
                          aria-label="Add one participant"
                        >
                          ⧉
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Save as new (detach one into its own build)" withinPortal={false}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="teal"
                          onClick={() => onSaveAsNew(entry.id)}
                          aria-label="Save as new build"
                        >
                          ✎
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete row (all ×N participants)" withinPortal={false}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          onClick={() => onDelete(entry.id)}
                          aria-label="Delete row"
                        >
                          ×
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>
                </Paper>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
      )}

      {/* Roster JSON import / export */}
      <Group gap={6}>
        <Button variant="default" size="compact-xs" onClick={handleExport}>
          Export roster
        </Button>
        <Button
          variant="default"
          size="compact-xs"
          onClick={() => { setImportText(''); setShowImport(true); }}
        >
          Import roster
        </Button>
      </Group>

      {message && (
        <Text size="xs" c={message.isError ? 'red' : 'teal'}>
          {message.text}
        </Text>
      )}

      <Modal
        opened={showImport}
        onClose={() => setShowImport(false)}
        title="Import roster"
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Paste a roster JSON exported from this panel
            (<Text span ff="monospace" size="xs">{'{ masterBuilds, roster, trialConfig }'}</Text>).
            This replaces the current roster and builds.
          </Text>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste roster JSON here…"
            autosize
            minRows={8}
            maxRows={16}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setShowImport(false)}>Cancel</Button>
            <Button onClick={handleImport} disabled={!importText.trim()}>Import</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={showBuildImport}
        onClose={() => setShowBuildImport(false)}
        title="Import build from JSON"
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Paste a character export from the game or the combat simulator
            (single player, or a group of players). Each becomes a new master
            build added to the roster.
          </Text>
          <Textarea
            value={buildImportText}
            onChange={(e) => setBuildImportText(e.target.value)}
            placeholder="Paste export JSON here…"
            autosize
            minRows={8}
            maxRows={16}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setShowBuildImport(false)}>Cancel</Button>
            <Button onClick={handleImportBuild} disabled={!buildImportText.trim()}>Import</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
