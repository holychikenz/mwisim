#!/usr/bin/env bash
# =============================================================================
# upstream-update.sh
# -----------------------------------------------------------------------------
# Pulls combat-logic changes from upstream (shykai/MWICombatSimulatorTest)
# into our vendored copy of csim. Hands a structured rebase brief to
# `claude` so any non-trivial conflicts are resolved by the model rather
# than by silent merge driver.
#
# Scope: only the main JavaScript combat logic in `src/combatsimulator/`.
# Everything else (UI under src/main.js, the React app under ui/, the
# Express API under api/, build configs, locales) is owned by us and
# ignored by this script.
#
# Adaptations on top of upstream that the rebase prompt is told to preserve:
#   - Labyrinth maze bonuses via `options.maze` — Player.applyMazeBonuses()
#     and CombatSimulator{MAZE_DEFAULTS, resolveMazeBonuses, mazeBonuses,
#     processCombatStartEvent call}. Landed in csim.
#   - Headless data-source override — `dataProvider.js` exports mutable
#     copies of the bundled JSON maps and exposes setOverrides() so
#     external callers (MWIX) can feed live game clientData. Every
#     consumer imports from "./dataProvider" instead of "./data/*.json".
#   - Any other local edits to src/combatsimulator/*.js — listed by this
#     script as "still-not-upstreamed" so the model can flag them.
#
# Usage:
#   ./upstream-update.sh             # check + interactive claude
#   ./upstream-update.sh --check     # diff only; no model
#   ./upstream-update.sh --apply     # non-interactive claude (uses claude -p)
#
# Environment overrides:
#   UPSTREAM_URL     git URL (default: git@github.com:shykai/MWICombatSimulatorTest.git)
#   UPSTREAM_BRANCH  branch to track (default: Test — shykai's working branch)
#   CLAUDE_BIN       path to claude CLI (default: claude on PATH)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_URL="${UPSTREAM_URL:-git@github.com:shykai/MWICombatSimulatorTest.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-testing}"
SNAPSHOT_DIR="$ROOT/.upstream/MWICombatSimulatorTest"
DIFF_FILE="$ROOT/.upstream/diff.patch"
PROMPT_FILE="$ROOT/.upstream/rebase-prompt.md"
SCOPED_PATH="src/combatsimulator"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MODE="${1:-interactive}"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
hdr()   { printf '\n%s\n' "$(color '1;34' "==> $*")"; }
warn()  { printf '%s\n' "$(color '33' "warn: $*")"; }
ok()    { printf '%s\n' "$(color '32' "ok:   $*")"; }
die()   { printf '%s\n' "$(color '31' "err:  $*")" >&2; exit 1; }

# ---- Sanity ---------------------------------------------------------------
[ -d "$ROOT/$SCOPED_PATH" ] || die "Not a csim checkout: $ROOT (missing $SCOPED_PATH/)"
command -v git >/dev/null   || die "git not on PATH"

mkdir -p "$ROOT/.upstream"

# ---- 1. Fetch / refresh upstream snapshot ---------------------------------
hdr "Refreshing upstream snapshot"
if [ ! -d "$SNAPSHOT_DIR/.git" ]; then
    git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_URL" "$SNAPSHOT_DIR"
    ok "cloned $UPSTREAM_URL @ $UPSTREAM_BRANCH"
else
    git -C "$SNAPSHOT_DIR" fetch --depth 1 origin "$UPSTREAM_BRANCH"
    git -C "$SNAPSHOT_DIR" reset --hard "origin/$UPSTREAM_BRANCH"
    ok "fetched origin/$UPSTREAM_BRANCH"
fi

UPSTREAM_SHA="$(git -C "$SNAPSHOT_DIR" rev-parse --short HEAD)"
ok "upstream HEAD = $UPSTREAM_SHA"

# ---- 2. Diff ---------------------------------------------------------------
hdr "Computing diff against $SCOPED_PATH/"
# `diff -r -u -N --exclude='data/*.json' --exclude='*.test.js'`
# We exclude data JSON deliberately — those are handled separately (see
# README "Data deduplication" notes).
{
    diff -ruN \
        --exclude='data' \
        --exclude='*.test.js' \
        "$SNAPSHOT_DIR/$SCOPED_PATH" \
        "$ROOT/$SCOPED_PATH" \
        || true
} > "$DIFF_FILE"

LINES=$(wc -l < "$DIFF_FILE" | tr -d ' ')
if [ "$LINES" -le 1 ]; then
    ok "no scoped diff — up to date with upstream"
    rm -f "$DIFF_FILE"
    exit 0
fi

# Quick summary
FILES_CHANGED=$(grep -cE '^(---|\+\+\+) ' "$DIFF_FILE" | awk '{print int($1 / 2)}')
ADDED=$(grep -cE '^\+[^+]' "$DIFF_FILE" || true)
REMOVED=$(grep -cE '^-[^-]' "$DIFF_FILE" || true)
echo "  files touched: $FILES_CHANGED"
echo "  lines added:   $ADDED"
echo "  lines removed: $REMOVED"
echo "  full patch:    $DIFF_FILE"

