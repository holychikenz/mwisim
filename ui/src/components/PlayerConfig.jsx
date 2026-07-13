import { useState, useCallback, useMemo } from 'react';
import {
  Accordion,
  ActionIcon,
  Badge,
  Collapse,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text
} from '@mantine/core';
import { getFood, getDrinks, getCombatAbilities, getAuras } from '../hooks/useGameData';
import { TriggerEditor } from './TriggerEditor';
import { HousesAchievements } from './HousesAchievements';

const SKILL_NAMES = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];

const EQUIPMENT_SLOTS = [
  { key: '/equipment_types/head', label: 'Head' },
  { key: '/equipment_types/body', label: 'Body' },
  { key: '/equipment_types/legs', label: 'Legs' },
  { key: '/equipment_types/feet', label: 'Feet' },
  { key: '/equipment_types/hands', label: 'Hands' },
  { key: '/equipment_types/main_hand', label: 'Main Hand' },
  { key: '/equipment_types/two_hand', label: 'Two Hand' },
  { key: '/equipment_types/off_hand', label: 'Off Hand' },
  { key: '/equipment_types/pouch', label: 'Pouch' },
  { key: '/equipment_types/back', label: 'Back' },
  { key: '/equipment_types/neck', label: 'Neck' },
  { key: '/equipment_types/earrings', label: 'Earrings' },
  { key: '/equipment_types/ring', label: 'Ring' },
  { key: '/equipment_types/charm', label: 'Charm' },
];

function EquipmentSlot({ slot, items, selected, enhancementLevel, onChange }) {
  const slotOptions = useMemo(() => {
    if (!items) return [];
    return Object.values(items)
      .filter(item => item.equipmentDetail?.type === slot.key)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(item => ({ value: item.hrid, label: item.name }));
  }, [items, slot.key]);

  return (
    <Group gap={6} wrap="nowrap" align="flex-end">
      <Select
        label={slot.label}
        data={slotOptions}
        value={selected || null}
        onChange={(v) => onChange(slot.key, v || null, enhancementLevel)}
        searchable
        clearable
        placeholder="None"
        size="xs"
        style={{ flex: 1 }}
      />
      {selected && (
        <NumberInput
          value={enhancementLevel || 0}
          onChange={(v) =>
            onChange(slot.key, selected, Math.max(0, Math.min(20, Number(v) || 0)))
          }
          min={0}
          max={20}
          size="xs"
          w={64}
          prefix="+"
          aria-label={`${slot.label} enhancement level`}
        />
      )}
    </Group>
  );
}

function TriggerToggle({ count, opened, onClick }) {
  return (
    <ActionIcon
      variant={count > 0 ? 'light' : 'subtle'}
      color={count > 0 ? 'yellow' : 'gray'}
      onClick={onClick}
      title={`${count} trigger(s)`}
      aria-pressed={opened}
      size="lg"
    >
      ⚡{count > 0 ? <Text span size="xs">{count}</Text> : null}
    </ActionIcon>
  );
}

function ConsumableSlot({ index, items, selected, triggers, onChange, onTriggersChange, label, triggerData }) {
  const [showTriggers, setShowTriggers] = useState(false);
  const triggerCount = triggers?.length || 0;

  const options = useMemo(
    () => items.map(item => ({ value: item.hrid, label: item.name })),
    [items]
  );

  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="flex-end">
        <Select
          label={`${label} ${index + 1}`}
          data={options}
          value={selected || null}
          onChange={(v) => onChange(index, v || null)}
          searchable
          clearable
          placeholder="None"
          size="xs"
          style={{ flex: 1 }}
        />
        {selected && (
          <TriggerToggle
            count={triggerCount}
            opened={showTriggers}
            onClick={() => setShowTriggers(!showTriggers)}
          />
        )}
      </Group>
      <Collapse expanded={showTriggers && !!selected}>
        <TriggerEditor
          triggers={triggers || []}
          onChange={(newTriggers) => onTriggersChange(index, newTriggers)}
          triggerData={triggerData}
        />
      </Collapse>
    </Stack>
  );
}

