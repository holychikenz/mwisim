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
# Peer-fork scan
# --------------
# Besides upstream, a third-party Chinese fork of the same simulator is served
# at $PEER_URL. It publishes no source repository and ships no source maps, so
# there is nothing to `git diff` against. What it DOES ship is the engine
# itself: the simulation runs entirely client-side inside web workers, and
# esbuild/terser preserve class-method names even under minification. That is
# enough to compare API surfaces.
#
# Note on "backend": the peer's actual server is thin — Express (helmet
# headers) exposing only /api/auth/{me,register,login,logout} and
# /api/v1/anonymous-simulations (telemetry). No combat maths happens there.
# The interesting "backend" is the worker bundle, which is what this scan
# pulls. If the peer ever grows a real server-side sim, the route dump in the
# report is where it will first show up.
#
# The scan downloads the peer's entry bundle, follows its lazy chunks and
# `new Worker(new URL(...))` references, extracts every method definition, and
# subtracts our own identifier set from src/combatsimulator/. What remains is
# a candidate list of features they have and we do not. It is heuristic and
# noisy by nature (embedded game data contributes false positives), so it is
# reported for human/model judgement, never applied automatically.
#
# Usage:
#   ./upstream-update.sh             # peer scan + upstream diff + interactive claude
#   ./upstream-update.sh --check     # peer scan + diff only; no model
#   ./upstream-update.sh --apply     # non-interactive claude (uses claude -p)
#   ./upstream-update.sh --peer      # peer-fork scan only; no upstream, no model
#
# Environment overrides:
#   UPSTREAM_URL     git URL (default: git@github.com:shykai/MWICombatSimulatorTest.git)
#   UPSTREAM_BRANCH  branch to track (default: Test — shykai's working branch)
#   CLAUDE_BIN       path to claude CLI (default: claude on PATH)
#   PEER_URL         peer fork origin (default: the sslip.io deployment)
#   PEER_SKIP=1      skip the peer scan entirely
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

# Peer fork (no repo, no source maps — analysed from its served bundles).
PEER_URL="${PEER_URL:-https://combat.43.167.210.211.sslip.io}"
PEER_DIR="$ROOT/.upstream/peer"
PEER_REPORT="$ROOT/.upstream/peer-report.md"
PEER_SKIP="${PEER_SKIP:-}"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
hdr()   { printf '\n%s\n' "$(color '1;34' "==> $*")"; }
warn()  { printf '%s\n' "$(color '33' "warn: $*")"; }
ok()    { printf '%s\n' "$(color '32' "ok:   $*")"; }
die()   { printf '%s\n' "$(color '31' "err:  $*")" >&2; exit 1; }

# ---- Sanity ---------------------------------------------------------------
[ -d "$ROOT/$SCOPED_PATH" ] || die "Not a csim checkout: $ROOT (missing $SCOPED_PATH/)"
command -v git >/dev/null   || die "git not on PATH"

mkdir -p "$ROOT/.upstream"

# ---- 0. Peer-fork scan ----------------------------------------------------
# Downloads the peer's served JS (entry bundle -> lazy chunks -> web workers)
# and diffs its method surface against ours. Heuristic; report only.
peer_fetch() {
    mkdir -p "$PEER_DIR"
    local index="$PEER_DIR/index.html"

    curl -fsS -k -L --max-time 60 "$PEER_URL/combat/setup" -o "$index" \
        || { warn "peer unreachable at $PEER_URL — skipping peer scan"; return 1; }

    # Entry bundle from <script type="module" src="/assets/index-XXXX.js">
    local entry
    entry="$(grep -oE 'src="/assets/[A-Za-z0-9_.-]+\.js"' "$index" \
             | head -1 | sed 's/^src="//; s/"$//')"
    [ -n "$entry" ] || { warn "no entry bundle found in peer index.html"; return 1; }
    ok "peer entry bundle: $entry"

    # Breadth-first: entry -> chunks it names -> workers those chunks spawn.
    # Two passes suffice for Vite's layout (workers are named inside chunks).
    local queue="$entry" seen="" pass
    for pass in 1 2 3; do
        local next=""
        for path in $queue; do
            case " $seen " in *" $path "*) continue ;; esac
            seen="$seen $path"
            local out="$PEER_DIR/$(basename "$path")"
            curl -fsS -k --max-time 120 "$PEER_URL/${path#/}" -o "$out" || continue
            # Guard against the SPA fallback serving index.html for a 404.
            case "$(head -c 15 "$out")" in '<!doctype html'*|'<!DOCTYPE html'*)
                rm -f "$out"; continue ;;
            esac
            next="$next $(grep -ohE '"assets/[A-Za-z0-9_.-]+\.js"' "$out" \
                          | tr -d '"' | sed 's|^|/|' | sort -u)"
            next="$next $(grep -ohE 'new Worker\(new URL\("/assets/[A-Za-z0-9_.-]+\.js' "$out" \
                          | grep -oE '/assets/[A-Za-z0-9_.-]+\.js' | sort -u)"
        done
        queue="$next"
        [ -n "$(echo "$queue" | tr -d ' ')" ] || break
    done

    ok "peer assets fetched: $(ls -1 "$PEER_DIR"/*.js 2>/dev/null | wc -l | tr -d ' ') files"
    return 0
}

