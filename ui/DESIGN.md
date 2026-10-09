# UI design: Moss & Stone

Decisions for the React UI redesign (agreed 2026-10-09). Theme tokens live in
`src/theme.js`; this file records the rules the layout follows.

## Theme
- Palette **Moss & Stone**: moss accent, stone grounds, raked-sand data marks.
  Semantic names keep their meaning (red bad, yellow/orange warn, teal good).
- Scheme follows the OS by default; Auto / Light / Dark switch in the settings cog.
- Type: the system UI font throughout (headings by weight, not a second
  family), tabular digits. Web fonts were tried and rejected: they rendered
  poorly at the sidebar's 12–13 px. No kanji or other decorative glyphs.

## Structure (L2)
- **Header**: brand, mode tabs (Zone · Lab · Trial · Triggers · Gear · Costs), settings.
- **Rail** (left, narrow): one card per party member — character, loadout,
  combat level, warnings, in/out of the sim. Trial mode shows the roster as
  the same `.member-card`s: name, CL, loadout · weapon · best skill, the
  own-shrines line, a role chip only when the roster entry carries one, and
  ×N with the row actions (+1, save as new, delete). The roster tools (add
  build, existing loadout, duplicate ×N) sit above the cards and roster
  import/export below. Global buffs sit in a card at the rail's foot.
- **Editor sheet**: clicking a card opens it. Tabs: Levels · Gear · Abilities ·
  Buffs · Food. Pinned beside the results at ≥1440 px, overlays below that.
- **Run strip**: top of the main pane — zone/tier/hours (or the mode's
  equivalents), All Zones, Run. Mode settings (optimiser slots, fidelity,
  thresholds, trial options) live in a collapsible panel directly under it.
  The optimiser panels use the main pane's width: two columns from Mantine
  `lg` (what to search on the left; costs, workload and fidelity on the
  right), one column below.
- **One Run**: the run strip's Run (and Stop) is the only one, in every mode.
  The optimisers' panels hold settings only; in Triggers the strip's button
  reads "Optimise N thresholds", in Gear "Run equipment scan", and each is
  disabled until there is something to run.
- **Narrow screens** (below Mantine `sm`, 768 px): the rail is hidden and a
  burger in the header opens it as an overlay; picking a member closes it and
  opens the sheet. The brand moves from the header to the top of the rail, so
  the mode tabs keep the header (they scroll sideways rather than overflow).

## Gear (G2)
Paper doll: slots as a 3-column grid of tiles (slot, item, +N). Clicking a tile
opens one searchable picker with the enhancement level; owned items first.

## Results
- **Summary (S2)**: three grouped cards — Run (zone name, difficulty, time
  simulated), Pace (enc/h, effective enc/h, encounters), Outcome (XP/h raw and
  effective, deaths/h). Every value keeps its own slot.
- **Never show a slot for a figure the run does not have** (no "Profit —").
- **Experience (X1)**: character names, zero cells kept but faded, per-player
  share bar.
- Result tabs stay plain.
- **Tables**: every result table sits in a `Section` paper (title left,
  caption or total right). Numbers are right-aligned tabular digits (`NumTd`);
  zeros and unpriced cells stay but fade (`.num-faded`, "—"). Engine ids are
  shown as names via `nameOf` (party member, monster, item, ability; else a
  tidied last segment), never as hrids. Shares are `sand` bars (`ShareBar`).
  Side-by-side sections (kills | deaths, the four restore/usage tables) wrap
  to one column on narrow screens. A capped table says so ("Top 30 of N").
  Shared parts live in `src/components/ResultParts.jsx` (`StatGroup`,
  `StatCard`, `Section`, `NumTd`, `ShareBar`).

## Persistence
- UI **choices** (open tab, panel open/closed, sort order, view toggles) are
  remembered across re-runs and reloads through one helper,
  `usePersistentState(key, default, validate)` in `src/hooks/usePersistentState.js`.
  Keys start with `csim_ui_`; every stored value is validated against what is
  allowed, and storage failures fall back to the default silently.
- Never data or session state: those have their own stores.
- A remembered choice the current view does not offer (Lab Stats after a zone
  run) falls back for that view only and is **not** written back, so it
  returns when it applies again.
- Re-running keeps the previous results mounted (no reset of tabs or scroll),
  dimmed and badged "Previous run" until the new results arrive; a failed run
  leaves them badged "the last run did not finish". Anything a results view
  derives and holds itself (e.g. Gear's return-on-investment costs) is tied to
  the run it came from and never shown against another.
- Key registry: `csim_ui_result_tab`, `csim_ui_sheet_tab`, `csim_ui_sheet_open`,
  `csim_ui_mode_settings_open`, `csim_ui_global_buffs_open`,
  `csim_ui_drops_credit_mode`, `csim_ui_trial_monsters_collapsed`,
  `csim_ui_trigopt_stages_open`, `csim_ui_equipopt_fidelity_open`,
  `csim_ui_allzones_sort`.

## Rule of thumb
No information is dropped: it may move, group or fade, never vanish.
