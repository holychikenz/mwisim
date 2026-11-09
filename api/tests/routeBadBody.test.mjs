// audit3-4 — a body whose validation throws is a 400, not a dead server.
// validateBody ran outside the try in two async Express 4 handlers, so
// `String(objective)` on {toString: 1} rejected unhandled and node exited.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import triggerRoutes from '../routes/optimizeTriggers.js';
import equipmentRoutes from '../routes/optimizeEquipment.js';
import loadoutRoutes from '../routes/optimizeLoadout.js';
import abilityRoutes from '../routes/optimizeAbilities.js';
import progressRoutes from '../routes/optimizeProgress.js';

const HOSTILE = {
  players: [{}],
  zone: { zoneHrid: '/actions/combat/fly' },
  objective: { toString: 1 },
};

test('audit3-4: a body that makes validation throw answers 400 on every optimiser route', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', triggerRoutes);
  app.use('/api', equipmentRoutes);
  app.use('/api', loadoutRoutes);
  app.use('/api', abilityRoutes);
  app.use('/api', progressRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    for (const path of ['optimize-triggers', 'optimize-equipment', 'optimize-triggers/preview', 'optimize-equipment/preview',
      'optimize-loadout', 'optimize-abilities', 'optimize-loadout/preview', 'optimize-abilities/preview',
      'optimize-progress', 'optimize-progress/preview']) {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(HOSTILE),
        signal: AbortSignal.timeout(5000), // an unhandled rejection never answers
      });
      assert.ok(res.status >= 400 && res.status < 600, `${path}: ${res.status}`);
      assert.equal((await res.json()).success, false, path);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
