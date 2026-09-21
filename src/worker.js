import CombatSimulator from "./combatsimulator/combatSimulator";
import Player from "./combatsimulator/player";
import Zone from "./combatsimulator/zone";
import Labyrinth from "./combatsimulator/labyrinth";
import GuildTrial from "./combatsimulator/guildTrial";
import { extractTrialSummary } from "./combatsimulator/guildTrialStats";
import { applySimSettingsFromExtra } from "./combatsimulator/simSettings";
import { resolveSealBuffs } from "../shared/personalBuffs.js";

// Build the community / pass / personal-seal buffs shared by every sim mode.
// (Labyrinth shop upgrades are appended separately by the labyrinth path only;
// guild trials append guild shrine buffs instead — see the guildTrial case.)
function buildCommunityBuffs(extra = {}) {
    let extraBuffs = [];
    if (extra.mooPass) {
        extraBuffs.push({
            "uniqueHrid": "/buff_uniques/experience_moo_pass_buff",
            "typeHrid": "/buff_types/wisdom",
            "ratioBoost": 0,
            "ratioBoostLevelBonus": 0,
            "flatBoost": 0.05,
            "flatBoostLevelBonus": 0,
            "startTime": "0001-01-01T00:00:00Z",
            "duration": 0
        });
    }
    if (extra.comExp > 0) {
        extraBuffs.push({
            "uniqueHrid": "/buff_uniques/experience_community_buff",
            "typeHrid": "/buff_types/wisdom",
            "ratioBoost": 0,
            "ratioBoostLevelBonus": 0,
            "flatBoost": 0.005 * (extra.comExp - 1) + 0.2,
            "flatBoostLevelBonus": 0,
            "startTime": "0001-01-01T00:00:00Z",
            "duration": 0
        });
    }
    if (extra.comDrop > 0) {
        extraBuffs.push({
            "uniqueHrid": "/buff_uniques/combat_community_buff",
            "typeHrid": "/buff_types/combat_drop_quantity",
            "ratioBoost": 0,
            "ratioBoostLevelBonus": 0,
            "flatBoost": 0.005 * (extra.comDrop - 1) + 0.2,
            "flatBoostLevelBonus": 0,
            "startTime": "0001-01-01T00:00:00Z",
            "duration": 0
        });
    }
    // Seals are a per-CHARACTER item, so the new Vite UI resolves them per
    // player and folds them into each DTO's own `extraBuffs`; it sends
    // `extra.personalBuffs` empty. This branch therefore exists for the LEGACY
    // webpack UI (src/main.js), which has only one party-wide seal control and
    // no per-player state to hang them off. Both read the same definitions
    // (shared/personalBuffs.js), so the two UIs cannot disagree about what a
    // seal is worth.
    if (extra.personalBuffs) {
        extraBuffs = extraBuffs.concat(resolveSealBuffs(extra.personalBuffs));
    }
    return extraBuffs;
}

// MWIX adaptation: labyrinth shop-upgrade extraBuffs (labyrinth-only). Mirrors
// tampermonkey/src/modules/labyrinth-sim/index.js's LAB_UPGRADE_DEFS. The four
// buffs (combat damage / attack speed / cast speed / critical rate, +1%/level)
// are permanent character upgrades from the labyrinth shop and apply ONLY in
// the labyrinth. Gated on `mwixMaze.enabled`, the "labyrinth run" toggle.
function buildLabUpgradeBuffs(extra = {}) {
    let extraBuffs = [];
    if (extra && extra.mwixLabUpgrades && extra.mwixMaze && extra.mwixMaze.enabled) {
        const u = extra.mwixLabUpgrades;
        const LAB_UPGRADE_RATIO_STEP = 0.01;
        function pushLabBuff(level, key, typeHrid, valueKey) {
            const lv = Math.max(0, Math.floor(Number(level) || 0));
            if (lv <= 0) return;
            extraBuffs.push({
                uniqueHrid: `/buff_uniques/labyrinth_upgrade_${key}`,
                typeHrid,
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                [valueKey]: lv * LAB_UPGRADE_RATIO_STEP,
                startTime: "0001-01-01T00:00:00Z",
                duration: 0,
            });
        }
        pushLabBuff(u.combatDamage, "combat_damage", "/buff_types/damage",        "ratioBoost");
        pushLabBuff(u.attackSpeed,  "attack_speed",  "/buff_types/attack_speed",  "ratioBoost");
        pushLabBuff(u.castSpeed,    "cast_speed",    "/buff_types/cast_speed",    "flatBoost");
        pushLabBuff(u.criticalRate, "critical_rate", "/buff_types/critical_rate", "flatBoost");
    }
    return extraBuffs;
}

