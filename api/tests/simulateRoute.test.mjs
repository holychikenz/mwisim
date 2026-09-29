// =============================================================================
// POST /api/simulate — run-limit validation at the route.
//
// Run from api/:  npm test
//
// The handler is taken off the Express router and called with a stub req/res,
// so no port is bound. Only requests the route refuses before simulating are
// sent here: the engine-backed paths are covered in dungeonRunMode.test.mjs.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

const router = (await import('../routes/simulate.js')).default;

function handler(path, method) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is routed`);
  return layer.route.stack[0].handle;
}

async function post(body) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler('/simulate', 'post')({ body }, res);
  return res;
}

const request = (extra) => ({
  players: [{}],
  zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 },
  maxRuns: 5,
  ...extra,
});

test('POST /simulate refuses a max run duration outside 1 to 10 hours with a 400', async () => {
  for (const maxRunHours of [0.5, 11]) {
    const res = await post(request({ maxRunHours }));
    assert.equal(res.statusCode, 400, `maxRunHours ${maxRunHours}`);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /maxRunHours/);
  }
});
