// Overlapping requests: only the most recent may settle shared state, so a late
// answer to an older one can neither overwrite nor clear a newer one's.
//
// const next = createLatestGate();  const isLatest = next();  …await…
// if (isLatest()) setState(…);
export function createLatestGate() {
  let latest = 0;
  return () => {
    const id = ++latest;
    return () => id === latest;
  };
}