# ---- 3. Mode handling -----------------------------------------------------
if [ "$MODE" = "--check" ]; then
    hdr "Diff-only mode (--check) — not invoking claude"
    exit 0
fi

# ---- 4. Build the rebase prompt -------------------------------------------
hdr "Composing rebase prompt"
cat > "$PROMPT_FILE" <<EOF
# csim ← shykai/MWICombatSimulatorTest rebase

Pull upstream simulator changes into our vendored copy at
\`cowstuff/csim/${SCOPED_PATH}/\`. Upstream HEAD is **${UPSTREAM_SHA}**
(\`${UPSTREAM_BRANCH}\` branch of \`${UPSTREAM_URL}\`).

## Adaptations on top of upstream — preserve these

These are MWIX-side adjustments to the simulator that have intentionally
not been pushed upstream. Treat them as load-bearing; only touch them if
upstream specifically changed the same surface area.

- **\`options.maze\` and Player.applyMazeBonuses()** — when the caller
  constructs \`new CombatSimulator(players, zone, labyrinth, { maze: true })\`
  (or \`{ maze: { …overrides } }\`), the simulator applies the labyrinth
  player buffs in \`processCombatStartEvent\` after each \`player.reset()\`.
  Touched files: \`combatSimulator.js\` (constants \`MAZE_DEFAULTS\`, static
  \`resolveMazeBonuses\`, field \`mazeBonuses\`, call in
  \`processCombatStartEvent\`) and \`player.js\` (method
  \`applyMazeBonuses\`). Defaults:
    - playerLevelBonus       = 15
    - attackSpeedBonus       = 0.15
    - regenBonus             = 0.06
    - critRateBonus          = 0.06
    - critDamageBonus        = 0.10
- **\`dataProvider.js\` headless data-source override** — replaces
  \`import X from "./data/*.json"\` with \`import { X } from
  "./dataProvider"\` across every consumer (ability, achievement,
  consumable, equipment, houseRoom, labyrinth, monster, simResult,
  trigger, zone). dataProvider exposes mutable copies of the bundled JSON
  pre-seeded from disk; \`setOverrides(maps)\` rewrites them in place so
  ES live bindings propagate to every consumer. Only dataProvider.js
  should still hold direct \`./data/*.json\` imports.
- **Multi-source buff instance tracking (7/15/2026 patch parity)** — in
  \`combatUnit.js\`, \`buffInstances\` maps each buff's \`uniqueHrid\` to an
  array of per-source instances; \`combatBuffs\` is the DERIVED "strongest
  active" view every existing reader keeps consuming unchanged.
  \`addBuff\`/\`addBuffs\`/\`removeBuff\`/\`removeBuffs\` take an optional
  \`sourceRef\` param defaulting to the receiving unit (\`this\`). In
  \`combatSimulator.js\`, the two ability-buff sites pass the caster as
  \`source\` (the \`processAbilityBuffEffect\` allAllies branch and the
  damage-rider buff loop) so multiple sources arbitrate by strength instead
  of last-writer-wins. Each is marked \`// MWIX adaptation (7/15/2026 patch
  parity)\`. NOTE: the curse/weaken/fury call sites INTENTIONALLY remain
  default-sourced — they are shared-stack mechanics whose single rescheduled
  expiration event only covers the latest application, so per-source
  attribution would create phantom-expiry windows. Do not thread sourceRef
  through them.
- Any other local edits beneath \`${SCOPED_PATH}/\` — list them in the
  rebase report so we keep a running ledger.

## What to do

1. Read \`.upstream/diff.patch\` (also referenced inline below).
2. Apply the upstream changes to our files under \`${SCOPED_PATH}/\`,
   reconciling with our adaptations.
3. For each non-trivial conflict, explain your choice in the report.
4. Do NOT touch:
    - \`src/combatsimulator/data/\` (data deduplication is handled
      elsewhere)
    - tests (\`*.test.js\` excluded from the diff)
    - anything outside \`${SCOPED_PATH}/\`
5. End with a report:
    - **Files touched**: list paths.
    - **Conflicts**: each with chosen resolution + reasoning.
    - **Upstream features incompatible with our adaptations**: flag for
      manual review.
    - **Still-not-upstreamed local edits**: anything that remains divergent
      after the rebase.

## The patch

\`\`\`diff
$(cat "$DIFF_FILE")
\`\`\`
EOF

ok "wrote prompt to $PROMPT_FILE"

# ---- 5. Hand off to claude ------------------------------------------------
hdr "Invoking $CLAUDE_BIN"
if ! command -v "$CLAUDE_BIN" >/dev/null; then
    die "$CLAUDE_BIN not on PATH — set CLAUDE_BIN or install Claude Code"
fi

case "$MODE" in
    --apply)
        # Non-interactive: claude -p prints a response but cannot edit files
        # without explicit tool-allow flags. We try with editing enabled.
        "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")"
        ;;
    *)
        # Interactive: drop into Claude Code with the prompt as initial
        # input. The user reviews the model's edits before they land.
        "$CLAUDE_BIN" < "$PROMPT_FILE"
        ;;
esac
