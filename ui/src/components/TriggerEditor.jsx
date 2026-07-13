import { useMemo, useCallback } from 'react';
import { ActionIcon, Button, Group, NumberInput, Paper, Select, Stack, Text } from '@mantine/core';

function toOptions(map) {
  if (!map) return [];
  return Object.values(map)
    .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0))
    .map(entry => ({ value: entry.hrid, label: entry.name }));
}

function TriggerRow({ trigger, index, dependencies, conditions, comparators, onChange, onRemove }) {
  const dependencyOptions = useMemo(() => toOptions(dependencies), [dependencies]);
  const conditionOptions = useMemo(() => toOptions(conditions), [conditions]);
  const comparatorOptions = useMemo(() => toOptions(comparators), [comparators]);

  // Check if current comparator needs a value input
  const selectedComparator = comparators?.[trigger.comparatorHrid];
  const needsValue = selectedComparator && !selectedComparator.hrid?.includes('is_active') &&
                     !selectedComparator.hrid?.includes('is_inactive');

  const handleChange = (field, value) => {
    onChange(index, { ...trigger, [field]: value });
  };

  return (
    <Paper p={6} radius="sm" withBorder>
      <Stack gap={4}>
        <Group gap={4} wrap="nowrap">
          <Select
            data={dependencyOptions}
            value={trigger.dependencyHrid || null}
            onChange={(v) => handleChange('dependencyHrid', v || '')}
            placeholder="Target…"
            size="xs"
            style={{ flex: 1 }}
            searchable
          />
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={() => onRemove(index)}
            title="Remove trigger"
            size="sm"
          >
            ×
          </ActionIcon>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Select
            data={conditionOptions}
            value={trigger.conditionHrid || null}
            onChange={(v) => handleChange('conditionHrid', v || '')}
            placeholder="Condition…"
            size="xs"
            style={{ flex: 1 }}
            searchable
          />
          <Select
            data={comparatorOptions}
            value={trigger.comparatorHrid || null}
            onChange={(v) => handleChange('comparatorHrid', v || '')}
            placeholder="Compare…"
            size="xs"
            style={{ flex: 1 }}
          />
          {needsValue && (
            <NumberInput
              value={trigger.value || 0}
              onChange={(v) => handleChange('value', Number(v) || 0)}
              size="xs"
              w={72}
              aria-label="Trigger value"
            />
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

export function TriggerEditor({ triggers = [], onChange, triggerData, label }) {
  const { triggerConditions, triggerComparators, triggerDependencies } = triggerData || {};

  const handleTriggerChange = useCallback((index, updatedTrigger) => {
    const newTriggers = [...triggers];
    newTriggers[index] = updatedTrigger;
    onChange(newTriggers);
  }, [triggers, onChange]);

  const handleRemoveTrigger = useCallback((index) => {
    const newTriggers = triggers.filter((_, i) => i !== index);
    onChange(newTriggers);
  }, [triggers, onChange]);

  const handleAddTrigger = useCallback(() => {
    onChange([
      ...triggers,
      {
        dependencyHrid: '/combat_trigger_dependencies/self',
        conditionHrid: '',
        comparatorHrid: '',
        value: 0
      }
    ]);
  }, [triggers, onChange]);

  if (!triggerConditions || !triggerComparators || !triggerDependencies) {
    return null;
  }

  return (
    <Stack gap={6} pl="xs">
      {label && <Text size="xs" fw={600}>{label}</Text>}

      {triggers.length === 0 ? (
        <Text size="xs" c="dimmed">No triggers (always use)</Text>
      ) : (
        <Stack gap={6}>
          {triggers.map((trigger, index) => (
            <TriggerRow
              key={index}
              trigger={trigger}
              index={index}
              dependencies={triggerDependencies}
              conditions={triggerConditions}
              comparators={triggerComparators}
              onChange={handleTriggerChange}
              onRemove={handleRemoveTrigger}
            />
          ))}
        </Stack>
      )}

      <Button variant="subtle" size="compact-xs" onClick={handleAddTrigger}>
        + Add Trigger
      </Button>
    </Stack>
  );
}
