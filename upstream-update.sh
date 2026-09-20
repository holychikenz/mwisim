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
#   - Headless data-source override — `dataProvider.js` exports mutable
#     copies of the bundled JSON maps and exposes setOverrides() so
#     external callers (MWIX) can feed live game clientData. Every
#     consumer imports from "./dataProvider" instead of "./data/*.json".
#   - Guild Trial mode — `options.guildTrial` plus guildTrial.js and
#     guildTrialStats.js; the climbing-tier ladder and its combat-loop
#     rules (no XP/loot/enrage/consumables, dead-stay-dead, bonus regen).
#   - OFFICIAL_PARRY_GATE — the official 5-attempt parry model, used in
#     trials only; the legacy zone/labyrinth checkParry is kept verbatim.
#   - Multi-source buff instance tracking — combatUnit.js `buffInstances`
#     with `combatBuffs` as the derived strongest-active view.
#   - Labyrinth 120 s hard cutoff — labyrinthTimeoutEvent.js plus the
#     room-outcome log and the Lab Stats snapshot.
#   - Any other local edits to src/combatsimulator/*.js — listed by this
#     script as "still-not-upstreamed" so the model can flag them.
#
# NOTE: the labyrinth "maze" player-buff mechanism (`options.maze`,
# MAZE_DEFAULTS, resolveMazeBonuses, mazeBonuses, Player.applyMazeBonuses)
# was REMOVED in 676a478 — it double-counted the labyrinth crate buffs. The
# rationale lives at src/combatsimulator/combatSimulator.js:44-51 and
# player.js is now byte-identical to upstream. Do not re-add it to the
# ledger. The surviving `mwixMaze` flag (ui/src/App.jsx -> src/worker.js) is
# an unrelated lab-shop-upgrade gate.
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
#   UPSTREAM_BRANCH  branch to track (default: testing — shykai's working branch)
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
#
# DIRECTION IS LOAD-BEARING: ours FIRST, upstream SECOND, so the patch reads
# ours -> upstream and therefore
#   `+` lines = upstream content we do NOT have  -> the changes to pull in
#   `-` lines = our local adaptations upstream lacks -> to preserve
# The operands were reversed before (upstream first), which produced an
# upstream -> ours patch. That is a silent-failure generator: upstream's new
# code showed up as `-` lines, read as "code we removed", and would be filed
# under "still-not-upstreamed local edits" and quietly dropped. Do not swap
# these back — and if you do, fix the polarity note in the prompt heredoc too.
{
    diff -ruN \
        --exclude='data' \
        --exclude='*.test.js' \
        "$ROOT/$SCOPED_PATH" \
        "$SNAPSHOT_DIR/$SCOPED_PATH" \
        || true
} > "$DIFF_FILE"

LINES=$(wc -l < "$DIFF_FILE" | tr -d ' ')
if [ "$LINES" -le 1 ]; then
    ok "no scoped diff — up to date with upstream"
    rm -f "$DIFF_FILE"
    [ "$PEER_OK" = "1" ] && ok "peer findings still available at $PEER_REPORT"
    exit 0
fi

