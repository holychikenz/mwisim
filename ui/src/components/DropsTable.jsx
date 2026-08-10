import { Stack, Table, Text, Tooltip } from '@mantine/core';
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
 *
 * When `creditMode` is set the price columns are replaced by the guild-credit
 * conversion (see utils/guildCredits): rows then carry `convertible`,
 * `creditName`, `creditsPerItem`, `creditAmount` and `creditPerHour`.
 */
export function DropsTable({ drops, unit = 'coins', creditMode = false }) {
  if (!drops || drops.length === 0) {
    return <Text size="sm" c="dimmed">No drops recorded.</Text>;
  }

  const totalValue = drops.reduce((sum, drop) => sum + (drop.amount * drop.sellPrice), 0);

  return (
    <Stack gap="xs">
      {!creditMode && (
        <Text size="sm">
          Drop value: <Text span fw={700}>{formatValue(totalValue, unit)}</Text>
        </Text>
      )}
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th>Amount</Table.Th>
            <Table.Th>Per Hour</Table.Th>
            {creditMode ? (
              <>
                <Table.Th>Credit</Table.Th>
                <Table.Th>Per Item</Table.Th>
                <Table.Th>Credits</Table.Th>
                <Table.Th>Credits/hr</Table.Th>
              </>
            ) : (
              <>
                <Table.Th>Unit Price</Table.Th>
                <Table.Th>Total Value</Table.Th>
              </>
            )}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {drops.map((drop) => (
            <Table.Tr key={drop.itemHrid}>
              <Table.Td>{drop.name}</Table.Td>
              <Table.Td>{formatAmount(drop.amount)}</Table.Td>
              <Table.Td>{formatAmount(drop.perHour)}</Table.Td>
              {creditMode ? (
                drop.convertible ? (
                  <>
                    <Table.Td>
                      {drop.conversionOptionCount > 1 ? (
                        <Tooltip
                          label={`${drop.conversionOptionCount} conversions offered — highest tier taken`}
                          withArrow
                        >
                          <Text span size="sm" style={{ borderBottom: '1px dotted currentColor' }}>
                            {drop.creditName}
                          </Text>
                        </Tooltip>
                      ) : (
                        drop.creditName
                      )}
                    </Table.Td>
                    <Table.Td>{formatAmount(drop.creditsPerItem)}</Table.Td>
                    <Table.Td>{formatAmount(drop.creditAmount)}</Table.Td>
                    <Table.Td>{formatAmount(drop.creditPerHour)}</Table.Td>
                  </>
                ) : (
                  <>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed">no guild credit conversion</Text>
                    </Table.Td>
                  </>
                )
              ) : (
                <>
                  <Table.Td>{drop.sellPrice > 0 ? formatValue(drop.sellPrice, unit) : '-'}</Table.Td>
                  <Table.Td>{drop.sellPrice > 0 ? formatValue(drop.amount * drop.sellPrice, unit) : '-'}</Table.Td>
                </>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
