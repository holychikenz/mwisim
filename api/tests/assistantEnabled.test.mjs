// Roboburble is behind a flag that is off unless the build sets VITE_ROBOBURBLE=true.
import test from 'node:test';
import assert from 'node:assert/strict';

const { ROBOBURBLE_ENABLED } = await import('../../ui/src/assistant/enabled.js');

test('Roboburble is hidden by default', () => {
  assert.equal(ROBOBURBLE_ENABLED, false);
});
