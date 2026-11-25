// =============================================================================
// browserPool — the optimiser pool in a browser: api/lib/triggerSearch/poolCore.js's
// queue over Web Workers (optimizerSim.js) instead of worker_threads. The
// adapter gives a Web Worker the worker_threads surface the queue is written
// against: on('message' | 'error' | 'exit'), postMessage, terminate.
// =============================================================================

import { startPool } from "../../../api/lib/triggerSearch/poolCore.js";

/** One optimizerSim worker, initialised with `init`, behind the worker_threads surface. */
function spawnSimWorker(init) {
    const worker = new Worker(new URL("./optimizerSim.js", import.meta.url), { type: "module" });
    const listeners = { message: [], error: [], exit: [] };
    const emit = (event, value) => listeners[event].forEach((fn) => fn(value));
    let exited = false;
    const exit = () => {
        if (exited) return;
        exited = true;
        worker.terminate();
        emit("exit");
    };
    worker.onmessage = ({ data }) => {
        // An engine that will not load fails the pool's start, as a worker_thread that throws on import does.
        // `fatal`: the engine would not reload after a trap; the pool drops this worker as a dead worker_thread.
        if (data?.type === "init_error" || data?.type === "fatal") {
            emit("error", new Error(data.error));
            exit();
            return;
        }
        emit("message", data);
    };
    // A load failure or uncaught throw: a Web Worker may live on after it, a worker_thread does not, so end it.
    worker.onerror = (event) => {
        event?.preventDefault?.();
        emit("error", new Error(event?.message || "optimiser worker crashed"));
        exit();
    };
    worker.postMessage({ type: "init", ...init });
    return {
        on: (event, fn) => listeners[event]?.push(fn),
        postMessage: (message) => worker.postMessage(message),
        terminate: async () => exit(),
    };
}

/**
 * A started pool of `size` optimiser workers on `engine` ('wasm' | 'js'), with the
 * Simulate tab's `experimental` knobs; resolves once every worker has its engine loaded.
 */
export const createBrowserPool = (size, { engine, experimental }) =>
    startPool(size, () => spawnSimWorker({ engine, experimental }));

/** Cores minus one, as the API's pool leaves one free (there for the event loop, here for the page). */
export const browserPoolSize = () => Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
