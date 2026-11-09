// RPC client for llm.worker.js. One worker per client; every call gets an id.
// A worker error ends the client: it rejects everything pending, later calls
// reject at once instead of hanging, and onDead tells the owner to start a fresh one.
export function createLocalClient(onDead) {
  const worker = new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  let dead = null;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.progress) { p.onProgress?.(data.progress); return; }
    pending.delete(data.id);
    if ('error' in data) p.reject(new Error(data.error));
    else p.resolve(data.value);
  };
  worker.onerror = (e) => {
    dead = new Error(e?.message || 'The model worker failed to start.');
    worker.terminate();   // an errored worker may still hold a model in GPU memory
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
    onDead?.(dead);
  };
  const call = (op, args = {}, onProgress) => (dead ? Promise.reject(dead) : new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...args, op, id });
  }));
  return {
    load: (modelId, onProgress) => call('load', { modelId }, onProgress),
    chat: (messages, opts) => call('chat', { messages, ...opts }),
    interrupt: () => worker.postMessage({ op: 'interrupt' }),
    cached: (modelId) => call('cached', { modelId }),
    remove: (modelId) => call('delete', { modelId }),
    terminate: () => worker.terminate(),
  };
}
