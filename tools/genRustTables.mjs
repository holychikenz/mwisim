#!/usr/bin/env node
// =============================================================================
// Generates rust/src/generated.rs — the engine-semantics tables the Rust twin
// (rust/) needs, from the SAME collect() functions that produce the JS engine's
// own generated files. One source of truth for both engines: a stat added to
// EQUIPMENT_COMBAT_STATS, a trigger condition regrouped, or a buff type added
// to the data reaches the twin by re-running this, and
// api/tests/rustTables.test.mjs fails until it is re-run.
//
// Not generated: triggerIndex (Rust computes "/buff_uniques" + the condition's
// last path segment, which is the formula that table precomputes) and buff-type
// ordinals (the twin indexes BUFF_TYPE_NAMES itself).
//
// Usage:  node tools/genRustTables.mjs          # write the generated file
//         node tools/genRustTables.mjs --stdout # print it, write nothing
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collect as collectStats } from "./genStatSchema.mjs";
import { collect as collectTriggerKinds } from "./genTriggerKinds.mjs";
import { collect as collectBuffTypes } from "./genBuffTypes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "rust/src/generated.rs");

const strList = (name, items) => [
    `pub const ${name}: &[&str] = &[`,
    ...items.map((n) => `    ${JSON.stringify(n)},`),
    "];",
    "",
];

export function collect() {
    const stats = collectStats();
    const { conditions } = collectTriggerKinds();
    return { ...stats, conditions, buffTypes: collectBuffTypes() };
}

export function render({ equipment, monsterZeroed, monsterResidual, conditions, buffTypes }) {
    const L = [
        "// GENERATED FILE — DO NOT EDIT BY HAND.",
        "// Produced by tools/genRustTables.mjs; api/tests/rustTables.test.mjs re-runs",
        "// the generator and compares this file byte for byte. Regenerate with:",
        "//     node tools/genRustTables.mjs",
        "",
        ...strList("EQUIPMENT_COMBAT_STATS", equipment),
        ...strList("MONSTER_ZEROED_COMBAT_STATS", monsterZeroed),
        ...strList("MONSTER_RESIDUAL_STATS", monsterResidual),
        "/// (condition hrid, kind name), sorted by hrid.",
        "pub const TRIGGER_CONDITION_KINDS: &[(&str, &str)] = &[",
        ...conditions.map(([hrid, kind]) => `    (${JSON.stringify(hrid)}, ${JSON.stringify(kind)}),`),
        "];",
        "",
        ...strList("BUFF_TYPE_NAMES", buffTypes),
    ];
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
        process.stderr.write(`wrote ${path.relative(ROOT, OUT_PATH)}\n`);
    }
}

export { OUT_PATH };
