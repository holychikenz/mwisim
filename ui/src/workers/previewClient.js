// =============================================================================
// previewClient — one shared preview host (optimizerHost.js) for every optimiser
// hook: each host holds the game data and api/lib, so six would cost six copies.
//
// The host is retired only when it is broken: it crashed, or it answered
// `loadFailed` (its modules failed to load; it closes itself). A tool whose
// preview merely throws answers 500 from a healthy host, which is kept. Retiring
// a host settles every preview still waiting on it, so none hangs forever.
// =============================================================================

/**
 * @param {() => Worker} newHost  starts a host (injected so tests can fake one)
 * @param {(event: ErrorEvent) => Error} crashError  the error a crash settles waiting previews with
 * @returns {(path: string, body: object) => Promise<{status: number, json: object}>}
 */
export function createPreviewClient(newHost, crashError) {
  let current = null; // { host, pending: Map<id, {resolve, reject}> }
  let nextId = 0;

  const retire = (entry, error) => {
    if (current === entry) current = null;
    entry.host.terminate();
    for (const { reject } of entry.pending.values()) reject(error);
    entry.pending.clear();
  };

  const start = () => {
    const entry = { host: newHost(), pending: new Map() };
    entry.host.addEventListener('message', ({ data }) => {
      if (data?.type !== 'preview') return;
      const waiter = entry.pending.get(data.id);
      if (!waiter) return;
      entry.pending.delete(data.id);
      waiter.resolve(data);
      if (data.loadFailed) retire(entry, new Error(data.json?.error || 'The optimiser failed to load.'));
    });
    entry.host.addEventListener('error', (event) => retire(entry, crashError(event)));
    return entry;
  };

  const request = (path, body) => new Promise((resolve, reject) => {
    const entry = (current ??= start());
    const id = ++nextId;
    entry.pending.set(id, { resolve, reject });
    entry.host.postMessage({ type: 'preview', id, path, body });
  });
  /** End the host (a dev hot reload would otherwise leave one behind per edit); the next request starts afresh. */
  request.dispose = () => current && retire(current, new Error('The optimiser preview was reset.'));
  return request;
}
