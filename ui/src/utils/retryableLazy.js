import { lazy, createElement } from 'react';

// React.lazy, but a failed load can be retried.
//
// React.lazy caches its promise, rejection included: once a chunk fails to
// load, every later render of that lazy type re-throws the same error, so an
// error boundary's Retry could never fetch the chunk again. Here the lazy type
// is replaced as soon as its load fails, so the next render after the
// boundary resets (ChunkBoundary's Retry, or its resetKey changing) calls
// `load()` — i.e. `import()` — afresh.
//
// The returned component is a stable module-level type, so a successfully
// loaded view is never remounted by this wrapper; only after a failure does
// the inner lazy type change.
//
// `load` must resolve to a module-like `{ default: Component }`.
export function retryableLazy(load) {
  let Lazy;
  const fresh = () => lazy(() => load().catch((error) => {
    Lazy = fresh();
    throw error;
  }));
  Lazy = fresh();
  return function RetryableLazy(props) {
    return createElement(Lazy, props);
  };
}