onmessage = async function (event) {
    switch (event.data.type) {
        case "start_simulation": {
            // MWIX adaptation: experimental engine knobs (extra.experimental)
            // are module-level, so they are applied once per job — a fresh
            // worker per run means no state can bleed between simulations.
            applySimSettingsFromExtra(event.data.extra);
            // MWIX adaptation (guild expansion, 7/13/2026): guild SHRINE buffs are
            // permanent character buffs — the server exposes them in
            // `guildActionTypeBuffsMap["/action_types/combat"]`, which applies to
            // every fight, not just guild trials.
            //
            // WHERE THEY ARRIVE FROM has since changed. Shrines are bought per
            // MEMBER, so the Vite UI resolves them (and seals) per player and
            // hangs them off each DTO; from that UI `event.data.guildBuffs` is
            // always empty and the real work happens in the concat below. The
            // array is still read because the LEGACY webpack UI (src/main.js)
            // has only party-wide knobs and still fills it. Either way the
            // objects arrive pre-resolved, level already folded in, from
            // ui/src/utils/guildBuffs.js.
            //
            // NOTE: guild BUILDING buffs are deliberately NOT included on this
            // path — those apply to guild trials only (see "start_guild_trial").
            let extraBuffs = buildCommunityBuffs(event.data.extra || {});
            extraBuffs = extraBuffs.concat(buildLabUpgradeBuffs(event.data.extra || {}));
            extraBuffs = extraBuffs.concat(event.data.guildBuffs || []);

            let playersData = event.data.players;
            let players = [];
            let zone = null;
            if (event.data.zone) {
                zone = new Zone(event.data.zone.zoneHrid, event.data.zone.difficultyTier);
            }
            let labyrinth = null;
            if (event.data.labyrinth) {
                labyrinth = new Labyrinth(event.data.labyrinth.labyrinthHrid, event.data.labyrinth.roomLevel, event.data.labyrinth.crates);
            }
            for (let i = 0; i < playersData.length; i++) {
                let currentPlayer = Player.createFromDTO(structuredClone(playersData[i]));
                currentPlayer.zoneBuffs = zone?.buffs || labyrinth?.buffs || [];
                // Party-wide buffs first, this unit's own tail after. Shrines
                // are bought per member and seals are equipped per character,
                // so both are properties of the UNIT: the UI resolves them per
                // player and hangs them off the DTO, exactly as the trial path
                // has done since 2026-09-18. `Player.createFromDTO` ignores the
                // field, so it reaches this line only via the DTO object
                // itself; a DTO without it yields the old behaviour exactly.
                currentPlayer.extraBuffs = extraBuffs.concat(playersData[i].extraBuffs || []);
                players.push(currentPlayer);
            }
            let simulationTimeLimit = event.data.simulationTimeLimit;
            let enableHpMpVisualization = event.data.extra.enableHpMpVisualization || false;
            const simOpts = { enableHpMpVisualization };
            let combatSimulator = new CombatSimulator(players, zone, labyrinth, simOpts);
            combatSimulator.addEventListener("progress", (event) => {
                this.postMessage({
                    type: "simulation_progress",
                    progress: event.detail.progress,
                    zone: event.detail.zone,
                    difficultyTier: event.detail.difficultyTier,
                    labyrinth: event.detail.labyrinth,
                    roomLevel: event.detail.roomLevel,
                    timeSeriesData: event.detail.timeSeriesData
                });
            });

            try {
                let simResult = await combatSimulator.simulate(simulationTimeLimit);
                this.postMessage({ type: "simulation_result", simResult: simResult });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
        case "start_guild_trial": {
            // Guild trial shard. Runs `iterations` full trial runs and returns a
            // lightweight per-iteration summary array (aggregated by multiWorker
            // / the API). Payload:
            //   { players[], guildTrial: { trialHrid, startTier, participantCount,
            //     trialOptions }, guildBuffs[], extra, iterations }
            // trialOptions: { bonusHpRegenRatio?, bonusMpRegenRatio?, enemyScale? }
            // — forwarded wholesale to GuildTrial (enemyScale is the debug knob
            // that scales the monsters' effective level; ladder/reporting keep
            // the true tier).
            const cfg = event.data.guildTrial || {};
            const iterations = event.data.iterations || 1;
            const guildBuffs = event.data.guildBuffs || [];
            const playersData = event.data.players;

            applySimSettingsFromExtra(event.data.extra);

            // Buffs that apply in trials: community / seals + guild shrine buffs.
            // Labyrinth crates & lab-shop upgrades are excluded by construction.
            const trialExtraBuffs = buildCommunityBuffs(event.data.extra || {}).concat(guildBuffs);

            const summaries = [];
            try {
                for (let it = 0; it < iterations; it++) {
                    const players = [];
                    for (let i = 0; i < playersData.length; i++) {
                        const p = Player.createFromDTO(structuredClone(playersData[i]));
                        p.zoneBuffs = []; // no labyrinth crates in trials
                        // MWIX adaptation (per-member shrines, 2026-09-18):
                        // guild SHRINES are bought per member, not per guild, so
                        // the UI now attaches each unit's own resolved shrine
                        // buffs to its DTO and they are concatenated here. A DTO
                        // without `extraBuffs` yields the old behaviour exactly;
                        // `Player.createFromDTO` ignores the field, so it reaches
                        // this line only via the DTO object itself.
                        // NOTE: runGuildTrialSimulation in api/lib/simulator.js
                        // deliberately still OVERWRITES extraBuffs on the
                        // headless TRIAL path. SCLIRoster's trialRequest.js
                        // folds shrines in around that overwrite and pins the
                        // line by test (optimizer/test/trial-request.test.js:
                        // 356-369), so changing it would double-apply shrines
                        // for that caller. Unlocking it is a separate two-repo
                        // change. The headless ZONE path (runSimulation) and the
                        // two optimisers DO now concat the per-player tail, as
                        // this line and start_simulation above do — nothing in
                        // SCLIRoster goes through those.
                        p.extraBuffs = trialExtraBuffs.concat(playersData[i].extraBuffs || []);
                        players.push(p);
                    }
                    const participantCount = cfg.participantCount ?? players.length;
                    const guildTrial = new GuildTrial(
                        cfg.trialHrid,
                        cfg.startTier ?? GuildTrial.START_TIER,
                        participantCount,
                        cfg.trialOptions || {}
                    );
                    const combatSimulator = new CombatSimulator(players, null, null, { guildTrial });
                    const simResult = await combatSimulator.simulate(GuildTrial.TRIAL_DURATION_NS);
                    summaries.push(extractTrialSummary(simResult));

                    this.postMessage({
                        type: "simulation_progress",
                        progress: (it + 1) / iterations,
                    });
                }
                this.postMessage({ type: "guild_trial_result", summaries });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
    }
};