function AbilitySlot({ index, abilities, selected, onChange, onTriggersChange, label, triggerData }) {
  const [showTriggers, setShowTriggers] = useState(false);
  const triggerCount = selected?.triggers?.length || 0;

  const options = useMemo(
    () => abilities.map(a => ({ value: a.hrid, label: a.name })),
    [abilities]
  );

  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="flex-end">
        <Select
          label={label}
          data={options}
          value={selected?.hrid || null}
          onChange={(v) => onChange(index, v || null)}
          searchable
          clearable
          placeholder="None"
          size="xs"
          style={{ flex: 1 }}
        />
        {selected && (
          <>
            <NumberInput
              value={selected.level || 1}
              onChange={(v) => onChange(index, selected.hrid, Math.max(1, Math.min(200, Number(v) || 1)))}
              min={1}
              max={200}
              size="xs"
              w={64}
              aria-label={`${label} level`}
            />
            <TriggerToggle
              count={triggerCount}
              opened={showTriggers}
              onClick={() => setShowTriggers(!showTriggers)}
            />
          </>
        )}
      </Group>
      <Collapse expanded={showTriggers && !!selected}>
        <TriggerEditor
          triggers={selected?.triggers || []}
          onChange={(newTriggers) => onTriggersChange(index, newTriggers)}
          triggerData={triggerData}
        />
      </Collapse>
    </Stack>
  );
}

