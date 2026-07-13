import { aggregateTrialResults } from "./combatsimulator/guildTrialStats";

onmessage = async function (event) {
    switch (event.data.type) {
        case "start_simulation_guild_trial": {
            // Shard trial ITERATIONS across workers (one trial config, run many
            // times), then aggregate per-tier stats. Mirrors the zone/lab pool
            // pattern but the unit of work is a chunk of iterations, not a zone.
            // Payload: { players[], guildTrial:{trialHrid,startTier,participantCount,
            //   trialOptions}, guildBuffs[], extra, iterations, aggregateOptions }
            const totalIterations = Math.max(1, event.data.iterations || 1000);
            const aggregateOptions = event.data.aggregateOptions || {};

            try {
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
        case "start_simulation_all_zones":
            const zoneHrids = event.data.zones;
            let zoneProgress = Object.fromEntries(zoneHrids.map(zone => [zone.zoneHrid+'#'+zone.difficultyTier, 0]));

            try {
                const maxWorkers = navigator.hardwareConcurrency;
                console.log("maxWorkers: " + maxWorkers);

                const taskQueue = [...zoneHrids];
                const results = new Array(zoneHrids.length);
                const outer_worker = this;

                // 创建工作线程池
                const processTask = async (workerId) => {
                    while (taskQueue.length > 0) {
                        const zoneIndex = zoneHrids.length - taskQueue.length;
                        const currentZone = taskQueue.shift();

                        const simulationWorker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });

                        // Do simulation
                        let workerMessage = {
                            type: "start_simulation",
                            players: event.data.players,
                            zone: currentZone,
                            extra: event.data.extra,
                            simulationTimeLimit: event.data.simulationTimeLimit,
                        };
                        simulationWorker.postMessage(workerMessage);
                        
                        const result = await new Promise((resolve, reject) => {
                            simulationWorker.onmessage = function (event) {
                                if (event.data.type === "simulation_result") {
                                    zoneProgress[event.data.zone+'#'+event.data.difficultyTier] = 1.0;
                                    resolve(event.data.simResult);
                                } else if (event.data.type === "simulation_progress") {
                                    zoneProgress[event.data.zone+'#'+event.data.difficultyTier] = event.data.progress;
                                    let totalProgress = Object.values(zoneProgress).reduce((acc, progress) => acc + progress, 0) / Object.keys(zoneProgress).length;
                                    outer_worker.postMessage({ type: "simulation_progress", progress: totalProgress });
                                } else if (event.data.type === "simulation_error") {
                                    reject(event.data.error);
                                }
                            };
                        });

                        results[zoneIndex] = result;
                        simulationWorker.terminate();
                    }
                };

                // 启动工作线程
                const workers = Array(Math.min(maxWorkers, zoneHrids.length))
                    .fill()
                    .map((_, index) => processTask(index));

                // 等待所有任务完成
                await Promise.all(workers);

                this.postMessage({ type: "simulation_result_allZones", simResults: results });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        case "start_simulation_all_labyrinths":
            const labyrinthHrids = event.data.labyrinths;
            let labyrinthProgress = Object.fromEntries(labyrinthHrids.map(labyrinth => [labyrinth.labyrinthHrid+'#'+labyrinth.roomLevel, 0]));
            
            try {
                const maxWorkers = navigator.hardwareConcurrency;
                console.log("maxWorkers: " + maxWorkers);

                const taskQueue = [...labyrinthHrids];
                const results = new Array(labyrinthHrids.length);
                const outer_worker = this;

                // 创建工作线程池
                const processTask = async (workerId) => {
                    while (taskQueue.length > 0) {
                        const labyrinthIndex = labyrinthHrids.length - taskQueue.length;
                        const currentLabyrinth = taskQueue.shift();

                        const simulationWorker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });

                        // Do simulation
                        let workerMessage = {
                            type: "start_simulation",
                            players: event.data.players,
                            labyrinth: currentLabyrinth,
                            extra: event.data.extra,
                            simulationTimeLimit: event.data.simulationTimeLimit,
                        };
                        simulationWorker.postMessage(workerMessage);
                        
                        const result = await new Promise((resolve, reject) => {
                            simulationWorker.onmessage = function (event) {
                                if (event.data.type === "simulation_result") {
                                    labyrinthProgress[currentLabyrinth.labyrinthHrid+'#'+currentLabyrinth.roomLevel] = 1.0;
                                    resolve(event.data.simResult);
                                } else if (event.data.type === "simulation_progress") {
                                    labyrinthProgress[currentLabyrinth.labyrinthHrid+'#'+currentLabyrinth.roomLevel] = event.data.progress;
                                    let totalProgress = Object.values(labyrinthProgress).reduce((acc, progress) => acc + progress, 0) / Object.keys(labyrinthProgress).length;
                                    outer_worker.postMessage({ type: "simulation_progress", progress: totalProgress });
                                } else if (event.data.type === "simulation_error") {
                                    reject(event.data.error);
                                }
                            };
                        });

                        results[labyrinthIndex] = result;
                        simulationWorker.terminate();
                    }
                };

                // 启动工作线程
                const workers = Array(Math.min(maxWorkers, labyrinthHrids.length))
                    .fill()
                    .map((_, index) => processTask(index));

                // 等待所有任务完成
                await Promise.all(workers);

                this.postMessage({ type: "simulation_result_allLabyrinths", simResults: results });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }   
            break;
    }
};