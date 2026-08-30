// =============================================================================
// simSettings — MWIX adaptation: a small, module-level bag of EXPERIMENTAL
// engine knobs.
//
// Why a module singleton rather than options threaded through the constructor:
// the things we want to A/B are buried deep in the unit/ability layer
// (CombatUnit.resetCooldowns, and whatever comes next), and every caller —
// worker.js, multiWorker.js shards, the All Zones sweep, the Express API —
// already goes through one entry point per worker. Each worker is a fresh
// module instance, so applying the settings once at the top of an `onmessage`
// is both sufficient and leak-free.
//
// A knob left untouched must simulate the model we believe to be TRUE — which
// is not always upstream's. Where we depart from upstream, the comment on the
// knob carries the measurement that justifies it.
// =============================================================================

// --- monsterStartCooldown ----------------------------------------------------
// What fraction of an ability's cooldown a monster still has to wait when the
// fight begins.
//
//   "auto"   (default)  labyrinth → "half", everything else → "random"
//   "random" (upstream) remaining ~ U[0.5*CD, 1.0*CD)   → mean 0.75*CD
//   "half"   (measured) remaining  = 0.5*CD exactly     → mean 0.50*CD
//
// The split is measured, not assumed. Two websocket captures of live play were
// fitted REFERENCE-FREE: if every ability in an encounter owes the same
// fraction f of its cooldown, then availableTime is a straight line in
// cooldownDuration, so the fitted slope IS f and no clock is needed (which
// matters — the zone captures carry a stale combatStartTime).
//
//   2026-08-29, 86 labyrinth rooms   slope 0.5000, residual 0.000s
//   2026-08-28, 270 zone encounters  slope 0.7484, residual ~2s (real scatter)
//
// 0.7484 is the signature of a uniform draw on [0.5, 1.0) — mean 0.75 — so
// upstream's model is CORRECT for ordinary zone and dungeon combat, where
// monsters spawn into a fight already in progress. A labyrinth room begins
// from a standing start and is dealt a flat half, every time.
//
// Hence "auto": each context gets the model that matches it. Forcing "random"
// or "half" globally remains available for A/B work, but neither is right
// everywhere. (The other public fork of this simulator — combat.43.167.210.211
// — inherited upstream's unconditional random draw and makes no distinction;
// two forks agreeing tells us only that neither has looked.)
export const MONSTER_START_COOLDOWN_MODES = ["auto", "random", "half"];

const DEFAULTS = Object.freeze({
    monsterStartCooldown: "auto",
});

let settings = { ...DEFAULTS };

// Which kind of encounter is being simulated: "labyrinth" or "zone" (the
// latter covering zones, dungeons and guild trials — everything that is not a
// labyrinth room). Set by CombatSimulator, read only by the "auto" mode.
let encounterContext = "zone";

export function getSimSettings() {
    return settings;
}

export function resetSimSettings() {
    settings = { ...DEFAULTS };
    encounterContext = "zone";
}

export function setEncounterContext(context) {
    encounterContext = context === "labyrinth" ? "labyrinth" : "zone";
}

export function getEncounterContext() {
    return encounterContext;
}

// The resolved model for the encounter currently being simulated: "half" or
// "random". This — not the raw setting — is what the engine should branch on.
export function resolveMonsterStartCooldown() {
    const mode = settings.monsterStartCooldown;
    if (mode === "half" || mode === "random") {
        return mode;
    }
    return encounterContext === "labyrinth" ? "half" : "random";
}

// Apply a partial settings patch, ignoring unknown keys and invalid values so a
// stale UI (or an old saved session) can never wedge the engine.
export function applySimSettings(patch) {
    if (!patch || typeof patch !== "object") {
        return settings;
    }
    if (MONSTER_START_COOLDOWN_MODES.includes(patch.monsterStartCooldown)) {
        settings.monsterStartCooldown = patch.monsterStartCooldown;
    }
    return settings;
}

// Convenience for callers holding a worker `extra` payload: the experimental
// knobs travel as `extra.experimental` so they never collide with the buff
// fields worker.js already reads.
export function applySimSettingsFromExtra(extra) {
    resetSimSettings();
    return applySimSettings(extra?.experimental);
}