peer_analyse() {
    command -v python3 >/dev/null || { warn "python3 not on PATH — skipping peer analysis"; return 1; }
    PEER_DIR="$PEER_DIR" ROOT="$ROOT" SCOPED_PATH="$SCOPED_PATH" \
    PEER_URL="$PEER_URL" python3 - > "$PEER_REPORT" <<'PYEOF'
import os, re, glob, collections

peer_dir = os.environ["PEER_DIR"]
root     = os.environ["ROOT"]
scoped   = os.environ["SCOPED_PATH"]
peer_url = os.environ["PEER_URL"]

def read(p):
    with open(p, encoding="utf8", errors="replace") as f:
        return f.read()

# --- our identifier surface -------------------------------------------------
ours = set()
for dirpath, dirnames, filenames in os.walk(os.path.join(root, scoped)):
    dirnames[:] = [d for d in dirnames if d != "data"]
    for fn in filenames:
        if fn.endswith(".js") and not fn.endswith(".test.js"):
            ours |= set(re.findall(r"\b([A-Za-z_$][A-Za-z0-9_$]{3,})\b",
                                   read(os.path.join(dirpath, fn))))

# --- peer surface -----------------------------------------------------------
# Method definitions survive minification (esbuild/terser keep property names).
DEF = re.compile(r"(?:^|[;{}\s,])((?:async\s+)?[A-Za-z_$][A-Za-z0-9_$]{4,})\s*\([^()]{0,120}\)\s*\{")

# The simulation engine lives in the web workers; everything else is Vue/
# Element Plus UI whose method names are pure noise against our engine. Split
# them so the signal is not buried — the UI table is kept, but demoted.
files = sorted(glob.glob(os.path.join(peer_dir, "*.js")))
def is_engine(name):
    return "orker" in name  # worker-*, multiWorker-*, guildTrialWorker-*

engine_defs = collections.defaultdict(set)
ui_defs     = collections.defaultdict(set)
routes      = set()
for p in files:
    src  = read(p)
    name = os.path.basename(p)
    sink = engine_defs if is_engine(name) else ui_defs
    for m in DEF.findall(src):
        sink[m.replace("async ", "").strip()].add(name)
    routes |= set(re.findall(r'"(/api/[A-Za-z0-9_/{}.-]*)"', src))

engine_files = [os.path.basename(p) for p in files if is_engine(os.path.basename(p))]
engine_cand  = {k: v for k, v in engine_defs.items() if k not in ours}
ui_cand      = {k: v for k, v in ui_defs.items() if k not in ours and k not in engine_defs}

print("# Peer-fork scan — candidate features\n")
print(f"Source: `{peer_url}` (no public repo, no source maps — analysed from")
print("served bundles). Method names survive minification; local variables do")
print("not, so this lists *what* they have, not *how well* they do it.\n")
print(f"Assets analysed: {len(files)} "
      f"({len(engine_files)} engine/worker, {len(files) - len(engine_files)} UI)\n")

print("## Server API routes observed in peer bundles\n")
print("The peer's simulation runs client-side in workers; its server handles")
print("accounts and persistence only. Anything here suggesting combat maths")
print("moved server-side is worth investigating.\n")
for r in sorted(routes) or ["_(none found)_"]:
    print(f"- `{r}`")

print("\n## Engine methods present in peer, absent from ours\n")
print("**This is the signal.** These come from the peer's simulation workers")
print(f"({', '.join(engine_files) or 'none found'}) and are the real candidates")
print("for adoption.\n")
if not engine_cand:
    print("_(none — peer engine surface is a subset of ours)_")
else:
    print("| method | seen in |")
    print("| --- | --- |")
    for k in sorted(engine_cand):
        print(f"| `{k}` | {', '.join(sorted(engine_cand[k]))} |")

print("\n## UI-layer methods absent from ours (low signal)\n")
print("Vue/Element Plus components and app plumbing. Almost always irrelevant")
print("to the engine — skim only if the engine table looks thin.\n")
print(f"<details><summary>{len(ui_cand)} names</summary>\n")
print(", ".join(f"`{k}`" for k in sorted(ui_cand)) or "_(none)_")
print("\n</details>")
PYEOF
    ok "peer report written to $PEER_REPORT"
    return 0
}

PEER_OK=0
if [ -n "$PEER_SKIP" ]; then
    warn "PEER_SKIP set — skipping peer-fork scan"
else
    hdr "Scanning peer fork ($PEER_URL)"
    if peer_fetch && peer_analyse; then
        PEER_OK=1
        CANDIDATES=$(grep -c '^| `' "$PEER_REPORT" || true)
        echo "  candidate methods: $CANDIDATES"
        echo "  peer report:       $PEER_REPORT"
    fi
fi

if [ "$MODE" = "--peer" ]; then
    hdr "Peer-only mode (--peer) — skipping upstream and claude"
    [ "$PEER_OK" = "1" ] || die "peer scan failed"
    exit 0
fi

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
    [ "$PEER_OK" = "1" ] && ok "peer findings still available at $PEER_REPORT"
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

# Peer-fork findings are advisory context, appended after the actionable patch
# so the model treats the rebase as the primary task.
if [ "$PEER_OK" = "1" ]; then
    {
        printf '\n---\n\n# Appendix — peer fork (advisory, do NOT apply)\n\n'
        printf 'A third-party fork of the same simulator is deployed at %s.\n' "$PEER_URL"
        printf 'It ships no source, so the below is recovered from its minified\n'
        printf 'worker bundles. Treat it as a FEATURE-IDEA LIST only.\n\n'
        printf 'Rules for this appendix:\n'
        printf '1. Do NOT change any code because of it during this rebase.\n'
        printf '2. In your report, add a short section "Peer fork worth stealing"\n'
        printf '   naming at most the 3 most credible candidates and, for each, one\n'
        printf '   line on what it would take to implement in our tree.\n'
        printf '3. Ignore entries that are obviously bundled game data, Vue/Element\n'
        printf '   Plus internals, or names we already implement under a different\n'
        printf '   spelling.\n\n'
        cat "$PEER_REPORT"
    } >> "$PROMPT_FILE"
    ok "appended peer findings to prompt"
fi

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
