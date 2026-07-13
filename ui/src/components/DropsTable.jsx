import { Stack, Table, Text } from '@mantine/core';
import { formatValue } from '../utils/prices';

function formatAmount(num, decimals = 2) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(decimals) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(decimals) + 'K';
  }
  if (num < 0.01 && num > 0) {
    return num.toExponential(2);
  }
  return num.toFixed(decimals);
}

/**
 * Renders pre-computed, pre-priced drops (see DropsEconomy for the pricing
 * pipeline). `unit` is 'coins' or 'seconds' (iron time-value).
 */
export function DropsTable({ drops, unit = 'coins' }) {
  if (!drops || drops.length === 0) {
    return <Text size="sm" c="dimmed">No drops recorded.</Text>;
  }

  const totalValue = drops.reduce((sum, drop) => sum + (drop.amount * drop.sellPrice), 0);

  return (
    <Stack gap="xs">
      <Text size="sm">
        Drop value: <Text span fw={700}>{formatValue(totalValue, unit)}</Text>
      </Text>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th>Amount</Table.Th>
            <Table.Th>Per Hour</Table.Th>
            <Table.Th>Unit Price</Table.Th>
            <Table.Th>Total Value</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {drops.map((drop) => (
            <Table.Tr key={drop.itemHrid}>
              <Table.Td>{drop.name}</Table.Td>
              <Table.Td>{formatAmount(drop.amount)}</Table.Td>
              <Table.Td>{formatAmount(drop.perHour)}</Table.Td>
              <Table.Td>{drop.sellPrice > 0 ? formatValue(drop.sellPrice, unit) : '-'}</Table.Td>
              <Table.Td>{drop.sellPrice > 0 ? formatValue(drop.amount * drop.sellPrice, unit) : '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
