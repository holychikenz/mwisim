import { aggregateTrialResults } from "./combatsimulator/guildTrialStats";
import { planShards, mergeSimResults, runDungeonRunsSerial, workerBatchRunner, addRunIdleTime, runZoneRepeats } from "../shared/dungeonRuns.js";

onmessage = async function (event) {
    switch (event.data.type) {
        case "start_simulation_guild_trial": {
            // Shard trial ITERATIONS across workers (one trial config, run many
            // times), then aggregate per-tier stats. Mirrors the zone/lab pool
            // pattern but the unit of work is a chunk of iterations, not a zone.
            // Payload: { players[], guildTrial:{trialHrid,startTier,participantCount,
            //   trialOptions}, guildBuffs[], extra, iterations, aggregateOptions }
            const totalIterations = event.data.iterations ?? 1000;
            const aggregateOptions = event.data.aggregateOptions || {};

            try {
                // Same rule as the API's runGuildTrialSimulation: no silent substitute for 0.
                if (!Number.isInteger(totalIterations) || totalIterations <= 0) {
                    throw new RangeError(`iterations must be a positive integer, got ${totalIterations}`);
                }
                const maxWorkers = navigator.hardwareConcurrency || 4;
                const numWorkers = Math.min(maxWorkers, totalIterations);
                const outer_worker = this;

                // Split iterations as evenly as possible across the shards.
                const base = Math.floor(totalIterations / numWorkers);
                const shards = Array(numWorkers).fill(base);
                for (let i = 0; i < totalIterations - base * numWorkers; i++) shards[i]++;

                const shardProgress = new Array(numWorkers).fill(0);

                const runShard = (shardIndex, shardIterations) =>
                    new Promise((resolve, reject) => {
                        const simulationWorker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
                        simulationWorker.postMessage({
                            type: "start_guild_trial",
                            players: event.data.players,
                            guildTrial: event.data.guildTrial,
                            guildBuffs: event.data.guildBuffs || [],
                            extra: event.data.extra || {},
                            iterations: shardIterations,
                        });
                        // A crash (a module that fails to load, an uncaught throw)
                        // posts nothing; without this the shard would never settle.
                        simulationWorker.onerror = (e) => {
                            e?.preventDefault?.();
                            simulationWorker.terminate();
                            reject(e?.message || 'Trial shard worker crashed');
                        };
                        simulationWorker.onmessage = function (msg) {
                            if (msg.data.type === "guild_trial_result") {
                                simulationWorker.terminate();
                                resolve(msg.data.summaries);
                            } else if (msg.data.type === "simulation_progress") {
                                shardProgress[shardIndex] = msg.data.progress;
                                const totalProgress =
                                    shardProgress.reduce((a, b) => a + b, 0) / numWorkers;
                                outer_worker.postMessage({ type: "simulation_progress", progress: totalProgress });
                            } else if (msg.data.type === "simulation_error") {
                                simulationWorker.terminate();
                                reject(msg.data.error);
                            }
                        };
                    });

                const shardResults = await Promise.all(shards.map((it, i) => runShard(i, it)));
                const summaries = [].concat(...shardResults);
                const aggregate = aggregateTrialResults(summaries, {
                    startTier: event.data.guildTrial?.startTier,
                    ...aggregateOptions,
                });

                this.postMessage({
                    type: "simulation_result_guildTrial",
                    aggregate,
                    summaries,
                });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
        case "start_simulation_dungeon_runs": {
            // A dungeon as `maxRuns` runs, each failed if still going after
            // `maxRunDurationNs`. Runs are split into one shard per core
            // (planShards); each shard is ONE nested worker.js that runs its
            // runs in batches, one start_simulation per batch (planBatches),
            // and the shards merge back into one SimResult laid end to end on
            // one clock (mergeSimResults). Shards come back raw; the idle
            // between runs is added once, here, to the final merge
            // (addRunIdleTime). See shared/dungeonRuns.js.
            // Payload: { players[], zone, extra, guildBuffs[], simulationTimeLimit,
            //   maxRuns, maxRunDurationNs }
            // Without nested workers (some browsers) the caller is told so and
            // runs the same batches over a single worker.js itself.
            if (typeof Worker !== "function") {
                this.postMessage({ type: "dungeon_runs_unsupported" });
                break;
            }
            try {
                const { maxRuns, maxRunDurationNs } = event.data;
                const message = {
                    players: event.data.players,
                    zone: event.data.zone,
                    extra: event.data.extra || {},
                    guildBuffs: event.data.guildBuffs || [],
                    simulationTimeLimit: event.data.simulationTimeLimit,
                    maxRunDurationNs,
                };
                const shards = planShards(maxRuns, navigator.hardwareConcurrency);
                const runsDone = shards.map(() => 0);
                const runShard = async (runs, i) => {
                    const simulationWorker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
                    try {
                        return await runDungeonRunsSerial({
                            totalRuns: runs,
                            maxRunDurationNs,
                            runBatch: workerBatchRunner(simulationWorker, message),
                            onProgress: (p) => {
                                runsDone[i] = p * runs;
                                const progress = runsDone.reduce((a, b) => a + b, 0) / maxRuns;
                                this.postMessage({ type: "simulation_progress", progress });
                            },
                        });
                    } finally {
                        simulationWorker.terminate();
                    }
                };
                const results = await Promise.all(shards.map(runShard));
                this.postMessage({ type: "simulation_result", simResult: addRunIdleTime(mergeSimResults(results)) });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
        case "start_simulation_zone_runs": {
            // A planet zone run `zoneRuns` times for simulationTimeLimit each,
            // on a pool of nested worker.js (one per core), merged into one
            // SimResult laid end to end (runZoneRepeats in shared/dungeonRuns.js).
            // Payload: { players[], zone, extra, guildBuffs[], simulationTimeLimit, zoneRuns }
            // Without nested workers the caller is told so and runs them itself.
            if (typeof Worker !== "function") {
                this.postMessage({ type: "zone_runs_unsupported" });
                break;
            }
            const pool = [];
            try {
                const { zoneRuns: count, type, ...message } = event.data;
                const size = Math.min(navigator.hardwareConcurrency || 4, count);
                for (let i = 0; i < size; i++) {
                    pool.push(new Worker(new URL('worker.js', import.meta.url), { type: 'module' }));
                }
                const simResult = await runZoneRepeats({
                    count,
                    workers: pool,
                    message,
                    onProgress: (progress) => this.postMessage({ type: "simulation_progress", progress }),
                });
                this.postMessage({ type: "simulation_result", simResult });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            } finally {
                pool.forEach((w) => w.terminate());
            }
            break;
        }
    }
};