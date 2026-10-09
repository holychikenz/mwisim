import { Table, Text, Tooltip } from '@mantine/core';
import { NumTd, Section } from './ResultParts';
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
    return (
      <Section title="Drops">
        <Text size="sm" c="dimmed">No drops recorded.</Text>
      </Section>
    );
  }

  const totalValue = drops.reduce((sum, drop) => sum + (drop.amount * drop.sellPrice), 0);

  return (
    <Section
      title="Drops"
      right={!creditMode && (
        <Text size="sm">
          Drop value: <Text span fw={700}>{formatValue(totalValue, unit)}</Text>
        </Text>
      )}
    >
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th ta="right">Amount</Table.Th>
            <Table.Th ta="right">Per Hour</Table.Th>
            {creditMode ? (
              <>
                <Table.Th>Credit</Table.Th>
                <Table.Th ta="right">Per Item</Table.Th>
                <Table.Th ta="right">Credits</Table.Th>
                <Table.Th ta="right">Credits/hr</Table.Th>
              </>
            ) : (
              <>
                <Table.Th ta="right">Unit Price</Table.Th>
                <Table.Th ta="right">Total Value</Table.Th>
              </>
            )}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {drops.map((drop) => (
            <Table.Tr key={drop.itemHrid}>
              <Table.Td>{drop.name}</Table.Td>
              <NumTd faded={!drop.amount}>{formatAmount(drop.amount)}</NumTd>
              <NumTd faded={!drop.perHour}>{formatAmount(drop.perHour)}</NumTd>
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
                    <NumTd>{formatAmount(drop.creditsPerItem)}</NumTd>
                    <NumTd faded={!drop.creditAmount}>{formatAmount(drop.creditAmount)}</NumTd>
                    <NumTd faded={!drop.creditPerHour}>{formatAmount(drop.creditPerHour)}</NumTd>
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
                  <NumTd faded={!(drop.sellPrice > 0)}>{drop.sellPrice > 0 ? formatValue(drop.sellPrice, unit) : '—'}</NumTd>
                  <NumTd faded={!(drop.sellPrice > 0)}>{drop.sellPrice > 0 ? formatValue(drop.amount * drop.sellPrice, unit) : '—'}</NumTd>
                </>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}
