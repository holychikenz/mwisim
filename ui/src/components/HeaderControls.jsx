import { useMemo } from 'react';
import {
  Group,
  Select,
  NumberInput,
  Button,
  Popover,
  Stack,
  Switch,
  Checkbox,
  Text,
  Indicator,
  SegmentedControl,
  Anchor,
  Divider
} from '@mantine/core';
import { GUILD_COMBAT_BUFFS, MAX_GUILD_BUFF_LEVEL } from '../utils/guildBuffs';
import { levelToTierIndex, tierIndexToLevel, MAX_TIER_INDEX } from '../utils/trialTiers';

// =============================================================================
// HeaderControls — the sticky simulation bar: mode (zone / labyrinth), the
// per-mode target controls, duration, buffs, and the Run/Stop buttons.
// Lives in the AppShell header so re-running after a tweak never requires
// scrolling.
// =============================================================================

const TIER_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(t => ({
  value: String(t),
  label: `T${t}`
}));

const BUFF_LEVEL_OPTIONS = [
  { value: '0', label: 'None' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(l => ({
    value: String(l),
    label: `Level ${l}`
  }))
];

// Personal seal buffs understood by the worker (extra.personalBuffs).
const SEAL_OPTIONS = [
  { value: '/items/seal_of_attack_speed', label: 'Attack Speed (+15%)' },
  { value: '/items/seal_of_cast_speed', label: 'Cast Speed (+15%)' },
  { value: '/items/seal_of_combat_drop', label: 'Combat Drop (+15%)' },
  { value: '/items/seal_of_critical_rate', label: 'Critical Rate (+10%)' },
  { value: '/items/seal_of_damage', label: 'Damage (+8%)' },
  { value: '/items/seal_of_rare_find', label: 'Rare Find (+60%)' },
  { value: '/items/seal_of_wisdom', label: 'Wisdom (+20%)' }
];

// Labyrinth supply crates (same trios as the old UI's LabyrinthSupplyItems).
const CRATE_CATEGORIES = [
  { key: 'tea', label: 'Tea crate', items: ['/items/basic_tea_crate', '/items/advanced_tea_crate', '/items/expert_tea_crate'] },
  { key: 'coffee', label: 'Coffee crate', items: ['/items/basic_coffee_crate', '/items/advanced_coffee_crate', '/items/expert_coffee_crate'] },
  { key: 'food', label: 'Food crate', items: ['/items/basic_food_crate', '/items/advanced_food_crate', '/items/expert_food_crate'] }
];

const LAB_UPGRADE_FIELDS = [
  { key: 'combatDamage', label: 'Combat Damage' },
  { key: 'attackSpeed', label: 'Attack Speed' },
  { key: 'castSpeed', label: 'Cast Speed' },
  { key: 'criticalRate', label: 'Critical Rate' }
];

function crateLabel(hrid) {
  // "/items/expert_tea_crate" → "Expert"
  const base = hrid.split('/').pop().split('_')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function HeaderControls({
  simMode,
  onSimModeChange,
  zones,
  zone,
  onZoneChange,
  difficultyTier,
  onDifficultyChange,
  monsters,
  labConfig,
  onLabConfigChange,
  duration,
  onDurationChange,
  extraOptions,
  onExtraChange,
  onStart,
  onStop,
  loading,
  guildTrials,
  trialConfig,
  onTrialConfigChange,
  rosterLength = 0
}) {
  const zoneOptions = useMemo(() => {
    if (!zones) return [];
    return [
      {
        group: 'Regular Zones',
        items: zones
          .filter(z => !z.isDungeon)
          .map(z => ({ value: z.hrid, label: z.name }))
      },
      {
        group: 'Dungeons',
        items: zones
          .filter(z => z.isDungeon)
          .map(z => ({ value: z.hrid, label: z.name }))
      }
    ];
  }, [zones]);

  const labMonsterOptions = useMemo(() => {
    if (!monsters) return [];
    return Object.values(monsters)
      .filter(m => m.isLabyrinthMonster)
      .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0))
      .map(m => ({ value: m.hrid, label: m.name }));
  }, [monsters]);

  const activeBuffCount =
    (extraOptions.comExp > 0 ? 1 : 0) +
    (extraOptions.comDrop > 0 ? 1 : 0) +
    (extraOptions.mooPass ? 1 : 0) +
    (extraOptions.personalBuffs?.length || 0);

  const crateCount = CRATE_CATEGORIES.filter(c => labConfig.crates[c.key]).length;
  const upgradeCount = LAB_UPGRADE_FIELDS.filter(f => labConfig.upgrades[f.key] > 0).length;

  const trialOptions = useMemo(
    () => (guildTrials || []).map(t => ({ value: t.hrid, label: t.name })),
    [guildTrials]
  );
  const cfg = trialConfig || {};
  const effectiveParticipants = cfg.participantCount ?? rosterLength;
  const guildBuffLevels = cfg.guildBuffLevels || {};
  const enemyScalePct = cfg.enemyScale ?? 100;
  const trialOptionCount =
    (cfg.participantCount != null ? 1 : 0) +
    (cfg.buildersHallBonus > 0 ? 1 : 0) +
    (cfg.treasuryBonus > 0 ? 1 : 0) +
    (enemyScalePct !== 100 ? 1 : 0) +
    GUILD_COMBAT_BUFFS.filter(b => (guildBuffLevels[b.hrid] || 0) > 0).length;

  const setCfg = (patch) => onTrialConfigChange?.({ ...cfg, ...patch });
  const setBuffLevel = (hrid, level) =>
    setCfg({ guildBuffLevels: { ...guildBuffLevels, [hrid]: level } });

  return (
    <Group gap="xs" wrap="nowrap">
      <SegmentedControl
        size="xs"
        value={simMode}
        onChange={onSimModeChange}
        data={[
          { value: 'zone', label: 'Zone' },
          { value: 'labyrinth', label: 'Lab' },
          { value: 'guildTrial', label: 'Trial' }
        ]}
      />

      {simMode === 'guildTrial' ? (
        <>
          <Select
            data={trialOptions}
            value={cfg.trialHrid}
            onChange={(v) => v && setCfg({ trialHrid: v })}
            allowDeselect={false}
            w={180}
            size="sm"
            aria-label="Guild trial"
          />
          {/* Game dialect: the user picks a TIER INDEX (Tier 0 = Lv 100 …
              Tier 20 = Lv 300); trialConfig keeps storing the LEVEL, so the
              persisted state and the worker payload are unchanged. */}
          <NumberInput
            value={Math.round(levelToTierIndex(cfg.startTier ?? 100))}
            onChange={(v) => {
              const idx = Math.max(0, Math.min(MAX_TIER_INDEX, Math.round(Number(v) || 0)));
              setCfg({ startTier: tierIndexToLevel(idx) });
            }}
            min={0}
            max={MAX_TIER_INDEX}
            step={1}
            w={150}
            size="sm"
            prefix="Tier "
            suffix={` · Lv ${cfg.startTier ?? 100}`}
            title="Start tier: Tier 0 = Lv 100 … Tier 20 = Lv 300 (+10 monster levels per tier)"
            aria-label="Starting tier"
          />
          <Popover width={300} position="bottom-end" shadow="md">
            <Popover.Target>
              <Indicator disabled={trialOptionCount === 0} label={trialOptionCount} size={16}>
                <Button variant="default" size="sm">Trial options</Button>
              </Indicator>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Text size="sm" fw={600}>Participants</Text>
                <NumberInput
                  label="Participant count (+1% monster HP each)"
                  description={`Auto = roster size (${rosterLength})`}
                  value={effectiveParticipants}
                  onChange={(v) => setCfg({ participantCount: Math.max(1, Number(v) || 1) })}
                  min={1}
                  max={200}
                  size="xs"
                />
                {cfg.participantCount != null && (
                  <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    onClick={() => setCfg({ participantCount: null })}
                  >
                    Reset to roster size ({rosterLength})
                  </Anchor>
                )}

                <Divider my={4} />
                <Text size="sm" fw={600}>Reward multipliers</Text>
                <Group gap="xs" grow>
                  <NumberInput
                    label="Builders' Hall %"
                    value={cfg.buildersHallBonus}
                    onChange={(v) => setCfg({ buildersHallBonus: Math.max(0, Math.min(100, Number(v) || 0)) })}
                    min={0}
                    max={100}
                    size="xs"
                  />
                  <NumberInput
                    label="Treasury %"
                    value={cfg.treasuryBonus}
                    onChange={(v) => setCfg({ treasuryBonus: Math.max(0, Math.min(100, Number(v) || 0)) })}
                    min={0}
                    max={100}
                    size="xs"
                  />
                </Group>

                <Divider my={4} />
                <Text size="sm" fw={600}>Debugging</Text>
                <NumberInput
                  label="Enemy scale %"
                  description="Scales enemy effective level; 100% = official. Debug / what-if only."
                  value={enemyScalePct}
                  onChange={(v) => setCfg({ enemyScale: Math.max(5, Math.min(500, Number(v) || 100)) })}
                  min={5}
                  max={500}
                  step={5}
                  size="xs"
                />
                {enemyScalePct !== 100 && (
                  <Text size="xs" c="orange">
                    Results will be tagged as a debugging run, not an official projection.
                  </Text>
                )}

                <Divider my={4} />
                <Text size="sm" fw={600}>Guild shrine buffs (0 = off)</Text>
                {GUILD_COMBAT_BUFFS.map(b => (
                  <NumberInput
                    key={b.hrid}
                    label={`${b.name} — ${b.effect}`}
                    value={guildBuffLevels[b.hrid] || 0}
                    onChange={(v) => setBuffLevel(b.hrid, Math.max(0, Math.min(MAX_GUILD_BUFF_LEVEL, Number(v) || 0)))}
                    min={0}
                    max={MAX_GUILD_BUFF_LEVEL}
                    size="xs"
                  />
                ))}
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </>
      ) : simMode === 'zone' ? (
        <>
          <Select
            data={zoneOptions}
            value={zone}
            onChange={(v) => v && onZoneChange(v)}
            searchable
            allowDeselect={false}
            w={220}
            size="sm"
            aria-label="Combat zone"
          />
          <Select
            data={TIER_OPTIONS}
            value={String(difficultyTier)}
            onChange={(v) => v != null && onDifficultyChange(Number(v))}
            allowDeselect={false}
            w={80}
            size="sm"
            aria-label="Difficulty tier"
          />
        </>
      ) : (
        <>
          <Select
            data={labMonsterOptions}
            value={labConfig.monsterHrid}
            onChange={(v) => v && onLabConfigChange({ ...labConfig, monsterHrid: v })}
            searchable
            allowDeselect={false}
            w={180}
            size="sm"
            aria-label="Labyrinth monster"
          />
          <NumberInput
            value={labConfig.roomLevel}
            onChange={(v) => onLabConfigChange({
              ...labConfig,
              roomLevel: Math.max(1, Math.min(500, Number(v) || 100))
            })}
            min={1}
            max={500}
            step={20}
            w={90}
            size="sm"
            prefix="Lv "
            aria-label="Room level"
          />
          <Popover width={280} position="bottom-end" shadow="md">
            <Popover.Target>
              <Indicator
                disabled={crateCount + upgradeCount === 0}
                label={crateCount + upgradeCount}
                size={16}
              >
                <Button variant="default" size="sm">
                  Supplies
                </Button>
              </Indicator>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Text size="sm" fw={600}>Supply crates</Text>
                <Text size="xs" c="dimmed">
                  The game strips all food &amp; drinks on labyrinth entry —
                  crates are the only consumables inside, so the player
                  panel&apos;s food/drink slots are ignored for lab runs.
                </Text>
                {CRATE_CATEGORIES.map(cat => (
                  <Select
                    key={cat.key}
                    label={cat.label}
                    data={cat.items.map(h => ({ value: h, label: crateLabel(h) }))}
                    value={labConfig.crates[cat.key]}
                    onChange={(v) => onLabConfigChange({
                      ...labConfig,
                      crates: { ...labConfig.crates, [cat.key]: v || null }
                    })}
                    clearable
                    placeholder="None"
                    size="xs"
                    comboboxProps={{ withinPortal: false }}
                  />
                ))}
                <Text size="sm" fw={600} mt={4}>Lab-shop upgrades (+1%/level)</Text>
                {LAB_UPGRADE_FIELDS.map(f => (
                  <NumberInput
                    key={f.key}
                    label={f.label}
                    value={labConfig.upgrades[f.key]}
                    onChange={(v) => onLabConfigChange({
                      ...labConfig,
                      upgrades: {
                        ...labConfig.upgrades,
                        [f.key]: Math.max(0, Math.min(40, Number(v) || 0))
                      }
                    })}
                    min={0}
                    max={40}
                    size="xs"
                  />
                ))}
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </>
      )}

      {simMode === 'guildTrial' ? (
        <NumberInput
          value={cfg.iterations}
          onChange={(v) => setCfg({ iterations: Math.max(1, Math.min(100000, Number(v) || 1)) })}
          min={1}
          max={100000}
          step={100}
          w={110}
          size="sm"
          suffix=" runs"
          aria-label="Trial iterations"
        />
      ) : (
        <NumberInput
          value={duration}
          onChange={(v) => onDurationChange(Math.max(1, Math.min(1000, Number(v) || 1)))}
          min={1}
          max={1000}
          w={90}
          size="sm"
          suffix=" h"
          aria-label="Duration (hours)"
        />
      )}

      {/* Buffs (community buffs / seals / MooPass) do NOT apply inside guild
          trials — the trial worker sends a neutral extra — so the button is
          hidden in trial mode to avoid implying otherwise. */}
      {simMode !== 'guildTrial' && (
      <Popover width={280} position="bottom-end" shadow="md">
        <Popover.Target>
          <Indicator disabled={activeBuffCount === 0} label={activeBuffCount} size={16}>
            <Button variant="default" size="sm">
              Buffs
            </Button>
          </Indicator>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Community buffs
            </Text>
            <Select
              label="Experience"
              data={BUFF_LEVEL_OPTIONS}
              value={String(extraOptions.comExp)}
              onChange={(v) =>
                v != null && onExtraChange({ ...extraOptions, comExp: Number(v) })
              }
              allowDeselect={false}
              size="xs"
              comboboxProps={{ withinPortal: false }}
            />
            <Select
              label="Combat drop"
              data={BUFF_LEVEL_OPTIONS}
              value={String(extraOptions.comDrop)}
              onChange={(v) =>
                v != null && onExtraChange({ ...extraOptions, comDrop: Number(v) })
              }
              allowDeselect={false}
              size="xs"
              comboboxProps={{ withinPortal: false }}
            />
            <Switch
              label="MooPass (+5% wisdom)"
              size="xs"
              mt={4}
              checked={!!extraOptions.mooPass}
              onChange={(e) =>
                onExtraChange({ ...extraOptions, mooPass: e.currentTarget.checked })
              }
            />
            <Text size="sm" fw={600} mt={4}>
              Personal seals
            </Text>
            <Checkbox.Group
              value={extraOptions.personalBuffs || []}
              onChange={(values) =>
                onExtraChange({ ...extraOptions, personalBuffs: values })
              }
            >
              <Stack gap={4}>
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
          </Stack>
        </Popover.Dropdown>
      </Popover>
      )}

      <Button onClick={onStart} loading={loading} size="sm">
        Run
      </Button>
      {loading && (
        <Button onClick={onStop} variant="default" size="sm">
          Stop
        </Button>
      )}
    </Group>
  );
}
