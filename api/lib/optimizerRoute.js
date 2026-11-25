// =============================================================================
// optimizerRoute — the Express transport for the optimiser tools
// (optimizerTool.js, tools/*.js): toolRouter gives a tool its
// POST /api/<path>/preview (JSON) and POST /api/<path> (SSE) on a
// worker_threads pool, with the SSE lifecycle (headers, heartbeat,
// client-disconnect abort). The UI no longer calls these (it runs the same tools
// in the browser, ui/src/workers/optimizerHost.js); they stay for headless use.
// Re-exports optimizerTool.js, whose names the tests import from here.
// =============================================================================

import { Router } from 'express';
import { planTool, previewTool, runPlanned } from './optimizerTool.js';
import { clampPoolSize } from './triggerSearch/poolCore.js';
import { createSimulationPool, defaultPoolSize } from './triggerSearch/pool.js';

export * from './optimizerTool.js';

/** Heartbeat interval. Comfortably inside a 30s client stall timeout. */
const HEARTBEAT_MS = 10_000;

/** The caller's `workers`, clamped to [1, MAX_WORKERS]; the default when absent. */
export function poolSizeFor(workers) {
  return clampPoolSize(workers, defaultPoolSize());
}

/**
 * Run `run({ poolSize, send, signal })` as a Server-Sent Events response.
 *
 * SSE comments (the heartbeat) are ignored by EventSource and by a manual reader
 * that skips non-`data:` lines, but they keep the socket and any client stall
 * timer alive across a long candidate simulation.
 *
 * The client vanishing is a normal way a long run ends. Without the abort the
 * pool keeps every worker busy to completion for a result nobody will read.
 * It listens on `res`, not `req`: Node emits `req`'s 'close' when the REQUEST
 * has been fully received — on every normal request — while `res`'s 'close'
 * fires when the response finishes or the socket dies, and `writableFinished`
 * distinguishes the two.
 */
export async function streamPoolRun(req, res, run) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    await run({ poolSize: poolSizeFor(req.body?.workers), send, signal: controller.signal });
  } catch (error) {
    send({ type: 'error', error: error.message });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

/** POST /api/<tool.path>/preview and POST /api/<tool.path> for one tool. */
export function toolRouter(tool) {
  const router = Router();
  router.post(`/${tool.path}/preview`, (req, res) => {
    const { status, json } = previewTool(tool, req.body, poolSizeFor(req.body?.workers));
    res.status(status).json(json);
  });
  router.post(`/${tool.path}`, async (req, res) => {
    const { planned, status, json } = planTool(tool, req.body);
    if (!planned) return res.status(status).json(json);
    await streamPoolRun(req, res, (io) => runPlanned(planned, { ...io, createPool: (size) => createSimulationPool({ size }) }));
  });
  return router;
}
