import { useEffect } from 'react';
import {
  ActionIcon, Badge, Button, Group, PasswordInput, Progress, Radio, SegmentedControl, Stack, Switch, Text, TextInput,
} from '@mantine/core';

const fmtSize = (mb) => (mb >= 1000 ? `≈${(mb / 1000).toFixed(1)} GB` : `≈${mb} MB`);
const HOST = { anthropic: 'api.anthropic.com', openai: 'api.openai.com' };

const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);

function LocalModels({ llm, onSettings }) {
  const { rec, local, cache, localModel } = llm;
  const ids = rec?.list.map(m => m.id).join('|');
  const { refreshCache } = llm;
  // Showing cache status starts the model worker (fetched once, then HTTP-cached).
  useEffect(() => { if (ids) refreshCache(ids.split('|')); }, [ids, refreshCache]);
  if (!rec) return <Text size="sm" c="dimmed">Checking this browser for WebGPU…</Text>;
  if (rec.reason === 'no-webgpu') {
    return <Text size="sm">This browser has no WebGPU, so a model can't run on this device. Use an Anthropic or OpenAI key, or a browser with WebGPU.</Text>;
  }
  const busy = !!local.loading;
  const tooLow = rec.reason === 'limits';
  return (
    <Stack gap="xs">
      {tooLow && <Text size="sm">This GPU's WebGPU limits are too low for the local models, so none can load here. Use an Anthropic or OpenAI key; downloaded models can still be deleted below.</Text>}
      <Radio.Group value={localModel} onChange={(id) => onSettings({ localModel: id })} label="Model" description="Bigger models follow instructions better but download more.">
        <Stack gap={6} mt={6}>
          {rec.list.map(m => (
            <Radio.Card key={m.id} value={m.id} radius="md" p="xs" disabled={busy}>
              <Group wrap="nowrap" gap="xs">
                <Radio.Indicator size="xs" />
                <Text size="sm" fw={600}>{m.label}</Text>
                <Text size="xs" c="dimmed">{fmtSize(m.downloadMB)}</Text>
                <Group gap={4} ml="auto" wrap="nowrap">
                  {m.recommended && <Badge size="xs" color="moss">Recommended</Badge>}
                  {!m.fits && <Badge size="xs" color="orange" variant="light">may not fit</Badge>}
                  {cache[m.id] && <Badge size="xs" color="teal" variant="light">Downloaded</Badge>}
                  {local.loaded === m.id && <Badge size="xs" variant="outline">Loaded</Badge>}
                </Group>
              </Group>
            </Radio.Card>
          ))}
        </Stack>
      </Radio.Group>
      <Group gap="xs">
        <Button size="xs" onClick={() => llm.load(localModel)} loading={busy} disabled={tooLow || !localModel || local.loaded === localModel}>
          {local.loaded === localModel ? 'Loaded' : 'Load'}
        </Button>
        {cache[localModel] && local.loaded !== localModel && (
          <ActionIcon variant="subtle" color="red" onClick={() => llm.remove(localModel)} disabled={busy} aria-label="Delete downloaded model">
            <TrashIcon />
          </ActionIcon>
        )}
      </Group>
      {busy && (
        <>
          <Progress value={local.progress * 100} aria-label="Model download progress" />
          <Text size="xs" c="dimmed" lineClamp={2}>{local.text}</Text>
        </>
      )}
      {local.error && <Text size="xs" c="red">{local.error}</Text>}
      <Text size="xs" c="dimmed">Downloads the model from Hugging Face and its WebGPU library from GitHub (mlc-ai), once; cached in this browser.</Text>
    </Stack>
  );
}

function CloudKey({ provider, llm, settings, onSettings }) {
  const modelKey = provider === 'anthropic' ? 'anthropicModel' : 'openaiModel';
  const key = llm.keys[provider];
  return (
    <Stack gap="xs">
      <PasswordInput
        label={provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'}
        value={key}
        onChange={(e) => llm.setKey(provider, e.currentTarget.value.trim())}
        autoComplete="off"
      />
      <Text size="xs" c="dimmed">
        Stored only in this browser (localStorage) and sent only to {HOST[provider]}. Anyone with access to this browser profile can read it.
      </Text>
      <Group>
        <Button size="xs" variant="default" disabled={!key} onClick={() => llm.setKey(provider, '')}>Forget key</Button>
      </Group>
      <TextInput
        label="Model"
        value={settings[modelKey]}
        onChange={(e) => onSettings({ [modelKey]: e.currentTarget.value })}
      />
    </Stack>
  );
}

/** The panel's settings view: provider, model, keys and speech. */
export function Settings({ llm, settings, onSettings, speech }) {
  const { provider } = settings;
  return (
    <Stack gap="md" p="sm">
      <div>
        <SegmentedControl
          fullWidth
          size="xs"
          value={provider}
          onChange={(p) => onSettings({ provider: p })}
          data={[{ value: 'local', label: 'Local' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI' }]}
          aria-label="Model provider"
        />
        <Text size="xs" c="dimmed" mt={4}>Switching provider or local model clears the chat.</Text>
      </div>
      {provider === 'local'
        ? <LocalModels llm={llm} onSettings={onSettings} />
        : <CloudKey provider={provider} llm={llm} settings={settings} onSettings={onSettings} />}
      <Stack gap={6}>
        <Text size="sm" fw={600}>Speech</Text>
        <SegmentedControl
          fullWidth
          size="xs"
          value={settings.speech}
          onChange={(v) => onSettings({ speech: v })}
          data={[
            { value: 'webspeech', label: 'Browser speech', disabled: !speech.available.webspeech },
            { value: 'whisper', label: 'Whisper (on this device)', disabled: !speech.available.whisper },
          ]}
          aria-label="Speech engine"
        />
        <Text size="xs" c="dimmed">
          {settings.speech === 'whisper'
            ? 'Whisper downloads ~41 MB once and runs in this browser.'
            : 'Chrome sends audio to a speech service.'}
          {speech.fallback ? ' Not available here, so the other engine is used.' : ''}
        </Text>
        <Switch
          size="xs"
          label="Send after speaking"
          checked={settings.autoSend}
          onChange={(e) => onSettings({ autoSend: e.currentTarget.checked })}
        />
      </Stack>
    </Stack>
  );
}
