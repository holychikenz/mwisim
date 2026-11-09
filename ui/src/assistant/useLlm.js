import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLocalClient } from './localLlm';
import { GPU_LIMITS, recommendModel, MODEL_TIERS } from './models';
import { BUDGET, buildSystemPrompt, fitHistory, parseToolCalls, toLocalMessages } from './protocol';
import { CUT, chatAnthropic, chatOpenAI, fitCloudHistory } from './providers';
import { readKey, saveKey } from './settings';

async function detectGpu() {
  // The same adapter web-llm's detectGPUDevice will ask for.
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null;
  const limits = Object.fromEntries(Object.keys(GPU_LIMITS).map(k => [k, adapter?.limits[k]]));
  return { hasGpu: !!adapter, shaderF16: !!adapter?.features.has('shader-f16'), ...limits, deviceMemory: navigator.deviceMemory };
}

// tvmjs's "requested <limit> exceeds limit" error, said plainly.
function readable(message) {
  const limit = /requested (\w+) exceeds limit/.exec(message)?.[1];
  return limit ? `This GPU's WebGPU ${limit} limit is too low for local models. Use an Anthropic or OpenAI key instead.` : message;
}

const IDLE = { loaded: null, loading: null, progress: 0, text: '', error: null };

/**
 * The model behind the panel: WebGPU detection, the local model's load and
 * cache state, the API keys, and one provider-specific `chat()` for runAgent.
 */
export function useLlm(settings) {
  const [gpu, setGpu] = useState(null);
  const [local, setLocal] = useState(IDLE);
  const [cache, setCache] = useState({});
  const [keys, setKeys] = useState(() => ({ anthropic: readKey('anthropic'), openai: readKey('openai') }));
  const client = useRef(null);
  // Why the last local worker died: a turn's next step then reports it, not a TypeError on a null client.
  const dead = useRef(null);

  useEffect(() => {
    let live = true;
    detectGpu().then(g => { if (live) setGpu(g); }, () => { if (live) setGpu({ hasGpu: false }); });
    return () => { live = false; };
  }, []);
  useEffect(() => () => client.current?.terminate(), []);

  // A worker that errors is dropped (localLlm terminates it); the next call starts a fresh one.
  const getClient = useCallback(() => (client.current ??= createLocalClient((e) => {
    client.current = null;
    dead.current = e;
    setLocal({ ...IDLE, error: readable(e.message) });
  })), []);
  const rec = useMemo(() => (gpu ? recommendModel(gpu) : null), [gpu]);
  // A remembered model from the other quant (another device) maps to this device's id.
  const localModel = useMemo(() => {
    if (!rec) return null;
    const tier = MODEL_TIERS.find(t => settings.localModel?.startsWith(`${t.base}-`));
    return tier ? rec.list.find(m => m.base === tier.base).id : rec.recommended;
  }, [rec, settings.localModel]);

  const refreshCache = useCallback((ids) => {
    const c = getClient();
    Promise.all(ids.map(id => c.cached(id).then(v => [id, !!v], () => [id, false])))
      .then(entries => setCache(Object.fromEntries(entries)));
  }, [getClient]);

  const load = useCallback(async (id) => {
    setLocal({ ...IDLE, loading: id });
    try {
      await getClient().load(id, (r) => setLocal(s => ({ ...s, progress: r.progress, text: r.text })));
      setLocal({ ...IDLE, loaded: id, progress: 1 });
      setCache(c => ({ ...c, [id]: true }));
    } catch (e) {
      setLocal({ ...IDLE, error: readable(e.message) });
    }
  }, [getClient]);

  const remove = useCallback(async (id) => {
    try {
      await getClient().remove(id);
      setCache(c => ({ ...c, [id]: false }));
    } catch (e) {
      setLocal(s => ({ ...s, error: e.message }));
    }
  }, [getClient]);

  const setKey = useCallback((provider, key) => {
    saveKey(provider, key);
    setKeys(k => ({ ...k, [provider]: key }));
  }, []);

  const { provider } = settings;
  const model = provider === 'anthropic' ? settings.anthropicModel : settings.openaiModel;
  const key = keys[provider];
  // Only the selected model answers: picking another one waits for its Load.
  const ready = provider === 'local' ? !!local.loaded && local.loaded === localModel : !!key;

  const chat = useCallback(async ({ transcript, tools, signal }) => {
    if (provider === 'local') {
      const c = client.current;
      if (!c) throw dead.current || new Error('No local model is loaded.');
      const messages = toLocalMessages(buildSystemPrompt({ tools, protocol: 'prompt' }), fitHistory(transcript, BUDGET.localHistory));
      const onAbort = () => c.interrupt();
      signal?.addEventListener('abort', onAbort);
      try {
        const { text, finish } = await c.chat(messages, { max_tokens: BUDGET.generation, temperature: 0.2 });
        const p = parseToolCalls(text, tools.map(t => t.name));
        return { text: p.text + (finish === 'length' ? CUT : ''), calls: p.calls, parseErrors: p.errors, raw: text };
      } catch (e) {
        if (/ContextWindowSizeExceeded/.test(e.message)) throw new Error('The conversation is too long for this model. Clear chat and try again.');
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    const send = provider === 'anthropic' ? chatAnthropic : chatOpenAI;
    return send({
      fetch: fetch.bind(globalThis), key, model,
      system: buildSystemPrompt({ tools, protocol: 'native' }),
      transcript: fitCloudHistory(transcript), tools, signal,
    });
  }, [provider, key, model]);

  const loadedLabel = rec?.list.find(m => m.id === local.loaded)?.label;
  const label = provider === 'local'
    ? `${loadedLabel || 'No model'} · WebGPU`
    : `${provider === 'anthropic' ? 'Claude' : 'OpenAI'} · ${model}`;

  return { gpu, rec, localModel, local, cache, keys, ready, label, chat, load, remove, refreshCache, setKey };
}
