import { useMemo, useCallback } from 'react';
import { Checkbox, Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { getCombatHouseRooms, getCombatAchievementTiers, getAchievementsForTier } from '../hooks/useGameData';
import { GUILD_COMBAT_BUFFS, MAX_GUILD_BUFF_LEVEL } from '../utils/guildBuffs';
import { SEAL_OPTIONS } from '../../../shared/personalBuffs.js';

// =============================================================================
// CharacterBonuses — everything a character carries that is neither a level nor
// a worn item: house rooms, achievement tiers, guild shrines and seals.
//
// Renamed from HousesAchievements when shrines and seals moved down here out of
// the header's Buffs popover. That popover treated both as party-wide, which
// they are not: the guild buys a shrine's ceiling and each MEMBER buys their own
// level up to it (utils/guildBuffs.js resolveUnitShrineBuffs says so at length),
// and a seal is an item one character equips. Modelling five party members with
// one set of knobs simulated a party nobody has.
// =============================================================================

const ROOM_LEVEL_OPTIONS = [
  { value: '0', label: '—' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(lvl => ({ value: String(lvl), label: `Lv ${lvl}` }))
];

export function CharacterBonuses({ gameData, player, onPlayerChange, hideSeals = false }) {
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

  // Level 0 DELETES the key rather than storing a zero, mirroring
  // handleRoomLevelChange above. That is not tidiness: resolveUnitShrineBuffs
  // distinguishes an absent `guildShrines` (defer to the trial's party-wide
  // knobs) from `{}` (captured, owns none), so an object full of zeroes and an
  // object that is genuinely empty must end up spelled the same way.
  const handleShrineLevelChange = useCallback((buffHrid, level) => {
    const clamped = Math.max(0, Math.min(MAX_GUILD_BUFF_LEVEL, Math.floor(Number(level) || 0)));
    const newShrines = { ...(player.guildShrines || {}) };
    if (clamped > 0) {
      newShrines[buffHrid] = clamped;
    } else {
      delete newShrines[buffHrid];
    }
    onPlayerChange({
      ...player,
      guildShrines: newShrines
    });
  }, [player, onPlayerChange]);

  const handleSealsChange = useCallback((values) => {
    onPlayerChange({
      ...player,
      personalBuffs: values
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

      <div>
        <Group justify="space-between" mb={4}>
          <Text size="xs" fw={600}>Guild Shrines</Text>
          <Text size="xs" c="dimmed">0 = off</Text>
        </Group>
        <Text size="xs" c="dimmed" mb={6}>
          Bought per member, not per guild — the guild raises the ceiling and each
          character buys their own level up to it, so two people in the same guild
          rarely carry the same shrines. Shrines apply to every fight, zone and
          labyrinth included.
        </Text>
        <Stack gap={6}>
          {GUILD_COMBAT_BUFFS.map(b => (
            <NumberInput
              key={b.hrid}
              label={`${b.name} — ${b.effect}`}
              value={player.guildShrines?.[b.hrid] || 0}
              onChange={(v) => handleShrineLevelChange(b.hrid, v)}
              min={0}
              max={MAX_GUILD_BUFF_LEVEL}
              size="xs"
            />
          ))}
        </Stack>
      </div>

      {/* Hidden for guild-trial master builds, the same way the header hides the
          whole Buffs control in trial mode: the game grants no seals inside a
          trial, and App's trial path resolves each unit's buffs with
          `includeSeals: false`. Rendering the checkboxes anyway would let a user
          tick Seal of Damage, watch the panel's badge go up, run the trial and
          get a number with no seal in it — a control that lies is worse than no
          control. Shrines above are NOT hidden: they do apply in a trial. */}
      {!hideSeals && (
      <div>
        <Group justify="space-between" mb={4}>
          <Text size="xs" fw={600}>Personal Seals</Text>
          <Text size="xs" c="dimmed">Equipped per character</Text>
        </Group>
        <Checkbox.Group
          value={player.personalBuffs || []}
          onChange={handleSealsChange}
        >
          <Stack gap={6}>
            {SEAL_OPTIONS.map(seal => (
              <Checkbox
                key={seal.value}
                value={seal.value}
                label={seal.label}
                size="xs"
              />
            ))}
          </Stack>
        </Checkbox.Group>
      </div>
      )}
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
