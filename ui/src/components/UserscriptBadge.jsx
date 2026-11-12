import { Button, CloseButton, Group, Tooltip } from '@mantine/core';
import { snapshotOptions, USERSCRIPT_URL } from '../utils/characterSnapshots';
import { useSnapshots, useUserscriptStatus, usePromptDismissed } from '../hooks/useSnapshots';

// Header badge: the first thing a visitor without the csim-import userscript sees.
// Same detection and dismissal as CharacterImport's alert (dismissing either hides both).
export function UserscriptBadge() {
  const count = snapshotOptions(useSnapshots()).length;
  const status = useUserscriptStatus(count);
  const [dismissed, setDismissed] = usePromptDismissed();
  if (status !== 'missing' || dismissed) return null;
  return (
    <Group gap={2} wrap="nowrap">
      <Tooltip
        label="Imports your characters and computes item times from the game. Needs Tampermonkey or Violentmonkey; after installing, reload the game tab, then this page."
        multiline
        w={280}
        withArrow
      >
        <Button
          component="a"
          href={USERSCRIPT_URL}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
          color="orange"
          fw={700}
        >
          ⚠ Install userscript
        </Button>
      </Tooltip>
      <CloseButton size="sm" aria-label="Dismiss the userscript install prompt" onClick={() => setDismissed(true)} />
    </Group>
  );
}
