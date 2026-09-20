#!/usr/bin/env node
// =============================================================================
// bench/candle.mjs — run the standard candle and print a comparison table.
//
//   npm run bench                     # csim only, ~2 min
//   npm run bench -- --engines=csim,metz --metz=/path/to/metz-combat-simulator
//   npm run bench -- --only=dungeon-den-600,melee-solo --reps=5
//   npm run bench -- --json=bench.json            # machine-readable, for diffing
//   npm run bench -- --baseline=bench.json        # show the delta vs a recording
//
// WHAT IS MEASURED, AND WHY IT IS MEASURED THAT WAY
// ------------------------------------------------
// The headline number is MARGINAL MILLISECONDS PER SIMULATED GAME-HOUR.
//
// Each case is run at two simulated-hour lengths and the number reported is the
// SLOPE between them:  (ms@h1 - ms@h0) / (h1 - h0).
//
// The slope, not the total, because a single total is mostly fixed cost —
// module load, game-data parse, structuredClone of the player DTOs, worker
// spawn — none of which scales with how long a user asks to simulate, and all
// of which would let a change that made the per-event work slower look like an
// improvement if it happened to shave startup. Differencing two lengths
// cancels every term that does not depend on simulated time, which leaves the
// thing we actually care about: the cost of simulating combat.
//
// It also makes the number COMPARABLE ACROSS ENGINES that have wildly different
// startup costs. A wasm kernel pays for module instantiation once and a
// JavaScript engine pays for parse and tier-up; neither belongs in a claim
// about which simulates a dungeon faster.
//
// Each point is the MEDIAN of `--reps` runs, after one untimed warm-up run at
// the short length, so V8 has tiered up the hot loop before the clock starts.
// Median rather than mean because the failure mode here is an occasional long
// sample (GC, scheduler), which drags a mean and does not move a median.
//
// The `enc/h` column is encounters per simulated hour. It is NOT a performance
// number — it is the control. Two engines that agree on throughput to within a
// few percent are simulating the same fight; if that column diverges, the speed
// column is comparing two different games and should be ignored until it is
// explained.
//
// WHAT THIS IS NOT
// ----------------
// It is not a parity check. `npm run sim:check` proves bit-identical output;
// this proves nothing about correctness beyond the coarse enc/h control.
// Run both.
// =============================================================================

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { BUILDS, CASES, partyBuilds, toCsimPlayer, toMetzPlayer, validateCases } from "./builds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "src", "combatsimulator");

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const REPS = Number(arg("reps", "3"));
const ONLY = arg("only") ? new Set(arg("only").split(",")) : null;
const ENGINES = arg("engines", "csim").split(",").filter(Boolean);
const METZ_ROOT = arg("metz", process.env.METZ_ROOT);
const JSON_OUT = arg("json");
const BASELINE = arg("baseline");

// Legality first, before anything is loaded or timed. A party bigger than the
// zone allows is not a slow case, it is a meaningless one — and one that a
// stricter engine answers with a trap rather than a number.
validateCases(JSON.parse(readFileSync(join(SRC, "data", "actionDetailMap.json"), "utf8")));

const cases = CASES.filter((c) => !ONLY || ONLY.has(c.id));
if (!cases.length) {
  console.error(`bench: --only matched no case. Known ids:\n  ${CASES.map((c) => c.id).join("\n  ")}`);
  process.exit(1);
}

// ---- stats ------------------------------------------------------------------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- engines ----------------------------------------------------------------
// An engine is { name, ready(), prepare(case) -> job, run(job, hours) -> {ms, encounters} }.
// `prepare` does every per-case allocation ONCE so it cannot leak into the
// timed region and differ between the two hour-points.

async function csimEngine() {
  const { runSimulation } = await import(join(__dirname, "..", "lib", "simulator.js"));
  const items = JSON.parse(readFileSync(join(SRC, "data", "itemDetailMap.json"), "utf8"));
  const abilityData = JSON.parse(readFileSync(join(SRC, "data", "abilityDetailMap.json"), "utf8"));

  return {
    name: "csim",
    prepare(kase) {
      const players = partyBuilds(kase).map((name, i) =>
        toCsimPlayer(BUILDS[name], { level: kase.level, index: i + 1, items, abilityData })
      );
      return { players, zone: { zoneHrid: `/actions/combat/${kase.zone}`, difficultyTier: kase.tier } };
    },
    async run(job, hours) {
      // The engine logs progress to stdout; silence it so a 21-case run is
      // readable, and so console formatting is not part of what we time.
      const real = console.log;
      console.log = () => {};
      const t0 = performance.now();
      let result;
      try {
        result = await runSimulation({
          players: job.players,
          zone: job.zone,
          simulationTimeLimit: hours * 3600e9,
          extra: {},
        });
      } finally {
        console.log = real;
      }
      return { ms: performance.now() - t0, encounters: result.encounters ?? result.enc ?? 0 };
    },
  };
}

