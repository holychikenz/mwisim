import { useMemo, useCallback } from 'react';
import { Checkbox, Group, Select, Stack, Text } from '@mantine/core';
import { getCombatHouseRooms, getCombatAchievementTiers, getAchievementsForTier } from '../hooks/useGameData';

const ROOM_LEVEL_OPTIONS = [
  { value: '0', label: '—' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(lvl => ({ value: String(lvl), label: `Lv ${lvl}` }))
];

export function HousesAchievements({ gameData, player, onPlayerChange }) {
  const combatRooms = useMemo(() => getCombatHouseRooms(gameData?.houseRooms), [gameData?.houseRooms]);
  const combatTiers = useMemo(() => getCombatAchievementTiers(gameData?.achievementTiers), [gameData?.achievementTiers]);

  // Map tier hrids to their achievement hrids
  const tierAchievementMap = useMemo(() => {
    const map = {};
    combatTiers.forEach(tier => {
      map[tier.hrid] = getAchievementsForTier(gameData?.achievements, tier.hrid);
    });
    return map;
  }, [combatTiers, gameData?.achievements]);

  const handleRoomLevelChange = useCallback((roomHrid, level) => {
    const newHouseRooms = { ...player.houseRooms };
    if (level > 0) {
      newHouseRooms[roomHrid] = level;
    } else {
      delete newHouseRooms[roomHrid];
    }
    onPlayerChange({
      ...player,
      houseRooms: newHouseRooms
    });
  }, [player, onPlayerChange]);

  // Check if all achievements in a tier are complete
  const isTierComplete = useCallback((tierHrid) => {
    const achievementHrids = tierAchievementMap[tierHrid] || [];
    if (achievementHrids.length === 0) return false;
    return achievementHrids.every(hrid => player.achievements?.[hrid]);
  }, [tierAchievementMap, player.achievements]);

  const handleTierToggle = useCallback((tierHrid) => {
    const achievementHrids = tierAchievementMap[tierHrid] || [];
    const newAchievements = { ...player.achievements };
    const currentlyComplete = isTierComplete(tierHrid);

    // Toggle all achievements in this tier
    achievementHrids.forEach(hrid => {
      if (currentlyComplete) {
        delete newAchievements[hrid];
      } else {
        newAchievements[hrid] = true;
      }
    });

    onPlayerChange({
      ...player,
      achievements: newAchievements
    });
  }, [tierAchievementMap, player, onPlayerChange, isTierComplete]);

  return (
    <Stack gap="md">
      <div>
        <Group justify="space-between" mb={4}>
          <Text size="xs" fw={600}>House Rooms</Text>
          <Text size="xs" c="dimmed">Combat bonuses only</Text>
        </Group>
        <Stack gap={6}>
          {combatRooms.map(room => (
            <Group key={room.hrid} gap={6} wrap="nowrap" justify="space-between">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text size="xs" truncate>{room.name}</Text>
                <Text size="xs" c="dimmed" truncate>{getRoomBuffDescription(room)}</Text>
              </div>
              <Select
                data={ROOM_LEVEL_OPTIONS}
                value={String(player.houseRooms?.[room.hrid] || 0)}
                onChange={(v) => v != null && handleRoomLevelChange(room.hrid, Number(v))}
                allowDeselect={false}
                size="xs"
                w={76}
                aria-label={`${room.name} level`}
              />
            </Group>
          ))}
        </Stack>
      </div>

      <div>
        <Group justify="space-between" mb={4}>
          <Text size="xs" fw={600}>Achievement Tiers</Text>
          <Text size="xs" c="dimmed">Tick when the full tier is complete</Text>
        </Group>
        <Stack gap={6}>
          {combatTiers.map(tier => (
            <Checkbox
              key={tier.hrid}
              size="xs"
              checked={isTierComplete(tier.hrid)}
              onChange={() => handleTierToggle(tier.hrid)}
              label={
                <span>
                  {tier.name}{' '}
                  <Text span size="xs" c="dimmed">{getTierBuffDescription(tier)}</Text>
                </span>
              }
            />
          ))}
        </Stack>
      </div>
    </Stack>
  );
}

function getRoomBuffDescription(room) {
  const actionBuffs = room.actionBuffs || [];
  if (actionBuffs.length === 0) return '';

  const buff = actionBuffs[0];
  const type = buff.typeHrid?.replace('/buff_types/', '').replace(/_/g, ' ');

  if (buff.flatBoostLevelBonus) {
    const perLevel = (buff.flatBoostLevelBonus * 100).toFixed(1);
    return `+${perLevel}% ${type}/lvl`;
  }
  if (buff.ratioBoostLevelBonus) {
    const perLevel = (buff.ratioBoostLevelBonus * 100).toFixed(2);
    return `+${perLevel}% ${type}/lvl`;
  }
  return type;
}

function getTierBuffDescription(tier) {
  const buff = tier.buff;
  if (!buff) return '';

  const type = buff.typeHrid?.replace('/buff_types/', '').replace(/_/g, ' ');

  if (buff.flatBoost) {
    return `+${(buff.flatBoost * 100).toFixed(0)}% ${type}`;
  }
  if (buff.ratioBoost) {
    return `+${(buff.ratioBoost * 100).toFixed(1)}% ${type}`;
  }
  return type;
}
