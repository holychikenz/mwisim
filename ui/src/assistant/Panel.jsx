import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon, Anchor, Button, CloseButton, Code, Group, Paper, ScrollArea, Text, Textarea, Title, Tooltip, UnstyledButton, VisuallyHidden,
} from '@mantine/core';
import { usePersistentState } from '../hooks/usePersistentState';
import { runAgent } from './agent';
import { describeNow, undoPatch } from './state';
import { executeTool, toolSpecs } from './tools';
import { DEFAULT_SETTINGS, isAssistantSettings } from './settings';
import { useLlm } from './useLlm';
import { useSpeech } from './useSpeech';
import { Settings } from './Settings.jsx';
import './assistant.css';

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const ClearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
  </svg>
);

const STATUS_COLOR = { applied: 'teal', started: 'teal', read: 'dimmed', 'no change': 'dimmed', failed: 'red', undone: 'dimmed' };
const argText = (args) => {
  const s = JSON.stringify(args ?? {});
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

function Chip({ chip, onUndo }) {
  return (
    <Group gap={6} wrap="wrap" className="robo-chip">
      <Code>{chip.name}({argText(chip.args)})</Code>
      <Text size="xs" fw={600} c={STATUS_COLOR[chip.status]} title={chip.status === 'failed' ? chip.content : undefined}>{chip.status}</Text>
      {chip.undo && chip.status === 'applied' && (
        <Anchor component="button" type="button" size="xs" onClick={() => onUndo(chip)} aria-label={`Undo ${chip.name}`}>Undo</Anchor>
      )}
    </Group>
  );
}

/**
 * Roboburble's chat panel: non-modal, beside the launcher. Tools apply at once
 * through the bridge; every edit gets an Undo chip. Escape closes it and the
 * launcher regains focus (Roboburble's onClose).
 */
export function Panel({ opened, onClose, bridge, avatarUrl }) {
  const [settings, setSettings] = usePersistentState('csim_ui_assistant', DEFAULT_SETTINGS, isAssistantSettings);
  const llm = useLlm(settings);
  const [messages, setMessages] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [view, setView] = useState('chat');
  const ids = useRef(0);
  const abort = useRef(null);
  const inputRef = useRef(null);
  const specs = useMemo(() => toolSpecs(), []);
  const nextId = () => ++ids.current;

  useEffect(() => { if (opened) inputRef.current?.focus(); }, [opened]);

  const clearChat = () => {
    abort.current?.abort();
    abort.current = null;   // a turn still in flight no longer belongs to this chat: it keeps nothing
    setMessages([]);
    setTranscript([]);
  };
  const onSettings = (patch) => {
    // Transcripts carry provider-specific raw turns, so a new provider or local model starts afresh.
    if ((patch.provider && patch.provider !== settings.provider) || ('localModel' in patch && patch.localModel !== llm.localModel)) clearChat();
    setSettings(s => ({ ...s, ...patch }));
  };

  const patchMessage = (id, fn) => setMessages(ms => ms.map(m => (m.id === id ? fn(m) : m)));

  const send = async (raw) => {
    const text = (raw ?? input).trim();
    if (!text || busy || !llm.ready) return;
    setInput('');
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setStatus('Thinking…');
    const aid = nextId();
    setMessages(ms => [...ms, { id: nextId(), role: 'user', text }, { id: aid, role: 'assistant', text: '', chips: [], pending: true }]);
    const execute = async (call) => {
      const state = bridge.getState();
      const out = executeTool(call, state, { gameData: state.gameData });
      let chipStatus = out.isError ? 'failed' : out.kind === 'read' ? 'read' : out.next ? 'applied' : 'no change';
      if (out.next) bridge.commit(out.next);
      if (out.action === 'run') { bridge.run(); chipStatus = 'started'; }
      patchMessage(aid, m => ({ ...m, chips: [...m.chips, { id: nextId(), name: call.name, args: call.args, status: chipStatus, content: out.content, undo: out.undo }] }));
      setStatus(out.isError ? `${call.name} failed` : chipStatus === 'applied' ? `Applied ${call.name}` : chipStatus === 'started' ? 'Run started' : 'Thinking…');
      return { id: call.id, name: call.name, isError: !!out.isError, content: out.content };
    };
    let r;
    try {
      r = await runAgent({
        llm, execute, tools: specs, signal: ac.signal,
        transcript: [...transcript, { role: 'user', text }],
        now: () => describeNow(bridge.getState()),
        onEvent: (e) => { if (e.type === 'text') patchMessage(aid, m => ({ ...m, text: e.text })); },
      });
    } catch (error) {
      r = { error };   // whatever throws, the panel must not stay busy
    }
    // A stopped or failed turn still returns the rounds it completed (runAgent): their tools already ran.
    if (r.transcript && abort.current === ac) setTranscript(r.transcript);
    if (r.stopped) {
      patchMessage(aid, m => ({ ...m, pending: false, text: m.text || 'Stopped.' }));
      setStatus('Stopped');
    } else if (r.error) {
      patchMessage(aid, m => ({ ...m, pending: false, error: true, text: r.error.message || String(r.error) }));
      setStatus(`Error: ${r.error.message || r.error}`);
    } else {
      patchMessage(aid, m => ({ ...m, pending: false, text: r.text || m.text || 'Done.' }));
      setStatus('Done');
    }
    abort.current = null;
    setBusy(false);
  };

  const undo = (chip) => {
    const patch = undoPatch(bridge.getState(), chip.undo);
    if (patch.error) { setStatus(patch.error); return; }
    // The characters as a functional update: the undo lands on the store as committed, not on the last render's copy.
    if (patch.characters) patch.characters = (prev) => undoPatch({ characters: prev }, chip.undo).characters ?? prev;
    bridge.commit(patch);
    setMessages(ms => ms.map(m => (m.chips ? { ...m, chips: m.chips.map(c => (c.id === chip.id ? { ...c, status: 'undone' } : c)) } : m)));
    setStatus(`Undid ${chip.name}`);
  };

  const speech = useSpeech({
    pref: settings.speech,
    onText: setInput,
    onFinal: (t) => { if (settings.autoSend) send(t); },
    onError: setStatus,
    onStatus: setStatus,
  });

  const setup = settings.provider === 'local'
    ? (llm.rec?.reason === 'no-webgpu'
      ? "This browser has no WebGPU, so a model can't run on this device. Add an Anthropic or OpenAI key in Settings, or use a browser with WebGPU."
      : llm.rec?.reason === 'limits'
        ? "This browser's WebGPU limits are too low for the local models. Try Chrome, or add an Anthropic or OpenAI key in Settings."
        : 'Pick a model in Settings and press Load (downloads once, then cached).')
    : 'Add your key in Settings.';

  return (
    <Paper
      id="roboburble-panel"
      role="dialog"
      aria-labelledby="roboburble-title"
      withBorder
      shadow="lg"
      radius="lg"
      className="robo-panel"
      data-hidden={!opened || undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <Group gap="xs" wrap="nowrap" className="robo-head">
        <img src={avatarUrl} alt="" width={30} height={30} />
        <Title order={6} id="roboburble-title">Roboburble</Title>
        <UnstyledButton className="robo-model" onClick={() => setView(v => (v === 'chat' ? 'settings' : 'chat'))} aria-expanded={view === 'settings'}>
          {view === 'settings' ? 'Back to chat' : `${llm.label} ▾`}
        </UnstyledButton>
        <Tooltip label="Clear chat">
          <ActionIcon variant="subtle" color="gray" onClick={clearChat} aria-label="Clear chat"><ClearIcon /></ActionIcon>
        </Tooltip>
        <CloseButton onClick={onClose} aria-label="Close assistant" />
      </Group>

      <ScrollArea className="robo-body" type="auto">
        {view === 'settings' ? (
          <Settings llm={llm} settings={settings} onSettings={onSettings} speech={speech} />
        ) : !llm.ready ? (
          <div className="robo-msgs">
            <Text size="sm">{setup}</Text>
            <Group><Button size="xs" variant="light" onClick={() => setView('settings')}>Settings</Button></Group>
          </div>
        ) : (
          <div className="robo-msgs" role="log" aria-live="polite">
            {!messages.length && (
              <Text size="xs" c="dimmed">
                Ask me to change gear, levels, food, abilities or the zone, or to run. Every edit has an Undo; undo restores
                that edit's snapshot, so it also reverts later edits to the same character or setting.
              </Text>
            )}
            {messages.map(m => (
              <div key={m.id} className="robo-msg" data-role={m.role} data-error={m.error || undefined}>
                {m.text || (m.pending ? '…' : '')}
                {m.chips?.map(c => <Chip key={c.id} chip={c} onUndo={undo} />)}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <Group gap="xs" wrap="nowrap" align="flex-end" className="robo-foot">
        <Textarea
          ref={inputRef}
          autosize
          minRows={1}
          maxRows={4}
          flex={1}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={llm.ready ? 'Ask, or press the mic and talk…' : 'Set up a model first'}
          disabled={!llm.ready}
          aria-label="Message Roboburble"
        />
        <Tooltip label="Speech input is not available in this browser" disabled={!!speech.engine}>
          <ActionIcon
            size={36}
            radius="xl"
            variant="light"
            onClick={speech.toggle}
            disabled={!speech.engine || !llm.ready}
            aria-label={speech.listening ? 'Stop listening' : 'Speak'}
            aria-pressed={speech.listening}
          >
            <MicIcon />
          </ActionIcon>
        </Tooltip>
        {busy
          ? <Button size="sm" color="red" variant="light" onClick={() => abort.current?.abort()}>Stop</Button>
          : <Button size="sm" onClick={() => send()} disabled={!llm.ready || !input.trim()}>Send</Button>}
      </Group>
      <VisuallyHidden role="status" aria-live="polite">{status}</VisuallyHidden>
    </Paper>
  );
}
