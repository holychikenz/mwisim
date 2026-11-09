import { Suspense, useCallback, useRef, useState } from 'react';
import { ActionIcon } from '@mantine/core';
import { ChunkBoundary } from '../components/ChunkBoundary';
import { retryableLazy } from '../utils/retryableLazy';
import avatarUrl from './roboburble.svg';

// The only eager part of the assistant: a round launcher at the bottom right of
// the main pane, beside the pinned sheet (--app-shell-aside-offset), never in
// the full header. z 99 sits under AppShell's 100, so the narrow-screen sheet
// overlay covers it. The panel chunk loads on first open and then stays
// mounted, keeping the conversation and the loaded model.
const Panel = retryableLazy(() => import('./Panel').then(m => ({ default: m.Panel })));

const SPOT = { position: 'fixed', zIndex: 99, bottom: 16, right: 'calc(var(--app-shell-aside-offset, 0px) + 16px)' };
const PANEL_SPOT = { position: 'fixed', zIndex: 150, bottom: 84, right: 'calc(var(--app-shell-aside-offset, 0px) + 16px)', width: 'min(380px, calc(100vw - 32px))' };

export function Roboburble({ bridge }) {
  const launcher = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const toggle = () => { setMounted(true); setOpen(o => !o); };
  const close = useCallback(() => { setOpen(false); launcher.current?.focus(); }, []);
  return (
    <>
      <ActionIcon
        ref={launcher}
        size={56}
        radius="xl"
        variant="default"
        style={SPOT}
        onClick={toggle}
        aria-label="Roboburble assistant"
        aria-expanded={open}
        aria-controls="roboburble-panel"
      >
        <img src={avatarUrl} alt="" width={48} height={48} />
      </ActionIcon>
      {mounted && (
        <ChunkBoundary resetKey={open} renderError={(content) => open && <div className="robo-error" style={PANEL_SPOT}>{content}</div>}>
          <Suspense fallback={null}>
            <Panel opened={open} onClose={close} bridge={bridge} avatarUrl={avatarUrl} />
          </Suspense>
        </ChunkBoundary>
      )}
    </>
  );
}
