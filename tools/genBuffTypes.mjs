#!/usr/bin/env node
// =============================================================================
// Generates src/combatsimulator/generated/buffTypes.js — the buff-type ordinal
// table that CombatUnit's buff-boost index is keyed on.
//
// WHY GENERATED, NOT TYPED. A CPU profile of the candle put buff aggregation
// (_buildBuffBoostIndex plus getBuffBoost) at ~16.5% of self time on
// dungeon-den-600, and the fix is to key that index by a dense integer ordinal
// instead of by string. That needs a complete list of buff-type hrids — and
// this codebase has already had a hand-maintained stat list silently corrupted
// once, by a scrape whose pattern dropped the two DIGIT-carrying names
// (hpRegenPer10, mpRegenPer10) and moved kills/hr by 2%. A list that is wrong
// by omission produces wrong combat numbers with no error. So: derive it, commit
// the output, and let api/tests/buffTypes.test.mjs re-run this generator and
// compare BYTE FOR BYTE. That test is what makes generation safe.
//
// Two deliberate choices:
//
//  * The JSON data maps are walked STRUCTURALLY — every string value in the
//    parsed tree is examined — not regex-scraped. A structural walk cannot
//    have a character-class bug, which is the exact failure recorded above.
//    Where source text must be scanned (engine literals, the i18n vocabulary)
//    the pattern is [A-Za-z0-9_]+ and DIGITS ARE IN THE CLASS; scanHrids is
//    exported so the test can prove that against a synthetic digit-bearing
//    name rather than anyone eyeballing the regex.
//
//  * Ordinals are assigned by SORTING the collected names, never by the order
//    they were discovered in. Discovery order depends on file order and on
//    which monster happens to be listed first in the game data; a sort means
//    the same input always yields the same table, and a game-data update shows
//    up as a reviewable diff instead of silently renumbering the world.
//
// Usage:  node tools/genBuffTypes.mjs          # write the generated file
//         node tools/genBuffTypes.mjs --stdout # print it, write nothing
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "src/combatsimulator/data");
const ENGINE_DIR = path.join(ROOT, "src/combatsimulator");
const OUT_PATH = path.join(ROOT, "src/combatsimulator/generated/buffTypes.js");

const PREFIX = "/buff_types/";

// Digits ARE in the class. See the header.
const HRID_PATTERN = /\/buff_types\/[A-Za-z0-9_]+/g;

/** Scan a blob of source text for buff-type hrid literals. */
export function scanHrids(text) {
    return text.match(HRID_PATTERN) ?? [];
}

/** Walk a parsed JSON tree and collect every string value that names a buff type. */
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
        // Keys can name buff types too (permanentBuffs is keyed by typeHrid).
        for (const key of Object.keys(node)) {
            if (key.startsWith(PREFIX) && key.length > PREFIX.length) out.add(key);
            walkJson(node[key], out);
        }
    }
    return out;
}

function listFiles(dir, ext, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "generated" || entry.name === "data") continue;
            listFiles(full, ext, acc);
        } else if (entry.name.endsWith(ext)) {
            acc.push(full);
        }
    }
    return acc;
}

export function collect() {
    const found = new Set();

    // 1. The game data maps, walked structurally.
    for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort()) {
        walkJson(JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")), found);
    }

    // 2. Buff types the engine names as literals — the combat-effect buffs
    //    (fury, damage-taken and so on) that no data map declares because the
    //    engine synthesises them.
    for (const file of listFiles(ENGINE_DIR, ".js").sort()) {
        for (const hrid of scanHrids(fs.readFileSync(file, "utf8"))) found.add(hrid);
    }

    // 3. The game's own buff-type vocabulary, from the localisation table. This
    //    is a superset source on purpose: a type that exists in the game but
    //    that no bundled data map happens to mention today would otherwise be
    //    absent, and an absent type is a THROW at runtime (see buffTypeOrdinal).
    //    Better to carry a few unused ordinals than to reject a real buff.
    const i18nPath = path.join(ROOT, "js/i18n.js");
    if (fs.existsSync(i18nPath)) {
        for (const hrid of scanHrids(fs.readFileSync(i18nPath, "utf8"))) found.add(hrid);
    }

    // 4. The one site that BUILDS a buff-type hrid by concatenation rather than
    //    writing it out: combatUnit.js's LEVEL_STATS table does
    //    "/buff_types/" + stat + "_level". A text scan cannot see those, so
    //    they are named here explicitly.
    for (const stat of ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]) {
        found.add(PREFIX + stat + "_level");
    }

    return [...found].sort();
}

export function render(names) {
    const lines = [];
    lines.push("// =============================================================================");
    lines.push("// GENERATED FILE — DO NOT EDIT BY HAND.");
    lines.push("//");
    lines.push("// Produced by tools/genBuffTypes.mjs; see that file for why this is generated");
    lines.push("// rather than typed, and api/tests/buffTypes.test.mjs, which re-runs the");
    lines.push("// generator and compares this file byte for byte. Regenerate with:");
    lines.push("//");
    lines.push("//     node tools/genBuffTypes.mjs");
    lines.push("//");
    lines.push("// Ordinals are assigned by sorting the hrids, so the table is a pure function");
    lines.push("// of the game data and a data update lands as a reviewable diff.");
    lines.push("// =============================================================================");
    lines.push("");
    lines.push("/** ordinal -> buff-type hrid. */");
    lines.push("export const BUFF_TYPE_NAMES = Object.freeze([");
    for (const name of names) lines.push(`    ${JSON.stringify(name)},`);
    lines.push("]);");
    lines.push("");
    lines.push("/** buff-type hrid -> ordinal. Null-prototype: no inherited keys to shadow. */");
    lines.push("export const BUFF_TYPE = Object.freeze(Object.assign(Object.create(null), {");
    names.forEach((name, i) => lines.push(`    ${JSON.stringify(name)}: ${i},`));
    lines.push("}));");
    lines.push("");
    lines.push("export const BUFF_TYPE_COUNT = " + names.length + ";");
    lines.push("");
    lines.push("/**");
    lines.push(" * Intern a buff-type hrid. An hrid this table has never seen MUST throw:");
    lines.push(" * returning undefined would index the dense boost arrays at `undefined`,");
    lines.push(" * silently contributing nothing, and the simulation would report a plausible");
    lines.push(" * but wrong number with no error anywhere. Regenerate the table instead.");
    lines.push(" */");
    lines.push("export function buffTypeOrdinal(typeHrid) {");
    lines.push("    const ordinal = BUFF_TYPE[typeHrid];");
    lines.push("    if (ordinal === undefined) {");
    lines.push("        throw new Error(");
    lines.push("            \"Unknown buff type: \" + typeHrid +");
    lines.push("            \" — regenerate src/combatsimulator/generated/buffTypes.js\" +");
    lines.push("            \" with `node tools/genBuffTypes.mjs`\"");
    lines.push("        );");
    lines.push("    }");
    lines.push("    return ordinal;");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
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
        process.stderr.write(`wrote ${path.relative(ROOT, OUT_PATH)} (${collect().length} buff types)\n`);
    }
}

export { OUT_PATH };
