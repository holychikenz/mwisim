// =============================================================================
// optimizerHost — the optimiser tools (api/lib/tools/*.js) run in the browser,
// so the UI needs no csim API. The same previewTool / planTool / runPlanned the
// Express routes call (api/lib/optimizerTool.js), with postMessage for JSON and
// SSE and a pool of Web Workers (browserPool.js) for worker_threads.
//
//   in:  { type: 'preview', id, path, body } → { type: 'preview', id, status, json }
//        { type: 'run', path, body }         → { type: 'refused', status, json }
//                                              | { type: 'frame' | 'heartbeat', frame }… then { type: 'done' }
// One run per host; useOptimizerRun starts a fresh host for each.
// =============================================================================

// Loaded after onmessage is set, not by static imports: a module worker drops the messages that arrive while
// its imports evaluate, and api/lib's top-level awaits make that long enough to lose the first request.
const loaded = Promise.all([
    import("../../../api/lib/optimizerTool.js"),
    import("../../../api/lib/triggerSearch/poolCore.js"),
    import("./browserPool.js"),
    ...["abilities", "equipment", "loadout", "progress", "swaps", "triggers"].map((name) => import(`../../../api/lib/tools/${name}.js`)),
]).then(([optimizerTool, poolCore, browserPool, ...tools]) => ({
    ...optimizerTool,
    ...poolCore,
    ...browserPool,
    TOOLS: Object.fromEntries(tools.map(({ default: tool }) => [tool.path, tool])),
}));

const unknownTool = (path) => ({ status: 404, json: { success: false, error: `No optimiser tool ${String(path)}` } });

// shortcut: the heartbeat proves the host alive, not that a pool job progresses (as the API's SSE heartbeat); add a per-job timeout if a hung candidate shows up.
const HEARTBEAT_MS = 10_000;

onmessage = async ({ data }) => {
    let modules;
    try {
        modules = await loaded;
    } catch (error) {
        // Answered, not dropped: the page would wait on a reply that never comes.
        const failed = { status: 500, json: { success: false, error: `The optimiser failed to load: ${error?.message || error}` } };
        postMessage(data?.type === "preview" ? { type: "preview", id: data.id, ...failed } : { type: "refused", ...failed });
        // The failed import is cached in `loaded`: end this host so the page's next request gets a fresh one.
        close();
        return;
    }
    const { TOOLS, planTool, previewTool, runPlanned, clampPoolSize, browserPoolSize, createBrowserPool } = modules;
    const tool = TOOLS[data?.path];
    const poolSize = clampPoolSize(data?.body?.workers, browserPoolSize());
    if (data?.type === "preview") {
        postMessage({ type: "preview", id: data.id, ...(tool ? previewTool(tool, data.body, poolSize) : unknownTool(data.path)) });
        return;
    }
    if (data?.type !== "run") return;
    const { planned, status, json } = tool ? planTool(tool, data.body) : unknownTool(data.path);
    if (!planned) {
        postMessage({ type: "refused", status, json });
        return;
    }
    // Never aborted here: the page cancels by terminating this host, which ends the pool's workers with it.
    const controller = new AbortController();
    // The Simulate tab's engine toggle (utils/experimental.js), sent as extra.experimental; wasm unless it says js.
    const experimental = data.body?.extra?.experimental;
    const engine = experimental?.engine === "js" ? "js" : "wasm";
    // A heartbeat, as the API's SSE comments: useOptimizerRun's stall watchdog sees a live host through a long candidate.
    const heartbeat = setInterval(() => postMessage({ type: "heartbeat" }), HEARTBEAT_MS);
    await runPlanned(planned, {
        poolSize,
        signal: controller.signal,
        send: (frame) => postMessage({ type: "frame", frame }),
        createPool: (size) => createBrowserPool(size, { engine, experimental }),
    });
    clearInterval(heartbeat);
    postMessage({ type: "done" });
};
