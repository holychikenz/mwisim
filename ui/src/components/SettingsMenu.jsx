import { Popover, ActionIcon, Stack, Text, SegmentedControl, Indicator, Divider, Anchor } from '@mantine/core';
import { EXPERIMENTAL_DEFAULTS, countExperimentsOn } from '../utils/experimental';

// =============================================================================
// SettingsMenu — the cog beside Run. Home for EXPERIMENTAL engine knobs: model
// changes we want to A/B against live play before adopting (or rejecting) them.
//
// House rules for anything added here:
//   * the default is always upstream's current behaviour;
//   * the label says what the alternative IS, not merely that it exists;
//   * the note says where the number came from, so a year from now the setting
//     is still evidence rather than folklore.
//
// The indicator on the cog counts knobs away from their default — a forgotten
// experiment is the one thing worse than no experiment at all.
// =============================================================================

export function SettingsMenu({ settings, onChange }) {
  const s = { ...EXPERIMENTAL_DEFAULTS, ...(settings || {}) };
  const activeCount = countExperimentsOn(s);
  const set = (patch) => onChange({ ...s, ...patch });

  return (
    <Popover width={320} position="bottom-end" shadow="md">
      <Popover.Target>
        <Indicator disabled={activeCount === 0} label={activeCount} size={16} color="orange">
          <ActionIcon
            variant={activeCount > 0 ? 'light' : 'default'}
            color={activeCount > 0 ? 'orange' : undefined}
            size="lg"
            aria-label="Experimental settings"
          >
            {/* No icon package in this UI — the glyph is the icon. */}
            <span style={{ fontSize: 16, lineHeight: 1 }}>⚙</span>
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>Experimental</Text>
          <Text size="xs" c="dimmed">
            Engine models under test. Defaults reproduce the simulator's
            established behaviour exactly — change one only while you are
            measuring it.
          </Text>

          <Divider my={4} />

          <Text size="sm" fw={600}>Monster opening cooldown</Text>
          <SegmentedControl
            size="xs"
            fullWidth
            value={s.monsterStartCooldown}
            onChange={(v) => set({ monsterStartCooldown: v })}
            data={[
              { value: 'auto', label: 'Auto' },
              { value: 'random', label: 'Random' },
              { value: 'half', label: 'Half' }
            ]}
          />
          <Text size="xs" c="dimmed">
            How much of an ability's cooldown a monster still owes when the
            fight starts. <b>Auto</b> (default) uses the model measured for each
            context: a flat 0.5 × cooldown in the labyrinth, and a uniform draw
            on 0.5–1.0 × cooldown (mean 0.75) in zone and dungeon combat.
            <b> Random</b> and <b>Half</b> force one model everywhere, for A/B
            work.
          </Text>
          <Text size="xs" c="dimmed">
            Both figures come from websocket captures fitted reference-free:
            86 labyrinth rooms (2026-08-29) gave a slope of 0.5000 with zero
            residual, 270 zone encounters (2026-08-28) gave 0.7484 with real
            scatter. A labyrinth room starts from a standing start; a zone
            monster spawns into a fight already running.
          </Text>

          {activeCount > 0 && (
            <>
              <Divider my={4} />
              <Anchor component="button" type="button" size="xs" onClick={() => onChange({ ...EXPERIMENTAL_DEFAULTS })}>
                Reset to defaults
              </Anchor>
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
