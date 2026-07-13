import Monster from "./monster";
import { guildTrialDetailMap } from "./dataProvider";

// =============================================================================
// GuildTrial — a climbing-ladder combat mode, sibling of Zone / Labyrinth.
// -----------------------------------------------------------------------------
// A guild trial pits the roster against a fixed encounter (from
// guildTrialDetailMap[trialHrid].monsterHrids) that is re-fought at ever-higher
// tiers. Each tier maps DIRECTLY to a labyrinth-style monster room level, so
// tier scaling reuses Monster's existing roomLevel/100 scale factor. Clearing a
// tier advances +10 levels; the run ends on the FIRST of: party wipe, 1 hour of
// SIMULATED time, or clearing the cap tier (300). The trial is a single weekly
// attempt with NO re-clear of any tier — once 300 is cleared there is nothing
// further to fight and the run COMPLETES (endReason "completed").
//
// Confirmed rules (Guild Expansion patch, see GUILD-TRIALS.md):
//   - Start tier 100, +10 per clear, cap 300; clearing 300 ends the run.
//   - Monster max HP × (1 + 0.01 × participantCount) — HP only, no dmg scaling.
//   - No per-encounter timer, no enrage, no consumables.
//   - Food/drinks are replaced by a flat +3% HP and MP regen (see below).
//   - Dead players stay dead (revive is the only way back); players keep HP/MP,
//     buffs and cooldowns between tiers (dungeon-wave-like continuation).
// The engine (CombatSimulator) owns those combat-loop behaviours; this class
// owns encounter composition and ladder state.
// =============================================================================
class GuildTrial {
    static START_TIER = 100;
    static TIER_STEP = 10;
    static MAX_TIER = 300;

    // Hard stop: 1 hour of simulated trial time.
    static TRIAL_DURATION_NS = 3600 * 1e9;

    // Official Guild-Expansion rule: in a trial, food & drinks are disabled and
    // replaced by a built-in FLAT +3% HP and +3% MP regeneration, added on top
    // of the unit's own regen on each 10 s regen tick. Named + overridable via
    // the trial `options` so a future balance change is a one-line tweak.
    static DEFAULT_BONUS_HP_REGEN_RATIO = 0.03; // TRIAL_BONUS_HP_REGEN_RATIO
    static DEFAULT_BONUS_MP_REGEN_RATIO = 0.03; // TRIAL_BONUS_MP_REGEN_RATIO

    // enemyScale debug-knob clamp bounds (see constructor doc).
    static MIN_ENEMY_SCALE = 0.05;
    static MAX_ENEMY_SCALE = 5;

    /**
     * @param {string} trialHrid   e.g. "/guild_combat/badger"
     * @param {number} startTier   starting room level (default 100)
     * @param {number} participantCount  drives the +1% HP scaling; the engine
     *   defaults it to players.length but any caller may override it.
     * @param {object} options     { bonusHpRegenRatio?, bonusMpRegenRatio?,
     *   enemyScale? }. enemyScale (default 1.0, clamped 0.05..5) is a DEBUG
     *   knob that weakens/strengthens the monsters by scaling their EFFECTIVE
     *   level on the roomLevel axis: effectiveRoomLevel = max(1, round(tier ×
     *   enemyScale)) — so 0.8 makes a tier-100 encounter fight like level 80
     *   in every respect (HP, damage, accuracy, armor, ability levels).
     *   Participant HP scaling applies on top, unchanged. The ladder, rewards
     *   and all reporting still use the TRUE tier.
     */
    constructor(trialHrid, startTier = GuildTrial.START_TIER, participantCount = 1, options = {}) {
        this.trialHrid = trialHrid;

        const detail = guildTrialDetailMap[trialHrid];
        if (!detail) {
            throw new Error("No guild trial found for hrid: " + trialHrid);
        }
        if (!detail.monsterHrids || detail.monsterHrids.length === 0) {
            throw new Error("Guild trial has no monsters (skilling trial?): " + trialHrid);
        }
        this.name = detail.name;
        this.monsterHrids = detail.monsterHrids;

        this.startTier = startTier;
        this.participantCount = participantCount;
        // +1% monster HP per participant (HP only). Confirmed official.
        this.hpScaleFactor = 1 + 0.01 * participantCount;

        this.bonusHpRegenRatio =
            options.bonusHpRegenRatio ?? GuildTrial.DEFAULT_BONUS_HP_REGEN_RATIO;
        this.bonusMpRegenRatio =
            options.bonusMpRegenRatio ?? GuildTrial.DEFAULT_BONUS_MP_REGEN_RATIO;

        // Debug knob: monsters' effective-level multiplier (see class doc).
        // Non-numeric / non-positive input falls back to 1 (no scaling).
        const rawEnemyScale = Number(options.enemyScale);
        this.enemyScale = Number.isFinite(rawEnemyScale) && rawEnemyScale > 0
            ? Math.min(GuildTrial.MAX_ENEMY_SCALE, Math.max(GuildTrial.MIN_ENEMY_SCALE, rawEnemyScale))
            : 1;

        // Ladder state. Each tier is fought at most once (the run completes on
        // clearing the cap), so tiersCleared === distinct tiers cleared.
        this.currentTier = startTier;
        this.tiersCleared = 0;
        this.encounterCount = 0;
    }

    /**
     * Build the current tier's encounter. Each monster spawns with
     * difficultyTier 0 and roomLevel = the tier's EFFECTIVE level (true tier ×
     * enemyScale; identical to the true tier at the default enemyScale of 1),
     * and is tagged with the participant HP scale factor so
     * Monster.updateCombatDetails grows its max HP on top.
     * @returns {Monster[]}
     */
    getEncounter() {
        this.encounterCount++;
        const effectiveRoomLevel = Math.max(1, Math.round(this.currentTier * this.enemyScale));
        return this.monsterHrids.map((hrid) => {
            const monster = new Monster(hrid, 0, effectiveRoomLevel);
            monster.trialHpScaleFactor = this.hpScaleFactor;
            return monster;
        });
    }

    /**
     * Record a tier clear and step the ladder (+10). The Math.min cap is
     * defensive only — the engine ends the run the moment MAX_TIER is cleared
     * (endReason "completed"), so currentTier never actually advances past it.
     */
    advanceTier() {
        this.tiersCleared++;
        this.currentTier = Math.min(this.currentTier + GuildTrial.TIER_STEP, GuildTrial.MAX_TIER);
    }

    /**
     * Highest tier LEVEL fully cleared this run (0 if none). Because the ladder
     * is strictly monotonic, "tier T cleared" ⇔ maxTierCleared >= T, which is
     * what the aggregate per-tier clear-probability relies on.
     */
    get maxTierCleared() {
        if (this.tiersCleared <= 0) return 0;
        return Math.min(
            this.startTier + (this.tiersCleared - 1) * GuildTrial.TIER_STEP,
            GuildTrial.MAX_TIER
        );
    }
}

export default GuildTrial;
