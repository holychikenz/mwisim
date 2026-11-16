// The deploy builds the test branch with VITE_SERVER=test. Presentation and storage only: the data on that
// branch is already the test server's, and combat mechanics key on what the data contains, never on this flag.
export const isTestBuild = (env) => env?.VITE_SERVER === 'test';
export const TEST_BUILD = isTestBuild(import.meta.env);

// /mwisim/test/ shares live's origin, so a test build keeps its localStorage under a prefix, at the
// Storage boundary so that no future key can forget it (as MWIX does, cowstuff 1aa09f4).
export function namespaceStorage(proto, prefix) {
  for (const m of ['getItem', 'setItem', 'removeItem']) {
    const f = proto[m];
    proto[m] = function (key, ...rest) { return f.call(this, prefix + key, ...rest); };
  }
}
if (TEST_BUILD && typeof Storage !== 'undefined') namespaceStorage(Storage.prototype, 'test::');
