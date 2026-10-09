import { Component } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';

// The messages browsers give a dynamic import() whose chunk could not be
// fetched (Chromium, Safari, Firefox; Vite's preload helper adds its own).
const CHUNK_LOAD_ERROR = /dynamically imported module|Importing a module script failed|Unable to preload/i;

const isChunkLoadError = (error) => CHUNK_LOAD_ERROR.test(String(error?.message || error || ''));

// `resetKey` may be a single value or an array of values; an array is
// compared item by item, so `[simMode, results]` resets when either changes.
const keysChanged = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  }
  return !Object.is(a, b);
};

// Error boundary for the lazily loaded mode views (React.lazy chunks, made
// retryable by utils/retryableLazy.js) and the results views they render.
// Without a boundary either kind of error unmounts the whole app. Wrap it
// OUTSIDE the Suspense it guards.
//
// Two kinds of failure, told apart by the error:
// - a chunk failed to load (offline, or the app was rebuilt and the old hashed
//   chunk is gone): "This view failed to load", with Retry (fetches the chunk
//   again) and Reload (picks up a rebuilt app);
// - a view threw while rendering: "This view failed to render", with Retry.
//
// `resetKey`: when it changes (e.g. the sim mode, or a new result), the
// boundary clears its error and tries rendering its children again.
// `renderError(content)`: optional, wraps the error message — for a boundary
// whose children render somewhere else (a modal), so the message shows there.
export class ChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && keysChanged(prevProps.resetKey, this.props.resetKey)) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    const content = (
      <Alert color="red" variant="light">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">
            {chunk
              ? 'This view failed to load (offline, or the app was rebuilt). Retry, or reload the page.'
              : `This view failed to render${error?.message ? `: ${error.message}` : '.'}`}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button size="xs" variant="light" color="red" onClick={this.retry}>
              Retry
            </Button>
            {chunk && (
              <Button size="xs" variant="default" onClick={() => window.location.reload()}>
                Reload
              </Button>
            )}
          </Group>
        </Group>
      </Alert>
    );
    return this.props.renderError ? this.props.renderError(content) : content;
  }
}
