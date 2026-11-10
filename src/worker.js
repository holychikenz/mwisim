import CombatSimulator from "./combatsimulator/combatSimulator";
import Player from "./combatsimulator/player";
import Zone from "./combatsimulator/zone";
import Labyrinth from "./combatsimulator/labyrinth";
import { applySimSettingsFromExtra } from "./combatsimulator/simSettings";
import { buildCommunityBuffs } from "../shared/communityBuffs.js";
import { runTrialIterations } from "../shared/guildTrialRuns.js";
import { buildLabUpgradeBuffs } from "../shared/labUpgrades.js";
import { setTwinBackend, runTwin } from "../shared/twinEngine.js";
import { loadWasmTwin } from "./twinWasm.js";

onmessage = async function (event) {
    // MWIX adaptation (Rust twin): extra.experimental.engine === "wasm" runs
    // zone and trial jobs on the wasm build of rust/; labyrinths stay on JS.
    let twin = null;
    try {
        twin = event.data.extra?.experimental?.engine === "wasm" ? await loadWasmTwin() : null;
    } catch (e) {
        console.log(e);
        this.postMessage({ type: "simulation_error", error: e });
        return;
    }
    setTwinBackend(twin);
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
            // always empty and the real work happens in the concat below. Any
            // objects that do arrive here come pre-resolved, level already
            // folded in, from ui/src/utils/guildBuffs.js.
            //
            // NOTE: guild BUILDING buffs are deliberately NOT included on this
            // path — those apply to guild trials only (see "start_guild_trial").
            let extraBuffs = buildCommunityBuffs(event.data.extra || {});
            // MWIX adaptation: lab-shop upgrades apply only with the "labyrinth run" toggle on.
            if (event.data.extra?.mwixMaze?.enabled) {
                extraBuffs = extraBuffs.concat(buildLabUpgradeBuffs(event.data.extra.mwixLabUpgrades));
            }
            extraBuffs = extraBuffs.concat(event.data.guildBuffs || []);

            if (twin && !event.data.labyrinth) {
                const { zone, simulationTimeLimit, maxRuns, maxRunDurationNs } = event.data;
                try {
                    const simResult = await runTwin(
                        twin,
                        { kind: "zone", players: event.data.players, partyBuffs: extraBuffs, zone, simulationTimeLimit, ...(maxRuns ? { runLimits: { maxRuns, maxRunDurationNs } } : {}) },
                        (progress) => this.postMessage({ type: "simulation_progress", progress, zone: zone.zoneHrid, difficultyTier: zone.difficultyTier }),
                    );
                    this.postMessage({ type: "simulation_result", simResult });
                } catch (e) {
                    console.log(e);
                    this.postMessage({ type: "simulation_error", error: e });
                }
                break;
            }

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
            let combatSimulator = new CombatSimulator(players, zone, labyrinth);
            combatSimulator.addEventListener("progress", (event) => {
                this.postMessage({
                    type: "simulation_progress",
                    progress: event.detail.progress,
                    zone: event.detail.zone,
                    difficultyTier: event.detail.difficultyTier,
                    labyrinth: event.detail.labyrinth,
                    roomLevel: event.detail.roomLevel,
                });
            });

            // MWIX adaptation (dungeon run mode): `maxRuns` asks for that many
            // dungeon runs instead of an amount of time (see
            // CombatSimulator._beginRunMode); multiWorker's
            // start_simulation_dungeon_runs sends one such message per batch.
            const runLimits = event.data.maxRuns
                ? { maxRuns: event.data.maxRuns, maxRunDurationNs: event.data.maxRunDurationNs }
                : undefined;
            try {
                let simResult = await combatSimulator.simulate(simulationTimeLimit, runLimits);
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

            // Buffs that apply in trials: community + guild building buffs.
            // Labyrinth crates & lab-shop upgrades are excluded by construction.
            const trialExtraBuffs = buildCommunityBuffs(event.data.extra || {}).concat(guildBuffs);

            try {
                const summaries = await runTrialIterations({
                    players: playersData,
                    partyBuffs: trialExtraBuffs,
                    trialHrid: cfg.trialHrid,
                    startTier: cfg.startTier ?? undefined,
                    participantCount: cfg.participantCount,
                    trialOptions: cfg.trialOptions || {},
                    iterations,
                    onIteration: (done) => this.postMessage({ type: "simulation_progress", progress: done / iterations }),
                });
                this.postMessage({ type: "guild_trial_result", summaries });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
    }
};
