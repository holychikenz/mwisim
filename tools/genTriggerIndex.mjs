#!/usr/bin/env node
// =============================================================================
// Generates src/combatsimulator/generated/triggerIndex.js — the condition-hrid
// to buff-unique-hrid table Trigger's constructor reads.
//
// WHY. Trigger.getDependencyValue built this string on every evaluation:
//
//     "/buff_uniques" + conditionHrid.slice(conditionHrid.lastIndexOf("/"))
//
// Hoisting it into the constructor removed it from the hot path and paid -4.0%
// on the candle — but it REGRESSED floor-party by 1.2%, losing five of six
// counterbalanced rounds at --reps=9. That case spawns many monsters into cheap
// fights, and every monster spawn constructs its abilities and therefore its
// triggers, so the hoist moved cost from evaluation to CONSTRUCTION. At roughly
// 2 400 constructions an hour, +0.045 ms/h is about 18 ns each, which is what a
// lastIndexOf plus a slice plus a concatenation costs.
//
// A build-time table makes the constructor a single lookup and, as a second
// benefit, hands every trigger the SAME interned string rather than a freshly
// allocated one — so the dictionary reads in getDependencyValue compare a
// pointer before they compare characters, and nothing is allocated per spawn.
//
// Two deliberate choices:
//
//  * The conditions are collected STRUCTURALLY from the game data (the keys of
//    combatTriggerConditionDetailMap, plus any condition hrid named anywhere in
//    the bundled maps) and from the engine's own source. A structural walk
//    cannot have a character-class bug. Where source text is scanned the
//    pattern is [A-Za-z0-9_]+ and DIGITS ARE IN THE CLASS.
//
//  * Trigger's constructor FALLS BACK to the original concatenation for a
//    condition this table has never seen, rather than throwing. Unlike a buff
//    type — where an unknown hrid must throw, because indexing a dense array at
//    undefined silently drops the buff — an unknown condition here is merely a
//    string this table did not precompute, and api/lib/triggerSearch builds
//    Trigger objects speculatively. Throwing would turn a speculative trigger
//    into a crash; the fallback computes the identical string.
//
// Usage:  node tools/genTriggerIndex.mjs          # write the generated file
//         node tools/genTriggerIndex.mjs --stdout # print it, write nothing
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "src/combatsimulator/data");
const ENGINE_DIR = path.join(ROOT, "src/combatsimulator");
const OUT_PATH = path.join(ROOT, "src/combatsimulator/generated/triggerIndex.js");

const PREFIX = "/combat_trigger_conditions/";

// Digits ARE in the class. See the header.
const HRID_PATTERN = /\/combat_trigger_conditions\/[A-Za-z0-9_]+/g;

/** The transformation this table precomputes. The single source of that truth. */
export function buffUniqueHridFor(conditionHrid) {
    return "/buff_uniques" + conditionHrid.slice(conditionHrid.lastIndexOf("/"));
}

/** Scan a blob of source text for condition hrid literals. */
export function scanHrids(text) {
    return text.match(HRID_PATTERN) ?? [];
}

/** Walk a parsed JSON tree and collect every string value or key naming a condition. */
export function walkJson(node, out) {
    if (typeof node === "string") {
        if (node.startsWith(PREFIX) && node.length > PREFIX.length) out.add(node);
        return out;
    }
    if (Array.isArray(node)) {
        for (const child of node) walkJson(child, out);
        return out;
    }
    if (node && typeof node === "object") {
        for (const key of Object.keys(node)) {
            if (key.startsWith(PREFIX) && key.length > PREFIX.length) out.add(key);
            walkJson(node[key], out);
        }
    }
    return out;
}

function listJsFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "generated" || entry.name === "data") continue;
            listJsFiles(full, acc);
        } else if (entry.name.endsWith(".js")) {
            acc.push(full);
        }
    }
    return acc;
}

export function collect() {
    const found = new Set();
    for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort()) {
        walkJson(JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")), found);
    }
    for (const file of listJsFiles(ENGINE_DIR).sort()) {
        for (const hrid of scanHrids(fs.readFileSync(file, "utf8"))) found.add(hrid);
    }
    return [...found].sort();
}

export function render(conditions) {
    const L = [];
    L.push("// =============================================================================");
    L.push("// GENERATED FILE — DO NOT EDIT BY HAND.");
    L.push("//");
    L.push("// Produced by tools/genTriggerIndex.mjs; see that file for why this is");
    L.push("// generated, and api/tests/triggerIndex.test.mjs, which re-runs the generator");
    L.push("// and compares this file byte for byte. Regenerate with:");
    L.push("//");
    L.push("//     node tools/genTriggerIndex.mjs");
    L.push("//");
    L.push("// Entries are sorted, so the table is a pure function of the game data and an");
    L.push("// update lands as a reviewable diff rather than a silent renumbering.");
    L.push("// =============================================================================");
    L.push("");
    L.push("/**");
    L.push(" * condition hrid -> the buff-unique hrid its buff lookups use.");
    L.push(" * Null-prototype: no inherited keys to shadow a condition named `constructor`.");
    L.push(" */");
    L.push("export const BUFF_UNIQUE_BY_CONDITION = Object.freeze(Object.assign(Object.create(null), {");
    for (const c of conditions) L.push(`    ${JSON.stringify(c)}: ${JSON.stringify(buffUniqueHridFor(c))},`);
    L.push("}));");
    L.push("");
    L.push("export const TRIGGER_CONDITION_COUNT = " + conditions.length + ";");
    L.push("");
    return L.join("\n");
}

export function generate() {
    return render(collect());
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const text = generate();
    if (process.argv.includes("--stdout")) {
        process.stdout.write(text);
    } else {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(OUT_PATH, text);
        process.stderr.write(`wrote ${path.relative(ROOT, OUT_PATH)} (${collect().length} conditions)\n`);
    }
}

export { OUT_PATH };
