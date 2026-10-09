import { Component } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';

// Error boundary for the lazily loaded mode views (React.lazy chunks). A chunk
// can fail to load, typically because the app was rebuilt and the old chunk's
// hashed filename is gone; without a boundary that error unmounts the whole
// app. Wrap it OUTSIDE the Suspense it guards.
//
// `resetKey`: when it changes (e.g. the sim mode), the boundary clears its
// error and tries rendering its children again.
export class ChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert color="red" variant="light">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">
            This view failed to load (the app was probably rebuilt). Reload the page.
          </Text>
          <Button size="xs" variant="light" color="red" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Group>
      </Alert>
    );
  }
}
