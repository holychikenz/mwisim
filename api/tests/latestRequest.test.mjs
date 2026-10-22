// audit-16 — the optimiser hooks let only the latest preview / run settle
// state. React has no test harness here, so the guard is a pure function.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createLatestGate } = await import('../../ui/src/utils/latestRequest.js');

test('audit-16: a superseded request is no longer the latest; the newest is', () => {
  const next = createLatestGate();
  const first = next();
  assert.equal(first(), true);
  const second = next();
  assert.equal(first(), false, 'a late answer to the first must not settle state');
  assert.equal(second(), true);
  // Separate gates (preview vs run) do not interfere.
  const other = createLatestGate()();
  assert.equal(other(), true);
  assert.equal(second(), true);
});