# Quick summary. The patch reads ours -> upstream (see the direction note
# above), so `+` counts INCOMING upstream lines and `-` counts our local-only
# lines. Labelled accordingly so the summary cannot be read backwards.
FILES_CHANGED=$(grep -cE '^(---|\+\+\+) ' "$DIFF_FILE" | awk '{print int($1 / 2)}')
INCOMING=$(grep -cE '^\+[^+]' "$DIFF_FILE" || true)
LOCAL_ONLY=$(grep -cE '^-[^-]' "$DIFF_FILE" || true)
echo "  files differing:        $FILES_CHANGED"
echo "  incoming upstream (+):  $INCOMING"
echo "  our local-only (-):     $LOCAL_ONLY"
echo "  full patch:             $DIFF_FILE"

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
- **Guild Trial mode** — \`options.guildTrial\` plus the ours-only
  \`guildTrial.js\` (tier ladder: start 100, +10 per clear, cap 300) and
  \`guildTrialStats.js\` (per-iteration extraction, reward/token maths,
  cross-iteration aggregation). In \`combatSimulator.js\` the mode gates a
  set of combat-loop rules: no XP, no loot/drop-rate bookkeeping, no
  enrage tick, no consumables (replaced by flat bonus HP/MP regen),
  dead-players-stay-dead via \`trialDeadPlayers\`, the 1-hour simulated-time
  cap, \`_trialEncounterHpRemovedFrac()\`, and \`finalizeGuildTrial\`. In
  \`monster.js\`, \`trialHpScaleFactor\` (+1% max HP per participant) is
  re-applied after \`super.updateCombatDetails()\` so stat recomputes do not
  wipe it, and the \`rareDropTable\` loop is null-guarded for loot-free trial
  monsters. \`simResult.js\` carries the whole \`trial*\` field set and its
  recorders.
- **\`OFFICIAL_PARRY_GATE\`** — \`checkParryOfficial\` + \`MAX_PARRY_ATTEMPTS = 5\`
  implements the official "at most 5 parry attempts per incoming attack"
  rule, applied in GUILD-TRIAL mode ONLY. The legacy \`checkParry\` model
  (one roll by a random parry-capable defender, success redirects and breaks
  the cast) is preserved verbatim for zone/labyrinth parity. Both
  \`processAutoAttackEvent\` and \`processAbilityDamageEffect\` carry the
  \`useOfficialParry\` branch; to make the official rule universal later,
  delete the legacy branches in both.
- **\`MAX_TICKS\` event-loop guard** — \`simulate()\` throws after 5 000 000
  event iterations so a future wiring bug surfaces as an error rather than a
  frozen browser tab.
- **Labyrinth 120 s hard cutoff** — the ours-only
  \`events/labyrinthTimeoutEvent.js\`, scheduled in \`startNewEncounter\` at
  \`start + Labyrinth.ROOM_DURATION_NS\` and handled by
  \`processLabyrinthTimeoutEvent\`, so a killing blow past the buzzer is
  never simulated. \`labyrinth.js\` gained \`static ROOM_DURATION_NS\` as the
  single source of truth for both this and \`checkTimeout()\`.
- **Labyrinth reporting** — \`simResult.labRoomOutcomes\` /
  \`addLabRoomOutcome\` log every resolved room (win/death/timeout with the
  monster's surviving HP%), \`firstEncounterFinishTime\` gives a
  single-attempt clear time, and \`captureStatSnapshot\` /
  \`_collectBuffSources\` snapshot the actual player & monster combat stats
  (grouped by buff source) for the "Lab Stats" UI panel.
- **Player death recording** — upstream records monster deaths only, so
  callers reading \`simResult.deaths\` for win/loss had no signal;
  \`checkEncounterEnd\` now calls \`simResult.addDeath(player)\` on the
  zone/lab path (and on the trial path, gated by \`trialDeadPlayers\`).
- **\`combatUnit.js\` misc** — \`/buff_types/max_hitpoints\` and
  \`/buff_types/max_manapoints\` (Spirit shrine, 7/13/2026) are read as
  LOCALS and folded into the max HP/MP formulas rather than mutating
  persistent state, because \`updateCombatDetails\` re-runs on every buff
  add/remove. \`zoneBuffs\` / \`extraBuffs\` default to \`[]\` instead of
  upstream's \`{}\` so callers that drive CombatSimulator directly (no
  worker) do not crash in \`generatePermanentBuffs()\`.
- **Hot-path caches (performance, measured)** — four behaviour-preserving
  changes that took a geared 5-player \`chimerical_den\` hour from 550 ms to
  216 ms (2.55x) and a geared solo \`fly\` run from 350 ms to 142 ms (2.46x),
  with output BIT-IDENTICAL under a seeded PRNG (see \`npm run sim:check\`).
  Upstream will show its unmemoised originals on the \`+\` side of every one of
  these; keep ours.
    - \`player.js\`: the 70-name stat array is hoisted to a module-level
      \`export const EQUIPMENT_COMBAT_STATS\`, and \`updateCombatDetails()\`
      copies the per-player sums from \`_equipmentStatTotals\` instead of
      re-running \`Object.values().filter().map().reduce()\` 70 times (210
      allocations per call, 2 574 calls per simulated hour, 19.3% of profiled
      self time). \`_computeEquipmentStatTotals\` / \`_equipmentChanged\` keep
      the cache honest against the browser's equip-then-recompute path.
      NOTE: this supersedes the older claim below that \`player.js\` is
      byte-identical to upstream — it no longer is.
    - \`combatUnit.js\`: \`getBuffBoosts\`/\`getBuffBoost\` read a lazy
      \`_buffBoostIndex\` (typeHrid -> boosts) and \`_buffBoostSums\` instead of
      scanning \`Object.values(this.combatBuffs).filter(...)\` on each of
      359 394 queries per hour (16.2% of self time, the profile's largest
      entry). \`_invalidateBuffBoostIndex()\` is called from the ONLY two
      writers of \`combatBuffs\` — \`_commitInstances\` and \`clearBuffs\`. If
      upstream adds a third writer, it MUST invalidate too; a missed write path
      yields wrong combat numbers with no error. The returned arrays/objects
      are shared and read-only by contract.
    - \`events/eventQueue.js\`: the predicate methods iterate
      \`this.minHeap.heapArray\` directly rather than calling \`toArray()\`,
      which heap-js implements as a per-element ES5-iterator copy (2 305 965
      entries walked per hour). \`heapArray\` is public but undocumented, so
      \`heap-js\` is pinned to an exact \`2.7.1\` in every package.json that
      declares it, and the constructor asserts the field exists.
      \`clearMatching\` collects before removing, because \`remove()\`
      re-heapifies in place.
    - \`equipment.js\`: \`getCombatStat\` is a memo over the verbatim upstream
      body, now named \`_computeCombatStat\`; 2 710 422 calls per hour. The memo
      is keyed on \`enhancementLevel\` as well as the stat name.
  Guarded by ours-only \`api/tests/statCaching.test.mjs\` and the
  \`fixtures/sim/\` golden replays (\`api/sim-parity.mjs\`). Run both after any
  rebase that touches these four files.
- **Buff-apply path (performance, measured)** — a second round of
  behaviour-preserving changes, aimed at the stat recompute that a buff
  application triggers. A user reported that abilities like
  \`elemental_affinity\` made simulations crawl; a controlled sweep confirmed
  that adding one three-buff 30 s ability to an otherwise identical magic build
  took a simulated hour from 6.1 to 11.9 ms. These took the new
  \`selfbuff-solo\` candle case from 18.6 to 13.5 ms/sim-h (-27%),
  \`tank-solo\` -28%, \`magic-solo\` -21%, \`dungeon-den-600\` -16%, with
  output BIT-IDENTICAL (\`npm run sim:check\` 3/3). Upstream will show its
  originals on the \`+\` side; keep ours.
    - \`combatUnit.js\` \`removeExpiredBuffs()\`: the trailing
      \`updateCombatDetails()\` is now CONDITIONAL on \`_commitInstances\`
      having reported an actual change, replacing an unconditional recompute
      that carried the comment "for behavior parity with the old code". The
      method is called once per combat event from five sites in
      \`combatSimulator.js\`, so nearly every one of those recomputes was
      discarded. This is the single largest win of the four (about half of it).
      It is only sound because \`updateCombatDetails()\` is IDEMPOTENT — every
      \`+=\` target is reset from equipment or game data at the top of the call
      — which is asserted directly in \`statCaching.test.mjs\`. If upstream
      ever makes the recompute accumulate onto persistent state, the call COUNT
      becomes observable and this must be reverted.
    - \`combatUnit.js\` \`clearBuffs()\`: \`structuredClone(this.permanentBuffs)\`
      is replaced by an explicit per-entry field copy. Every unit is
      \`reset()\` — and so \`clearBuffs()\`-ed — at each of the 600+ encounters
      in a simulated hour, and permanent-buff entries are five scalar fields
      built by \`addPermanentBuff\`, so the structured-clone algorithm bought
      nothing but cost ~2% of profiled self time. Worth ~9 percentage points on
      the solo cases.
    - \`combatUnit.js\` \`updateCombatDetails()\`: the inline
      \`["stamina", ...]\` and \`["stab", "slash", "smash"]\` arrays are hoisted
      to module-level \`LEVEL_STATS\` / \`ATTACK_STYLES\` tables holding the
      CONCATENATED property keys, and the two \`.forEach\` closures become
      plain loops. Upstream rebuilt the arrays and ~30 key strings on every
      recompute; the profile put the styles closure at 3.9% of self time and the
      levels closure at 2.0%. The evasion boosts are also fetched once instead
      of once per style — the array returned is the shared read-only index
      entry, so all three iterations already read the identical object. No
      arithmetic is reordered, which is why parity holds.
    - \`monster.js\`: the 63-name zero-fill array inside
      \`updateCombatDetails()\` is hoisted to a module-level
      \`export const MONSTER_ZEROED_COMBAT_STATS\`, exactly as
      \`EQUIPMENT_COMBAT_STATS\` was in \`player.js\`. It was moved VERBATIM;
      two of the names carry DIGITS (\`hpRegenPer10\`, \`mpRegenPer10\`) and
      regenerating the list by pattern-matching would drop precisely those two.
      Asserted in \`statCaching.test.mjs\`.
  TRIED AND DISCARDED, so nobody re-derives it: caching the soonest buff expiry
  time to give \`removeExpiredBuffs\` an O(1) early-out before it allocates an
  \`Object.keys\` and scans. It is correct and it passed parity, but a
  back-to-back A/B at \`--reps=9\` could not distinguish it from noise on any
  case, so it was dropped rather than shipped for the added invalidation
  surface. The scan it skips is already cheap once the recompute behind it is
  gone.
  Also note the user's original hypothesis was WRONG in an instructive way:
  applying N buffs from one ability does NOT trigger N recomputes.
  \`addBuffs\` already batches — it ORs the per-buff changed flags and
  recomputes once. The cost was the redundant recomputes elsewhere, not the
  apply loop. Do not "fix" the batching.
  Guarded by \`api/tests/statCaching.test.mjs\` and the \`fixtures/sim/\`
  golden replays. The candle case \`selfbuff-solo\` in
  \`api/bench/builds.mjs\` exists to keep this path measurable.
- **Dense-index round (performance, measured)** — a third round, aimed at the
  three families a fresh CPU profile of the candle left on top: buff
  aggregation (~16.5% of self time on \`dungeon-den-600\`), the monster stat
  recompute, the event queue (~8.3%) and trigger evaluation (5.7%). The theme
  throughout is replacing string- and closure-keyed lookups with dense integer
  indexing over data we already iterate in bulk. Every stage was measured on
  its own against \`api/bench/records/2026-09-20b-buffpath.json\` at
  \`--reps=9\` and gated on \`npm run sim:check\` 3/3 bit-identical.
    - \`combatUnit.js\` \`_buildBuffBoostIndex\` / \`getBuffBoost\`: the two
      string-keyed \`Map\`s become dense arrays indexed by the generated
      buff-type ordinal, and everything they hold is allocated ONCE per unit
      and reused — pooled per-type boost arrays, pooled per-buff records, and
      one sum object per ordinal overwritten in place, with a rebuild epoch
      invalidating every memoised sum in a single store. A steady-state rebuild
      allocates nothing. The profile put \`_buildBuffBoostIndex\` at 9.39% of
      self time on \`dungeon-den-600\` and \`getBuffBoost\` at 3.28%, the
      largest family in it. The ~35 boost queries \`updateCombatDetails\`
      makes per recompute now use ordinals interned at module load, so the hot
      path hashes no strings at all; \`getBuffBoost(type)\` /
      \`getBuffBoosts(type)\` still take a STRING for callers outside the file
      and intern at the boundary. Candle, stage in isolation:
      \`melee-swarm\` -18.8% cumulative (-4.0 pts on this stage),
      \`melee-solo\` -17.0%, \`dungeon-fort-t2\` -14.4% (-6.4 pts),
      \`tank-solo\` -13.6% (-6.2 pts), \`selfbuff-solo\` -9.1% (-5.8 pts),
      \`dungeon-den-600\` -7.6% (-2.9 pts), \`buffstack-solo\` -5.1%.
      Bit-identical because nothing is reordered: still
      \`Object.values(this.combatBuffs)\` (insertion-ordered, own properties
      only — a \`for...in\` would let a polluted Object.prototype inject
      phantom buffs), records appended per type in the same order, sums
      accumulated in that order from 0, and upstream's \`?? 0\` coercion kept
      verbatim. TWO THINGS TO KNOW IF YOU TOUCH THIS: an hrid outside the
      generated table THROWS — it must, because indexing the dense arrays at
      \`undefined\` would silently drop the buff and report a plausible wrong
      number; and because the arrays and records are pooled, a caller may not
      hold one across a buff change. Both were already shared and read-only by
      contract, no engine path holds across a mutation (a buff change is what
      triggers a recompute, not the other way round), and both properties are
      pinned in \`api/tests/statCaching.test.mjs\`.
      ONE THING MEASURED THE HARD WAY: the per-ordinal sum objects are created
      ON FIRST USE, not all \`BUFF_TYPE_COUNT\` of them when the state is
      allocated. Every unit allocates this state, including the several hundred
      monsters a simulated hour constructs, and minting 67 objects per unit up
      front cost more than the dense index saved on the cheapest candle case —
      \`starter-solo\` went 2.2 -> 2.8 ms/sim-h, a 23% REGRESSION, while every
      other case improved. It reproduced only in a full-candle run, not with
      that case measured alone, which is why the whole candle is worth running
      before believing a stage. Lazy creation put it back to 2.2 with the
      dungeon wins intact. Do not "simplify" it back to an eager loop.
    - \`events/eventTypeIds.js\` (NEW), \`events/combatEvent.js\`,
      \`events/eventQueue.js\`, \`combatSimulator.js\`: every combat event
      now carries an integer \`typeId\` beside its string \`type\`, and the
      queue's hot scans are specialised and closure-free —
      \`clearEventsOfType\`, \`clearEventsForUnit\`,
      \`getMatchingTypeAndSource\`, \`clearMatchingTypeAndSource\`,
      \`getMatchingEitherTypeAndSource\`. Upstream (and our previous round)
      built a closure and called it once per heap entry, and a simulated hour
      visits 2 305 965 entries; the profile put the queue family at ~8.3% of
      self time on \`dungeon-den-600\`. The generic \`clearMatching(fn)\` /
      \`getMatching(fn)\` remain for the cold callers with odd predicates.
      Measured by THREE interleaved A/B rounds at \`--reps=9\`, because the
      effect is smaller than this machine's cross-run drift: the paired
      medians favoured the change in every round on every deep-queue case —
      \`dungeon-den-600\` 107.5 -> 104.0 ms/sim-h, \`dungeon-fort-t2\`
      118.6 -> 117.5, \`melee-swarm\` 12.3 -> 12.1 — and were a wash on the
      solo cases, which is where the queue is shallow and the profile
      predicted nothing. \`sim:check\` 3/3.
      TWO THINGS PRESERVED VERBATIM, both observable: the unit comparisons stay
      \`==\` (callers pass \`event.target\`, which can be null, and
      \`null == undefined\` is TRUE where \`===\` is false — tightening it
      would silently stop clearing events), and matches are still COLLECTED in
      heapArray order and removed afterwards, because \`remove()\` re-heapifies
      in place and the removal order fixes the heap permutation and hence the
      tie-break order among equal-\`time\` events. Type ids are interned on
      first use rather than listed, so no table can go stale when a twentieth
      event type is added; the assignment order is irrelevant because an id is
      only ever compared with another id from the same registry in the same
      process. If an id is ever persisted or compared across runs, it must
      become a sorted generated table instead.
    - \`combatSimulator.js\`: \`processEvent\` is SYNCHRONOUS. Upstream declares it
      \`async\` and \`await\`s it from \`simulate()\`'s loop, but its body contains no
      \`await\` — it was the only one in the engine — so every event allocated a
      throwaway promise and took a microtask-queue round trip for nothing
      (~19 ns per call on this machine, Node v26.8.2). Nothing observable
      changes: microtasks never yielded to the browser's event loop, so the UI
      was not becoming responsive between events, and \`simulate()\` stays
      \`async\` so no caller moves. \`sim:check\` 3/3.
      The gain lands exactly where the theory says it should — on the cases
      whose cost IS per-event overhead, and nowhere else: \`floor-solo\`
      1.17 -> 1.10 ms/sim-h (-6.5%), \`mid-solo\` 4.36 -> 4.15 (-4.9%),
      \`starter-solo\` 2.07 -> 1.99 (-3.8%); \`dungeon-den-600\`, \`melee-solo\` and
      \`melee-swarm\` are a wash, because there the per-event constant is
      swamped by the work inside each event.
      A METHOD WARNING, learned here and applicable to every A/B on this
      branch: the first measurement of this change showed melee-solo +6.1% and
      dungeon-den-600 +1.6%, losing in ALL THREE rounds, and it was an
      artefact. Each round ran base first and the change second, and this
      machine warms within a round, so the second arm was systematically
      penalised. Re-running with the arm order counterbalanced (ABBA) inverted
      both to small wins. Interleaving rounds is NOT sufficient; the ORDER
      WITHIN a round must alternate, or a consistent-looking regression can be
      manufactured out of nothing but thermal drift.
    - \`combatSimulator.js\`: \`checkTriggers()\` and \`addNextAttackEvent()\` no
      longer allocate. Upstream runs \`players.filter(alive).forEach(check)\` and
      the same for enemies — TWO arrays and FOUR closures per fixpoint pass,
      and \`checkTriggers()\` runs after EVERY event — plus
      \`source.abilities.filter(notNull).forEach(...)\` on every attack and
      cooldown wake-up, for at most four slots.
      THE SNAPSHOT IS PRESERVED, and this is the whole subtlety. \`filter\` runs
      its predicate over every element BEFORE \`forEach\` invokes the first
      callback, so membership is decided up front. A plain indexed loop with
      the aliveness test in the body decides it lazily, and the two differ the
      moment a unit's hitpoints cross zero mid-pass: the snapshot still visits
      a unit that has since died — and \`checkTriggersForUnit\` THROWS on a dead
      unit — and skips one that has since been revived. Nothing on today's path
      does either (this method only eats and drinks), but that is not a
      property the next reader can see. So membership is still computed first,
      into a 32-bit liveness MASK. \`addNextAttackEvent\` has no such subtlety:
      its predicate is null-ness, which cannot change mid-loop.
      A MASK RATHER THAN A REUSED ARRAY OF UNITS, and that was measured, not
      assumed. The first version kept two scratch arrays of unit references on
      the simulator; the worry was that writing references into a long-lived
      (promoted) array pays a generational write barrier where the fresh young
      arrays it replaced did not, and that it pins dead monsters against the
      collector. Six counterbalanced rounds at \`--reps=9\` put the two variants
      within noise of each other on every case, so the barrier theory was
      WRONG — but the mask was kept anyway, because it holds no long-lived
      state at all and therefore needs no argument about re-entrancy.
      \`1 << 32\` is \`1\`, not an overflow, so a roster wider than the mask falls
      back to \`_checkTriggersManyUnits()\` — upstream's shape verbatim,
      allocations and all. Nothing in the game fields a roster that wide, which
      makes that path one no simulation ever exercises; it is covered instead
      by \`api/tests/checkTriggers.test.mjs\`, whose wide-roster case is built
      with player 0 DEAD and player 32 ALIVE specifically so that an aliased
      mask is observable. Both that test and the snapshot test were confirmed
      to FAIL against deliberately broken versions before being trusted.
      Measured over four counterbalanced full-candle rounds at \`--reps=5\`:
      18 of 22 medians improved, none regressed consistently —
      \`starter-solo\` 2.03 -> 1.92 (-5.3%), \`floor-party\` 4.81 -> 4.60 (-4.2%),
      \`mid-solo\` 4.69 -> 4.56 (-2.9%), \`melee-swarm\` and \`dungeon-circus\`
      smaller but won every round. \`sim:check\` 3/3.
      HONEST NOTE ON WHERE THIS DID *NOT* PAY. The profile put the trigger
      family at 16.6% of self time on \`dungeon-den-600\` and that case did not
      move (+1.8% over four rounds, +0.6% over a separate six); neither did
      \`party3-sorcerer\`, which the kernel study named as the case this should
      move. The allocation is evidently a small part of that 16.6%; the cost is
      the trigger EVALUATION itself — \`getDependencyValue\` 6.1%,
      \`shouldTrigger\` 4.0%. Anyone returning to this family should attack the
      evaluation, not the iteration, and should know that the iteration has
      already been done.
    TRIED AND DISCARDED alongside it, so nobody re-derives it: dispatching
    \`processEvent\`'s 19-arm switch on the integer \`event.typeId\` (which every
    event already carries for the queue's scans) instead of the string
    \`event.type\`, with the ids interned into module-level constants so the case
    labels are plain reads. Correct, and \`sim:check\` 3/3. But a counterbalanced
    four-round A/B at \`--reps=9\` put SIX of seven cases on both sides of zero —
    \`dungeon-den-600\` +0.9%, \`melee-solo\` +1.2%, \`melee-swarm\` +0.8%,
    \`floor-solo\` +2.6%, \`healer-solo\` -2.1%, \`mid-solo\` +0.5% — with only
    \`starter-solo\` (-4.9%) consistent. The medians straddle zero, so there is
    nothing here to ship.
    The reason is worth keeping: V8 interns the \`type\` strings and lowers a
    string switch to POINTER comparisons, which are already integer compares.
    The kernel study proposed this from a wasm \`br_table\` on a u8 tag
    (a jump table LLVM can build and V8 cannot), and it flagged the ceiling as
    small — \`processEvent\`'s own self time was 1.1% then and does not appear in
    the top 25 of the current profile at all. The int is not cheaper than the
    interned pointer; only the jump table would have been, and that is not
    available to us. Do not re-propose without a measurement that clears noise.
    ALSO TRIED AND DISCARDED, and this one is a HARD no: replacing the N
    \`Heap.remove()\` calls in the queue's clear methods with a single
    compaction pass over \`heapArray\` plus one \`init()\` re-heapify. It is
    less work by construction — \`remove()\` re-heapifies per match and
    \`Heap.remove\` held 2.65% of self time on \`dungeon-den-600\` — but the
    array one compaction produces is NOT the array N successive removals
    produce, so the heap permutation differs and equal-\`time\` events come out
    in a different order. \`npm run sim:check\` caught it immediately: 2 of 3
    fixtures drifted, with ability casts landing in different sequence
    (\`attacks./monsters/abyssal_imp.player1./abilities/fireball\` counts moved).
    The fixtures were NOT re-recorded; the change was reverted. That drift is
    the harness working correctly, and it is the reason the collect-then-remove
    shape in \`clearMatching\` is load-bearing and must stay.
    TRIED AND DISCARDED in this round, so nobody re-derives it: precomputing
    \`trigger.js\`'s derived buff-unique hrid at \`Trigger\` construction
    instead of rebuilding it with \`lastIndexOf\` + \`slice\` +
    concatenation on every evaluation (and replacing the
    \`Object.keys().filter()\` in the prefix branch with a first-match scan).
    The profile made it look worthwhile — \`getDependencyValue\` held 5.73% of
    self time on \`dungeon-den-600\`, and \`checkTriggers()\` runs after every
    event. It is correct and it passed \`sim:check\` 3/3. But FOUR interleaved
    A/B rounds at \`--reps=9\` and \`--reps=15\` could not separate it from
    noise: \`dungeon-den-600\` medians 105.9 ms/sim-h before against 104.7
    after, \`melee-solo\` 8.65 against 8.45, and \`melee-swarm\` and
    \`dungeon-fort-t2\` each landed on the WRONG side in half the rounds. The
    string work is real but it is small beside the trigger evaluation around
    it. Dropped rather than shipped, on the same rule that discarded the
    buff-expiry early-out above. Do not re-propose it without a measurement
    that clears noise.
    - \`generated/buffTypes.js\` (NEW, and ours alone): the buff-type ordinal
      table the dense buff-boost index below is keyed on — \`BUFF_TYPE\`
      (hrid -> ordinal, null-prototype), \`BUFF_TYPE_NAMES\`,
      \`BUFF_TYPE_COUNT\` and \`buffTypeOrdinal()\`, which THROWS on an hrid
      it has never seen. It is produced by \`tools/genBuffTypes.mjs\` and
      COMMITTED, so webpack and the node harness import the identical file and
      a game-data update lands as a reviewable diff. It is derived, not typed,
      because a list that is wrong by omission gives wrong combat numbers with
      no error — the same failure that once dropped \`hpRegenPer10\` and
      \`mpRegenPer10\` from a stat list and moved kills/hr by 2%. The JSON
      maps are walked STRUCTURALLY (no character class to get wrong) and the
      text scans use \`[A-Za-z0-9_]+\` with digits asserted, not eyeballed, in
      \`api/tests/buffTypes.test.mjs\` — which also re-runs the generator and
      compares the committed file BYTE FOR BYTE. Ordinals come from a sort, not
      from discovery order. If upstream adds a buff type, regenerate; do not
      hand-edit the generated file.
    - \`monster.js\` \`updateCombatDetails()\`: the base stat-block copy no
      longer runs \`Object.entries(gameMonster.combatDetails.combatStats)\`,
      which allocated an outer array plus one two-element array per stat, per
      monster, per encounter — and a simulated hour holds 200-800 encounters,
      each resetting and so recomputing every monster in it. The profile put
      that one loop at 5.7% of self time on \`melee-solo\`, 6.3% on
      \`buffstack-solo\`, 4.2% on \`dungeon-den-600\`. It now walks cached
      flat key and value arrays: same keys in \`Object.keys\` order, same
      values, same write sequence, so no number can move. Candle:
      \`melee-solo\` -15.8%, \`melee-swarm\` -15.2%, \`dungeon-fort-t2\`
      -8.5%, \`tank-solo\` -7.4%, \`buffstack-solo\` -2.7%,
      \`selfbuff-solo\` -2.3%, \`dungeon-den-600\` -2.0%; no case regressed.
      The cache is keyed on the combatStats OBJECT (a \`WeakMap\`), NOT on the
      monster hrid, because \`dataProvider.setOverrides()\` can replace the
      whole monster map at runtime and installs fresh nested objects; an
      hrid-keyed cache would then serve a previous game version's stats with no
      error at all.
- Any other local edits beneath \`${SCOPED_PATH}/\` — list them in the
  rebase report so we keep a running ledger.

- **Per-unit pending-action count (performance, measured)** — a fourth round,
  aimed for the first time at a cost that SCALES WITH UNIT COUNT rather than a
  large share of a profile. The framing came from converting the candle to cost
  per ENCOUNTER and holding the zone fixed while varying only party size (the
  one such pair is aqua_planet, 1 player against 3): our fixed per-encounter
  cost is within 30% of the reference implementation's, while our cost per
  ADDITIONAL UNIT is roughly eight times it. A change that removes fixed
  per-encounter or per-pass work therefore cannot move a dungeon, whatever the
  profile says — which is exactly what happened to the trigger round above.
    - \`events/eventQueue.js\`, \`combatUnit.js\`, \`combatSimulator.js\`:
      \`addNextAttackEvent()\` opens by asking whether the unit already has an
      \`AutoAttackEvent\` or \`AbilityCastEndEvent\` in flight, and upstream
      answers it by SCANNING THE WHOLE HEAP
      (\`getMatchingEitherTypeAndSource\`). Instrumented on
      \`dungeon-den-600\`: 10 249 calls per simulated hour over a heap
      averaging 111 entries — **56.5% of every heap entry the queue touches**,
      and 81.8% of them on \`floor-solo\`. It is quadratic in party size,
      because more units means both more calls and a longer heap. The queue now
      maintains a count on the unit instead: \`_pendingActionCount\`,
      incremented on push and decremented on pop, on removal and on clear, with
      \`hasPendingAction(source)\` reading the field.
      THE EQUIVALENCE ARGUMENT, which is the whole of the risk. The scan's
      answer is a pure function of the heap's contents, so a maintained count
      agrees with it if and only if EVERY mutation maintains it. The heap is
      mutated in exactly four places and all four are in \`eventQueue.js\` —
      \`addEvent\`, \`getNextEvent\`, \`clear\`, and \`_removeCollected\`,
      which every cancellation path funnels through; every other method only
      READS \`heapArray\`. That is why the count is maintained beside the
      mutations rather than at the call site that consumes it. If a fifth
      mutation site is ever added and skips it, this silently returns wrong
      answers: a unit stuck above zero never attacks again, one stuck below
      queues two actions at once. Neither throws. \`clear()\` therefore walks
      the outgoing heap and settles every count before dropping it, because the
      counts live on units that outlive the queue's contents.
      A FIELD, NOT A MAP, AND THAT WAS MEASURED. The first version kept a
      \`Map\` from unit to count inside the queue. It won the dungeons but LOST
      the cheap cases in every counterbalanced round — \`floor-solo\` +9.3%,
      \`floor-party\` +6.9%, \`buffstack-solo\` +1.1% — because a shallow heap
      (3.9 entries on \`floor-solo\`) is cheaper to scan than two \`Map\`
      operations are to perform, and the \`Map\` was touched on every add and
      every removal while the scan only ran on the guard. Moving the count onto
      the unit turned all three into wins. It also puts the state where it
      belongs: "am I mid-action?" is a property of the unit, which is precisely
      how the reference implementation avoids the question — it stamps
      last-used at cast START, so "mid-cast" and "on cooldown" are the same
      scalar on its ability record, and it never asks its queue anything.
      Measured over four counterbalanced full-candle rounds at \`--reps=5\`:
      20 of 22 medians improved, 11 won every round, NONE lost every round —
      \`mid-solo\` 4.57 -> 3.65 (-20.1%), \`dungeon-den-200\` 105.4 -> 96.0
      (-8.9%), \`melee-swarm\` -7.8%, \`melee-abyss\` -7.7%, \`magic-abyss-t3\`
      -7.4%, \`party3-swarm\` -6.7%, \`dungeon-fort-t2\` -5.7%,
      \`dungeon-den-600\` 104.2 -> 99.0 (-5.1%), \`dungeon-circus\` -4.4%,
      \`dungeon-pirate\` -3.7%. This is the first stage that moved every
      dungeon, and it is the first one aimed at per-unit cost. \`sim:check\`
      3/3; \`enc/h\` within 1.2% everywhere.
      \`floor-solo\` read +5.8% in that run, so it was re-measured on its own
      terms — six counterbalanced rounds at \`--reps=9\` — and came back +1.2%
      with three rounds either way, i.e. noise; \`starter-solo\` -3.7% (won all
      six), \`floor-party\` -2.0%, \`ranged-solo\` -1.1% in the same run. No
      regression survived, so nothing was reverted.
      COVERED BY \`api/tests/pendingAction.test.mjs\` (NEW), whose central case
      is DIFFERENTIAL: 4 000 randomised mutations from a seeded LCG, asserting
      after every single one that the count agrees with
      \`getMatchingEitherTypeAndSource\` — which is kept in the class, off the
      hot path, precisely to be that oracle. Four mutants were confirmed to
      fail it before it was trusted: dropping the decrement in
      \`_removeCollected\`, dropping it on pop, forgetting the reset in
      \`clear()\`, and tracking only auto-attacks. The suite also pins the
      subtle one — an event removed by TARGET must still decrement its
      SOURCE's count.
      AN ENVIRONMENT TRAP FOUND WHILE MEASURING, recorded because it cost time
      and will cost it again: the repository ROOT \`node_modules\` carries
      heap-js 2.2.0 while \`api/node_modules\` carries the pinned 2.7.1. A
      worktree without its own \`api/node_modules\` resolves upward to 2.2.0
      and every bench case dies with "Heap is not a constructor". Symlink
      \`api/node_modules\` into any worktree used as an A/B arm. This is the
      failure mode the pin and the constructor assertion in \`eventQueue.js\`
      exist to make loud, and it worked.

- **Batched multi-buff ability effects (performance, measured)** — an ability
  effect carrying N buffs paid N boost-index rebuilds and N FULL stat
  recomputes, because \`addBuff\` recomputes per call.
  \`elemental_affinity\` (3 buffs, 20 s duration, 30 s cooldown) is the case
  users notice; \`toughness\` (4 buffs, same cycle) is worse, and
  \`guardian_aura\` carries 6.
    - \`combatSimulator.js\`: \`processAbilityBuffEffect\`'s \`self\` branch and
      \`processAbilityDamageEffect\`'s on-hit branch call
      \`addBuffs(abilityEffect.buffs, ...)\` once instead of \`addBuff\` per
      buff, with the expiry events queued in their own loop afterwards — same
      events, same order, same times, so the heap sequence is unchanged.
      Bit-identical because \`_applyBuff\` reads nothing derived (only
      \`buffInstances\`, the incoming buff, and the clock) and the recompute
      RESETS to base and re-adds every active buff, so running it once after
      all N is the same arithmetic as running it after each. \`addBuffs\` was
      already in the file for exactly this; nothing in the engine was calling
      it with more than one buff.
      \`combatUnit.js\`: \`addBuff\` no longer wraps its argument in a
      throwaway one-element array to call \`addBuffs\`; it inlines the same two
      statements.
      NOT DONE, deliberately: the \`allAllies\` branch. Its special-ability
      multiplier reads \`source.combatDetails\` INSIDE the per-buff loop, so
      when the caster is one of its own allies a recompute between buffs can
      move the level it reads and change the later buffs' magnitudes. Batching
      it requires proving no self-targeted \`allAllies\` special ability
      multiplies against a level stat. Nobody has.
      Measured over four counterbalanced full-candle rounds at \`--reps=5\`:
      14 of 22 medians improved, 10 won every round, NONE lost every round —
      \`selfbuff-solo\` 12.54 -> 10.36 (-17.4%), \`tank-solo\` -9.8%,
      \`magic-solo\` -7.8%, \`dungeon-pirate\` -7.7%, \`dungeon-den-200\`
      -7.0%, \`dungeon-fort-t2\` -6.3%, \`dungeon-den-600\` 100.8 -> 94.5
      (-6.3%), \`party3-sorcerer\` -5.1%. \`sim:check\` 3/3.
      \`floor-solo\` (+1.9%) and \`floor-party\` (+2.2%) read as small
      regressions over six focused counterbalanced rounds at \`--reps=9\`, and
      they are NOISE BY CONSTRUCTION: instrumenting the two batched call sites
      shows both cases execute them ZERO times (the \`bare\` build has no
      abilities, and nothing else reaches them). Recorded because "mixed-sign
      and small" was not a good enough answer, and counting the executions was
      cheaper than arguing about it.
    TRIED AND PROVEN UNSAFE in this round, and this one is a HARD no: skipping
    the PROLOGUE of \`Player.updateCombatDetails\` /
    \`Monster.updateCombatDetails\` when only buffs changed. The prologue looks
    like dead weight — \`Player\` re-copies 76 equipment stats from a cache and
    \`Monster\` re-derives its whole flat stat block, and both are pure
    functions of data that is immutable for the run, together 12.3% of self
    time on \`dungeon-den-600\`. IT IS NOT A REDUNDANT COPY. It is the RESET
    that makes the shared suffix correct: \`CombatUnit.updateCombatDetails\`
    mutates \`combatStats\` IN PLACE with \`+=\` throughout — amplifies, crit
    rate and damage, life steal, thorns, threat, tenacity, drop rate, cast
    speed, and the player's \`hpRegenPer10\`/\`mpRegenPer10\` — adding each
    buff's contribution ONTO the base value, and \`Monster\` likewise does
    \`armor *= labyrinthScaleFactor\` after its copy. Skip the reset and every
    recompute compounds the last one's boosts, at roughly 0.9 recomputes per
    event. A crude version was tried and \`npm run sim:check\` caught it at
    once: 2 of 3 fixtures drifted. Do not re-propose "the prologue is a pure
    copy, cache it" — it is, and that is exactly why it cannot be skipped. A
    safe variant would have to restore ONLY the fields the suffix clobbers,
    which means auditing every \`+=\` in a 270-line method, and getting it
    wrong is a wrong combat number with no error.

- **The \`isOutOfMana\` note, and two negative results (no code behaviour
  changed)** — \`combatSimulator.js\` only. The flag is MISNAMED and three
  comments were actively wrong about it, so the note above
  \`processRegenTickEvent\` now records what it means: its only writer sets it
  when a BLINDED unit failed to queue an ability and therefore scheduled
  nothing, i.e. "parked with an empty queue". Real out-of-mana accounting is
  \`canUseAbility\` -> \`addRanOutOfManaCount\`, unrelated. The three
  \`awaitCooldownEvent\` sites it guards build the event at
  \`this.simulationTime\` — no delay at all, so despite the name it awaits
  nothing and is a deferred \`addNextAttackEvent\`. Instrumented over five
  simulated hours each of \`dungeon-den-600\`, \`buffstack-solo\` and
  \`floor-solo\`: created ZERO times, because no blind lands in those zones.
  DELIBERATELY NOT DELETED — a zone with a \`blindChance\` ability does reach
  it, and removing it would change behaviour there with no fixture to catch it.
    A REAL AND SLIGHTLY ABSURD FINDING, which is why the note sits BETWEEN
    methods and not inside them: V8's inlining budget is measured in SOURCE
    CHARACTERS, comments included. Three copies of that note inside
    \`processConsumableTickEvent\`, \`processRegenTickEvent\` and
    \`tryUseConsumable\`, plus four comment lines inside \`addNextAttackEvent\`,
    cost \`starter-solo\` +3.7% over six counterbalanced rounds at
    \`--reps=9\` — a regression that survived re-measurement at the same sign
    and magnitude as the full-candle run, on a case that executes none of the
    changed code. Hoisting the identical text out of the function bodies took
    it to -1.3%. If you are about to add a long comment inside a hot method,
    put it above the method instead.
    TRIED AND DISCARDED, on the noise rule: fusing the six buff-refresh
    \`getMatchingTypeAndSource\` + \`clearMatchingTypeAndSource\` pairs (curse,
    fury, weaken, twice each) into one \`takeMatchingTypeAndSource\` walk that
    removes every match and returns the first. Correct, strictly less work, and
    \`sim:check\` 3/3 — the pair was 25.0% of every heap entry the queue
    touched on \`dungeon-den-600\`, and the fused form ran 15 485 times per
    simulated hour there. But the effect is at this machine's noise floor and
    TWO measurements contradicted each other: a four-round counterbalanced full
    candle at \`--reps=5\` gave 18 of 22 improved with \`dungeon-fort-t2\`
    -1.0%, while a six-round counterbalanced run at \`--reps=9\` over only the
    five cases that execute it gave \`dungeon-fort-t2\` +2.8% losing ALL SIX
    rounds and \`dungeon-circus\` +2.4%. Reverted rather than tuned, per the
    rule. Anyone re-proposing it needs a measurement that clears noise; the
    implementation is straightforward and the parity argument is sound (both
    scans walk \`heapArray\` from 0, so the first match is the same object, and
    collect-then-remove keeps the heap permutation).
    ALSO INVESTIGATED AND FOUND NOT TO BE WASTE, so nobody "fixes" it: the
    \`enrageTick\` event is cleared and re-added once per encounter (530 times
    an hour) and NEVER dispatched, and \`curseExpiration\` is created 1 798
    times an hour and dispatched none. Both are correct. \`ENRAGE_TICK_INTERVAL\`
    is 60 s while a \`dungeon-den-600\` encounter lasts under 7 s, and curse is
    refreshed on every hit inside its 15 s window. "Created and never
    dispatched" is what a refresh-on-hit debuff and a long-interval tick look
    like in a fight that ends first — not a bug.

NOTE: the labyrinth "maze" player-buff mechanism (\`options.maze\`,
\`MAZE_DEFAULTS\`, \`resolveMazeBonuses\`, \`mazeBonuses\`,
\`Player.applyMazeBonuses\`) was REMOVED deliberately — it double-counted the
labyrinth crate buffs, which are now the single source of truth. The
rationale is preserved at \`combatSimulator.js:44-51\`. Do NOT reintroduce it.
(\`player.js\` used to be byte-identical to upstream and is cited as such in
older reports; it no longer is — see the hot-path caches entry above.)

## How to read the patch — polarity matters

The patch is \`diff -ruN <ours> <upstream>\`, i.e. it reads **ours → upstream**:

- **\`+\` lines are UPSTREAM content we do not have** — these are the candidate
  changes to pull in.
- **\`-\` lines are OUR local adaptations that upstream lacks** — preserve them.
  They are what populates the "still-not-upstreamed local edits" ledger.
- Files marked \`Only in <ours>\` are our own additions; files marked
  \`Only in <upstream>\` are new upstream files to vendor in.

**Never apply this patch wholesale** — doing so would revert every adaptation
listed above. Reconcile hunk by hunk: adopt the \`+\` side where it is genuinely
new upstream work, and keep the \`-\` side where it is ours.

Expect many \`+\` lines that are NOT new upstream work: wherever we replaced
upstream code, the diff necessarily shows upstream's original on the \`+\` side
and our replacement on the \`-\` side. Cross-check every \`+\` hunk against the
adaptation ledger above before adopting it — if the \`+\` side is just the
pre-adaptation version of something we deliberately rewrote, keep ours. Genuine
upstream work is a \`+\` hunk that matches no adaptation and has no \`-\`
counterpart implementing the same thing.

If every \`+\` hunk turns out to be a pre-adaptation original, we are already
current with upstream and there is nothing to apply — say so plainly rather than
inventing changes.

## What to do

1. Read \`.upstream/diff.patch\` (also referenced inline below).
2. Apply the upstream (\`+\`) changes to our files under \`${SCOPED_PATH}/\`,
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
