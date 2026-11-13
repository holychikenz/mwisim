// Roboburble is behind a flag that is off unless the build sets VITE_ROBOBURBLE=true.
import test from 'node:test';
import assert from 'node:assert/strict';

const { isEnabled, ROBOBURBLE_ENABLED } = await import('../../ui/src/assistant/enabled.js');

test('Roboburble is hidden unless VITE_ROBOBURBLE is exactly "true"', () => {
  assert.equal(ROBOBURBLE_ENABLED, false);
  for (const env of [undefined, {}, { VITE_ROBOBURBLE: 'false' }, { VITE_ROBOBURBLE: '' }, { VITE_ROBOBURBLE: '1' }]) {
    assert.equal(isEnabled(env), false, JSON.stringify(env));
  }
  assert.equal(isEnabled({ VITE_ROBOBURBLE: 'true' }), true);
});
