// RPC client for llm.worker.js. One worker per client; every call gets an id,
// and a worker crash rejects everything pending.
export function createLocalClient() {
  const worker = new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.progress) { p.onProgress?.(data.progress); return; }
    pending.delete(data.id);
    if ('error' in data) p.reject(new Error(data.error));
    else p.resolve(data.value);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e?.message || 'The model worker failed to start.'));
    pending.clear();
  };
  const call = (op, args = {}, onProgress) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...args, op, id });
  });
  return {
    load: (modelId, onProgress) => call('load', { modelId }, onProgress),
    chat: (messages, opts) => call('chat', { messages, ...opts }),
    interrupt: () => worker.postMessage({ op: 'interrupt' }),
    cached: (modelId) => call('cached', { modelId }),
    remove: (modelId) => call('delete', { modelId }),
    terminate: () => worker.terminate(),
  };
}
