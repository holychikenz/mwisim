import { summariseZoneRun } from '../utils/allZones.js';

// =============================================================================
// allZonesWorker — a pool that runs one zone/tier combination per shard
//
// Spawns upstream's own `src/worker.js` (one instance per combination, the same
// `start_simulation` protocol useSimulation speaks) and keeps N of them busy
// until the queue drains. The same nested-worker pattern as upstream's
// multiWorker.js, which this deliberately does NOT reuse:
//
//   guild buffs   multiWorker's `start_simulation_all_zones` forwards players,
//                 zone, extra and the time limit — but not `guildBuffs`. Every
//                 other path in this UI ships the character's shrine levels
//                 (App.jsx → resolveGuildBuffs), and a sweep that silently
//                 dropped them would rank zones for a character nobody has.
//   streaming     it collects every result and posts one array at the end. A
//                 seventy-eight-combination sweep is minutes long; rows are
//                 posted here as each finishes, so the table fills as it goes.
//   fault tolerance  one thrown simulation rejects its whole Promise.all there.
//                 Here a failed combination becomes a row with an `error` and
//                 the sweep carries on — a build that cannot survive T5 Infernal
//                 Abyss should cost you that row, not the other seventy-seven.
//
// Cancellation is the caller terminating this worker: a dedicated worker owns
// the workers it spawns, so the shards die with it.
//
// Protocol
//   →  { type: 'start_all_zones', players, combos: [{zoneHrid, difficultyTier}],
//        simulationTimeLimit, extra, guildBuffs, workers }
//   ←  { type: 'all_zones_progress', progress /* 0-1 */, completed, total }
//   ←  { type: 'all_zones_row', row }        // one per combination, as it lands
//   ←  { type: 'all_zones_done', completed, failed }
//   ←  { type: 'all_zones_error', error }    // the sweep itself failed
// =============================================================================

onmessage = async function (event) {
    if (event.data?.type !== 'start_all_zones') return;

    const data = event.data;
    const combos = Array.isArray(data.combos) ? data.combos : [];
    if (combos.length === 0) {
        self.postMessage({ type: 'all_zones_done', completed: 0, failed: 0 });
        return;
    }

    const cores = navigator.hardwareConcurrency || 4;
    const requested = Math.round(Number(data.workers) || 0);
    const poolSize = Math.max(1, Math.min(requested > 0 ? requested : cores, combos.length));

    // A shard is expected to speak every 1000 processed events, so this much
    // silence means it is wedged rather than busy — the realistic case being a
    // browser that declines to start the fourteenth nested worker under memory
    // pressure, where `new Worker` neither throws nor fires onerror. Without a
    // per-combination bound, that one runner blocks forever and the sweep never
    // reports done: the user waits out every other combination and is then told
    // the whole thing stalled. Now it costs exactly one row.
    const SHARD_SILENCE_MS = 90_000;

    // Progress is posted only when the aggregate actually moves. Every message
    // re-renders the app, and a full pool emits hundreds per second; a tenth of a
    // percent is far finer than any progress bar can show.
    const PROGRESS_EPSILON = 0.001;

    // Fractional progress per combination, so the bar moves inside a long run
    // rather than only when one completes.
    const progress = new Array(combos.length).fill(0);
    let completed = 0;
    let failed = 0;

    let lastPosted = -1;
    const postProgress = (force = false) => {
        const total = progress.reduce((sum, p) => sum + p, 0) / combos.length;
        if (!force && Math.abs(total - lastPosted) < PROGRESS_EPSILON) return;
        lastPosted = total;
        self.postMessage({
            type: 'all_zones_progress',
            progress: total,
            completed,
            total: combos.length,
        });
    };

    const runCombo = (task) =>
        new Promise((resolve) => {
            // Inline `new URL(..., import.meta.url)`: Vite's worker transform
            // only recognises the literal form, so hoisting it to a const would
            // survive dev and break the production bundle.
            const shard = new Worker(new URL('../../../src/worker.js', import.meta.url), {
                type: 'module',
            });

            let settled = false;
            let silenceTimer = null;
            const finish = (row) => {
                if (settled) return;
                settled = true;
                if (silenceTimer) clearTimeout(silenceTimer);
                progress[task.index] = 1;
                shard.terminate();
                resolve(row);
            };

            // Re-armed by every message from the shard, so a healthy, chatty
            // simulation never trips it however long it legitimately takes.
            const armSilenceTimer = () => {
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    finish({
                        zoneHrid: task.zoneHrid,
                        difficultyTier: task.difficultyTier,
                        error: `No response for ${SHARD_SILENCE_MS / 1000}s — worker abandoned`,
                    });
                }, SHARD_SILENCE_MS);
            };

            shard.onmessage = (msg) => {
                armSilenceTimer();
                const payload = msg.data || {};
                switch (payload.type) {
                    case 'simulation_result':
                        finish(summariseZoneRun(payload.simResult, task));
                        break;
                    case 'simulation_progress':
                        progress[task.index] = Math.min(1, Number(payload.progress) || 0);
                        postProgress();
                        break;
                    case 'simulation_error':
                        finish({
                            zoneHrid: task.zoneHrid,
                            difficultyTier: task.difficultyTier,
                            error: String(payload.error?.message || payload.error || 'Simulation failed'),
                        });
                        break;
                    default:
                        break;
                }
            };

            shard.onerror = (err) => {
                finish({
                    zoneHrid: task.zoneHrid,
                    difficultyTier: task.difficultyTier,
                    error: err?.message || 'Simulation worker crashed',
                });
            };

            armSilenceTimer();
            shard.postMessage({
                type: 'start_simulation',
                players: data.players,
                zone: { zoneHrid: task.zoneHrid, difficultyTier: task.difficultyTier },
                labyrinth: null,
                simulationTimeLimit: data.simulationTimeLimit,
                extra: data.extra || {},
                guildBuffs: data.guildBuffs || [],
            });
        });

    try {
        const queue = combos.map((combo, index) => ({ ...combo, index }));

        // One runner per pool slot, each pulling the next combination when its
        // last one finishes. A fixed split would leave slots idle: a T0 planet
        // and a T5 dungeon are not the same amount of work.
        const runner = async () => {
            while (queue.length > 0) {
                const task = queue.shift();
                const row = await runCombo(task);
                completed++;
                if (row.error) failed++;
                self.postMessage({ type: 'all_zones_row', row });
                // Forced: a completed combination changes the count the UI shows,
                // even when the aggregate fraction barely moved.
                postProgress(true);
            }
        };

        postProgress(true);
        await Promise.all(Array.from({ length: poolSize }, runner));

        self.postMessage({ type: 'all_zones_done', completed, failed });
    } catch (e) {
        self.postMessage({
            type: 'all_zones_error',
            error: String(e?.message || e || 'Zone sweep failed'),
        });
    }
};
