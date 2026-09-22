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
import { listRosterEntries, buildSummary, refKey, MAX_ROW_COUNT } from '../utils/roster';
import { listLoadoutRefs } from '../utils/characterStore';
import { exportFormatToPlayer } from '../utils/importSet';
import { describeShrines, ownsShrines } from '../utils/guildBuffs';

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
// stamp, affordances to seed seats (from P1–P5, any stored character's
// loadout, blank, or an existing one), and roster JSON import/export.
//
// A row REFERENCES a (character, loadout) pair; clicking it selects the row so
// the editor (rendered by App with the existing PlayerConfig) edits that pair.
// Editing applies to all ×N participants of its row — and, for the character
// half, to every other seat and party slot wearing the same character, which is
// the whole point: a level cannot fork.
// =============================================================================

export function GuildTrialPanel({
  characters,
  roster,
  selectedEntryId,
  participantCount,
  items,
  party,
  trialConfig,
  onSelectEntry,
  onDuplicate,
  onSetCount,
  onSaveAsNew,
  onDelete,
  onDeleteLoadout,
  onAddEntryFromRef,
  onAddBuildFromSlot,
  onAddRowFromRef,
  onAddBlankBuild,
  onImportRoster,
  onImportBuild
}) {
  const [dupCount, setDupCount] = useState(20);
  const [existingRefKey, setExistingRefKey] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  // Separate modal from the roster import: this brings in a single BUILD (or a
  // group of builds) in the game/simulator export format, not a whole roster.
  const [showBuildImport, setShowBuildImport] = useState(false);
  const [buildImportText, setBuildImportText] = useState('');
  const [message, setMessage] = useState(null);

  const entries = useMemo(
    () => listRosterEntries(roster, characters),
    [roster, characters]
  );

  // Every (character, loadout) pair in the store. There is no separate loadout
  // store to re-read any more — this IS the store the party slots use.
  const allRefs = useMemo(() => listLoadoutRefs(characters), [characters]);
  const buildOptions = useMemo(
    () => allRefs.map(r => ({ value: refKey(r), label: r.label })),
    [allRefs]
  );
  const existingRef = useMemo(
    () => allRefs.find(r => refKey(r) === existingRefKey) || null,
    [allRefs, existingRefKey]
  );

  const showMessage = useCallback((text, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  // WIRE FORMAT UNCHANGED: {masterBuilds, roster, trialConfig}, exactly what
  // SCLIRoster's rosterLink.js reads. Each rostered pair is MERGED back into one
  // flat master build by resolvePlayer, which is lossy in one specific way —
  // two loadouts of one character export as two independent builds, because the
  // receiving wire has no character concept to preserve.
  const handleExport = useCallback(async () => {
    const masterBuilds = {};
    const wireRoster = [];
    for (const entry of entries) {
      if (!entry.build) continue;
      const buildId = refKey(entry).replace(/[^\w-]+/g, '_');
      masterBuilds[buildId] = { ...entry.build, id: buildId, name: entry.displayName };
      wireRoster.push({ id: entry.id, buildId, count: entry.count });
    }
    const payload = { masterBuilds, roster: wireRoster, trialConfig };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      showMessage('Roster copied to clipboard');
    } catch (err) {
      showMessage('Copy failed: ' + err.message, true);
    }
  }, [entries, trialConfig, showMessage]);

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

  // Permanently delete the LOADOUT chosen in the picker. If it is currently
  // rostered, deleting also removes its row(s), so confirm first; unrostered
  // loadouts delete without ceremony. The CHARACTER survives either way — its
  // levels were never this loadout's to take away.
  const handleDeleteExistingBuild = useCallback(() => {
    if (!existingRef) return;
    const name = existingRef.label;
    const key = refKey(existingRef);
    const rosteredCount = (roster || [])
      .filter(e => refKey(e) === key)
      .reduce((sum, e) => sum + (Number(e.count) || 1), 0);
    if (
      rosteredCount > 0 &&
      !window.confirm(
        `Delete loadout “${name}”? It is on the roster (${rosteredCount} participant` +
          `${rosteredCount === 1 ? '' : 's'}) — that row will be removed too. ` +
          'The character keeps its levels and its other loadouts.'
      )
    ) {
      return;
    }
    onDeleteLoadout?.(existingRef);
    setExistingRefKey(null);
    showMessage(`Deleted loadout “${name}”`);
  }, [existingRef, roster, onDeleteLoadout, showMessage]);

  const slotIds = Object.keys(party || {}).map(Number).sort((a, b) => a - b);

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
        <Menu shadow="md" position="bottom-start" withinPortal={false}>
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
            <Menu.Label>From a stored character's loadout</Menu.Label>
            {allRefs.length === 0 ? (
              <Menu.Item disabled>No stored characters</Menu.Item>
            ) : (
              allRefs.map(r => (
                <Menu.Item key={refKey(r)} onClick={() => onAddRowFromRef(r)}>
                  {r.label}
                </Menu.Item>
              ))
            )}
          </Menu.Dropdown>
        </Menu>

        {buildOptions.length > 0 && (
          <Group gap={4} wrap="nowrap">
            <Select
              data={buildOptions}
              value={existingRefKey}
              onChange={setExistingRefKey}
              placeholder="Existing loadout…"
              size="xs"
              w={150}
              comboboxProps={{ withinPortal: false }}
              searchable
            />
            <Button
              variant="default"
              size="compact-xs"
              disabled={!existingRef}
              onClick={() => existingRef && onAddEntryFromRef(existingRef)}
              title="Adds one participant of this character/loadout (increments its row if already rostered)"
            >
              Add entry
            </Button>
            <Tooltip label="Delete this loadout permanently (the character survives)" withinPortal={false}>
              <ActionIcon
                size="lg"
                variant="subtle"
                color="red"
                disabled={!existingRef}
                onClick={handleDeleteExistingBuild}
                aria-label="Delete selected build"
              >
                🗑
              </ActionIcon>
            </Tooltip>
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
            Roster is empty. Add a seat from P1–P5, from a stored character's
            loadout, or import one from JSON via the “Add build” menu above —
            then crank its ×N count to fill the guild.
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
                      {/* The honesty line. The header's shrine knobs govern
                          every seat EXCEPT one whose build arrived carrying its
                          own levels; without this the reader would read the
                          header and believe it.
                          The gate is `ownsShrines`, the SAME predicate the
                          resolver uses, and must stay that way: a row that says
                          "(own)" for a build the resolver fell back on is the
                          precise lie this line exists to prevent. */}
                      {ownsShrines(entry.build) && (
                        <Text size="xs" c="dimmed" truncate>
                          shrines: {describeShrines(entry.build.guildShrines)} (own)
                        </Text>
                      )}
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
        <Button
          variant="default"
          size="compact-xs"
          onClick={handleExport}
          title={
            'Exports the interchange format SCLIRoster reads. It has no character ' +
            'concept, so two loadouts of one character travel as two independent ' +
            'builds — correct, but the grouping does not survive the trip.'
          }
        >
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