export function PlayerConfig({ gameData, player, onPlayerChange, playerId = 1 }) {
  const items = gameData?.items;
  const abilities = gameData?.abilities;

  const triggerData = useMemo(() => ({
    triggerConditions: gameData?.triggerConditions,
    triggerComparators: gameData?.triggerComparators,
    triggerDependencies: gameData?.triggerDependencies
  }), [gameData]);

  const foodItems = useMemo(() => getFood(items), [items]);
  const drinkItems = useMemo(() => getDrinks(items), [items]);
  const auras = useMemo(() => getAuras(abilities), [abilities]);
  const combatAbilities = useMemo(() => getCombatAbilities(abilities), [abilities]);

  const handleLevelChange = useCallback((skill, value) => {
    onPlayerChange({
      ...player,
      [`${skill}Level`]: value
    });
  }, [player, onPlayerChange]);

  const handleEquipmentChange = useCallback((slotKey, itemHrid, enhancementLevel = 0) => {
    const newEquipment = { ...player.equipment };
    if (itemHrid) {
      newEquipment[slotKey] = {
        itemHrid: itemHrid,
        enhancementLevel: enhancementLevel
      };
      // Handle two-hand vs main-hand/off-hand exclusivity
      if (slotKey === '/equipment_types/two_hand') {
        newEquipment['/equipment_types/main_hand'] = null;
        newEquipment['/equipment_types/off_hand'] = null;
      } else if (slotKey === '/equipment_types/main_hand' || slotKey === '/equipment_types/off_hand') {
        newEquipment['/equipment_types/two_hand'] = null;
      }
    } else {
      newEquipment[slotKey] = null;
    }
    onPlayerChange({
      ...player,
      equipment: newEquipment
    });
  }, [player, onPlayerChange]);

  const handleFoodChange = useCallback((index, itemHrid) => {
    const newFood = [...player.food];
    if (itemHrid) {
      // Preserve existing triggers if just changing the item
      newFood[index] = { itemHrid, triggers: newFood[index]?.triggers || [] };
    } else {
      newFood[index] = null;
    }
    onPlayerChange({
      ...player,
      food: newFood
    });
  }, [player, onPlayerChange]);

  const handleFoodTriggersChange = useCallback((index, triggers) => {
    const newFood = [...player.food];
    if (newFood[index]) {
      newFood[index] = { ...newFood[index], triggers };
    }
    onPlayerChange({
      ...player,
      food: newFood
    });
  }, [player, onPlayerChange]);

  const handleDrinkChange = useCallback((index, itemHrid) => {
    const newDrinks = [...player.drinks];
    if (itemHrid) {
      newDrinks[index] = { itemHrid, triggers: newDrinks[index]?.triggers || [] };
    } else {
      newDrinks[index] = null;
    }
    onPlayerChange({
      ...player,
      drinks: newDrinks
    });
  }, [player, onPlayerChange]);

  const handleDrinkTriggersChange = useCallback((index, triggers) => {
    const newDrinks = [...player.drinks];
    if (newDrinks[index]) {
      newDrinks[index] = { ...newDrinks[index], triggers };
    }
    onPlayerChange({
      ...player,
      drinks: newDrinks
    });
  }, [player, onPlayerChange]);

  const handleAbilityChange = useCallback((index, abilityHrid, level = 1) => {
    const newAbilities = [...player.abilities];
    if (abilityHrid) {
      newAbilities[index] = {
        hrid: abilityHrid,
        level: level || newAbilities[index]?.level || 1,
        triggers: newAbilities[index]?.triggers || []
      };
    } else {
      newAbilities[index] = null;
    }
    onPlayerChange({
      ...player,
      abilities: newAbilities
    });
  }, [player, onPlayerChange]);

  const handleAbilityTriggersChange = useCallback((index, triggers) => {
    const newAbilities = [...player.abilities];
    if (newAbilities[index]) {
      newAbilities[index] = { ...newAbilities[index], triggers };
    }
    onPlayerChange({
      ...player,
      abilities: newAbilities
    });
  }, [player, onPlayerChange]);

  const equippedCount = Object.values(player.equipment).filter(Boolean).length;
  const consumablesCount =
    player.food.filter(Boolean).length + player.drinks.filter(Boolean).length;
  const abilitiesCount = player.abilities.filter(Boolean).length;
  const housesCount = Object.keys(player.houseRooms || {}).length;

  return (
    <Accordion
      multiple
      defaultValue={['levels', 'equipment']}
      variant="separated"
      radius="md"
    >
      <Accordion.Item value="levels">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm" fw={600}>Levels</Text>
            <Badge variant="default" size="xs">P{playerId}</Badge>
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <SimpleGrid cols={2} spacing="xs">
            {SKILL_NAMES.map(skill => (
              <NumberInput
                key={skill}
                label={skill.charAt(0).toUpperCase() + skill.slice(1)}
                value={player[`${skill}Level`]}
                onChange={(v) => handleLevelChange(skill, Math.max(1, Math.min(200, Number(v) || 1)))}
                min={1}
                max={200}
                size="xs"
              />
            ))}
          </SimpleGrid>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="equipment">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm" fw={600}>Equipment</Text>
            {equippedCount > 0 && (
              <Badge variant="default" size="xs">{equippedCount}</Badge>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {EQUIPMENT_SLOTS.map(slot => (
              <EquipmentSlot
                key={slot.key}
                slot={slot}
                items={items}
                selected={player.equipment[slot.key]?.itemHrid}
                enhancementLevel={player.equipment[slot.key]?.enhancementLevel}
                onChange={handleEquipmentChange}
              />
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="houses">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm" fw={600}>Houses &amp; Achievements</Text>
            {housesCount > 0 && (
              <Badge variant="default" size="xs">{housesCount}</Badge>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <HousesAchievements
            gameData={gameData}
            player={player}
            onPlayerChange={onPlayerChange}
          />
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="consumables">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm" fw={600}>Consumables</Text>
            {consumablesCount > 0 && (
              <Badge variant="default" size="xs">{consumablesCount}</Badge>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {[0, 1, 2].map(i => (
              <ConsumableSlot
                key={`food-${i}`}
                index={i}
                items={foodItems}
                selected={player.food[i]?.itemHrid}
                triggers={player.food[i]?.triggers}
                onChange={handleFoodChange}
                onTriggersChange={handleFoodTriggersChange}
                label="Food"
                triggerData={triggerData}
              />
            ))}
            {[0, 1, 2].map(i => (
              <ConsumableSlot
                key={`drink-${i}`}
                index={i}
                items={drinkItems}
                selected={player.drinks[i]?.itemHrid}
                triggers={player.drinks[i]?.triggers}
                onChange={handleDrinkChange}
                onTriggersChange={handleDrinkTriggersChange}
                label="Drink"
                triggerData={triggerData}
              />
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="abilities">
        <Accordion.Control>
          <Group gap="xs">
            <Text size="sm" fw={600}>Aura &amp; Abilities</Text>
            {abilitiesCount > 0 && (
              <Badge variant="default" size="xs">{abilitiesCount}</Badge>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <AbilitySlot
              index={0}
              abilities={auras}
              selected={player.abilities[0]}
              onChange={handleAbilityChange}
              onTriggersChange={handleAbilityTriggersChange}
              label="Aura"
              triggerData={triggerData}
            />
            {[1, 2, 3, 4].map(i => (
              <AbilitySlot
                key={i}
                index={i}
                abilities={combatAbilities}
                selected={player.abilities[i]}
                onChange={handleAbilityChange}
                onTriggersChange={handleAbilityTriggersChange}
                label={`Ability ${i}`}
                triggerData={triggerData}
              />
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
