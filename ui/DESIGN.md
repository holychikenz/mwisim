# UI design: Moss & Stone

Decisions for the React UI redesign (agreed 2026-10-09). Theme tokens live in
`src/theme.js`; this file records the rules the layout follows.

## Theme
- Palette **Moss & Stone**: moss accent, stone grounds, raked-sand data marks.
  Semantic names keep their meaning (red bad, yellow/orange warn, teal good).
- Scheme follows the OS by default; Auto / Light / Dark switch in the settings cog.
- Type: Shippori Mincho headings, Zen Kaku Gothic New body, tabular digits in
  the body face (no monospace figures). No kanji or other decorative glyphs.

## Structure (L2)
- **Header**: brand, mode tabs (Zone · Lab · Trial · Triggers · Gear · Costs), settings.
- **Rail** (left, narrow): one card per party member — character, loadout,
  combat level, warnings, in/out of the sim. Trial mode shows the roster as
  the same cards plus a role chip. Global buffs sit in a card at the rail's foot.
- **Editor sheet**: clicking a card opens it. Tabs: Levels · Gear · Abilities ·
  Buffs · Food. Pinned beside the results at ≥1440 px, overlays below that.
- **Run strip**: top of the main pane — zone/tier/hours (or the mode's
  equivalents), All Zones, Run. Mode settings (optimiser slots, fidelity,
  thresholds, trial options) live in a collapsible panel directly under it.

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

## Rule of thumb
No information is dropped: it may move, group or fade, never vanish.