async function metzEngine(root) {
  if (!root) throw new Error("bench: --engines includes metz but no --metz=<path> / METZ_ROOT given");
  const { initSync, simulate } = await import(join(root, "kernel-zone", "wasm", "pkg", "mwi_zone_wasm.js"));
  initSync({
    module: new WebAssembly.Module(readFileSync(join(root, "kernel-zone", "wasm", "pkg", "mwi_zone_wasm_bg.wasm"))),
  });
  const items = JSON.parse(readFileSync(join(root, "init_client_data.json"), "utf8")).itemDetailMap;

  return {
    name: "metz",
    prepare(kase) {
      const players = partyBuilds(kase).map((name, i) =>
        toMetzPlayer(BUILDS[name], { level: kase.level, index: i + 1, items })
      );
      return { players, zone: `/actions/combat/${kase.zone}`, tier: kase.tier };
    },
    async run(job, hours) {
      // Serialise outside the clock: the kernel takes a JSON string, and
      // JSON.stringify of five endgame loadouts is not simulation work.
      const payload = JSON.stringify({
        zone: job.zone,
        difficultyTier: job.tier,
        hours,
        seed: 1,
        players: job.players,
        playerOptions: {},
        epochAnchorMs: 17e11,
      });
      const t0 = performance.now();
      const raw = simulate(payload);
      const ms = performance.now() - t0;
      const result = JSON.parse(raw);
      return { ms, encounters: result.encountersStarted ?? 0 };
    },
  };
}

// ---- measurement ------------------------------------------------------------

async function measure(engine, kase) {
  const job = engine.prepare(kase);
  const [h0, h1] = kase.hours;

  await engine.run(job, h0); // warm-up, untimed

  const at = async (h) => {
    const samples = [];
    let last;
    for (let i = 0; i < REPS; i++) {
      last = await engine.run(job, h);
      samples.push(last.ms);
    }
    return { ms: median(samples), encounters: last.encounters, hours: h };
  };

  const p0 = await at(h0);
  const p1 = await at(h1);

  return {
    msPerSimHour: (p1.ms - p0.ms) / (p1.hours - p0.hours),
    encPerHour: p1.encounters / p1.hours,
    points: [p0, p1],
  };
}

// ---- run --------------------------------------------------------------------

const engines = [];
for (const name of ENGINES) {
  if (name === "csim") engines.push(await csimEngine());
  else if (name === "metz") engines.push(await metzEngine(METZ_ROOT));
  else throw new Error(`bench: unknown engine "${name}"`);
}

const started = performance.now();
const results = {};

for (const kase of cases) {
  for (const engine of engines) {
    process.stderr.write(`  ${engine.name}/${kase.id} … `);
    try {
      const r = await measure(engine, kase);
      (results[kase.id] ??= {})[engine.name] = r;
      process.stderr.write(`${r.msPerSimHour.toFixed(1)} ms/h, ${r.encPerHour.toFixed(0)} enc/h\n`);
    } catch (e) {
      (results[kase.id] ??= {})[engine.name] = { error: String(e.message || e) };
      process.stderr.write(`FAILED: ${e.message}\n`);
    }
  }
}

const elapsed = (performance.now() - started) / 1000;

// ---- report -----------------------------------------------------------------

const baseline = BASELINE ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;

const cell = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(1));
const pad = (s, w, right = true) => (right ? String(s).padStart(w) : String(s).padEnd(w));

const hasMetz = engines.some((e) => e.name === "metz");
const idW = Math.max(12, ...cases.map((c) => c.id.length));
const scenW = Math.max(28, ...cases.map((c) => `${c.zone} T${c.tier} L${c.level} ×${c.n}`.length));

const head = [pad("case", idW, false), pad("scenario", scenW, false), pad("ms/sim-h csim", 14)];
if (hasMetz) head.push(pad("metz", 8), pad("gap", 7));
head.push(pad("enc/h csim", 11));
if (hasMetz) head.push(pad("metz", 9), pad("Δenc", 7));
if (baseline) head.push(pad("vs base", 9));

const lines = [head.join(" | "), head.map((h) => "-".repeat(h.length)).join("-|-")];

for (const kase of cases) {
  const r = results[kase.id] || {};
  const c = r.csim, m = r.metz;
  const cMs = c && !c.error ? c.msPerSimHour : null;
  const mMs = m && !m.error ? m.msPerSimHour : null;

  const row = [
    pad(kase.id, idW, false),
    pad(`${kase.zone} T${kase.tier} L${kase.level} ×${kase.n}`, scenW, false),
    pad(cMs === null ? (c?.error ? "ERR" : "—") : cell(cMs), 14),
  ];
  if (hasMetz) {
    row.push(pad(mMs === null ? (m?.error ? "ERR" : "—") : cell(mMs), 8));
    row.push(pad(cMs !== null && mMs !== null && mMs > 0 ? (cMs / mMs).toFixed(1) + "×" : "—", 7));
  }
  row.push(pad(c && !c.error ? c.encPerHour.toFixed(0) : "—", 11));
  if (hasMetz) {
    row.push(pad(m && !m.error ? m.encPerHour.toFixed(0) : "—", 9));
    const d = c && m && !c.error && !m.error && m.encPerHour > 0
      ? ((c.encPerHour / m.encPerHour - 1) * 100).toFixed(1) + "%"
      : "—";
    row.push(pad(d, 7));
  }
  if (baseline) {
    const b = baseline.results?.[kase.id]?.csim?.msPerSimHour;
    row.push(pad(b && cMs !== null ? ((cMs / b - 1) * 100).toFixed(1) + "%" : "—", 9));
  }
  lines.push(row.join(" | "));
}

console.log();
console.log(lines.join("\n"));
console.log();
console.log(
  `${cases.length} cases × ${engines.length} engine(s), ${REPS} reps + warm-up — ${elapsed.toFixed(1)}s wall`
);

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        reps: REPS,
        engines: engines.map((e) => e.name),
        results,
      },
      null,
      2
    )
  );
  console.error(`wrote ${JSON_OUT}`);
}
