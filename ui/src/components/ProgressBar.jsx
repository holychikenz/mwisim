import { Progress, Stack, Text } from '@mantine/core';

export function ProgressBar({ progress, status, indeterminate = false }) {
  const percentage = Math.min(100, Math.max(0, progress || 0));

  return (
    <Stack gap={4}>
      <Progress
        value={indeterminate ? 100 : percentage}
        animated={indeterminate}
        size="lg"
        radius="md"
      />
      {status && <Text size="xs" c="dimmed">{status}</Text>}
    </Stack>
  );
}
