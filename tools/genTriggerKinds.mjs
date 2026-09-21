#!/usr/bin/env node
// =============================================================================
// Generates src/combatsimulator/generated/triggerKinds.js — the condition-hrid
// to condition-KIND ordinal table Trigger's constructor reads, and the KIND_*
// constants getDependencyValue switches on.
//
// WHY. getDependencyValue was a ~50-case string switch and held 8.2% of engine
// self time. Its 55 handled conditions fall into only NINE distinct arms, so
// interning the condition once, at construction, turns the switch into nine
// integer compares. todo.md §6a sized this at about 3% and deliberately
// deferred it until a differential harness existed; api/eval now is one.
//
// THREE DELIBERATE CHOICES, in the shape genTriggerIndex.mjs states its own.
//
//  * The grouping is READ FROM THE ENGINE SOURCE, not re-derived from the game
//    data — the precedent is genStatSchema.mjs's role lists, and the reason is
//    the same. Which conditions read their buff by EXACT hrid and which by
//    PREFIX is a property of getDependencyValue, not of the bestiary: the two
//    sets are distinguishable in the data only by a pattern that would be a
//    guess, and a wrong guess reads a DIFFERENT buff and reports a plausible
//    wrong number with no error. trigger.js's EXACT_BUFF_CONDITIONS,
//    PREFIX_BUFF_CONDITIONS and SCALAR_CONDITION_KINDS were themselves
//    extracted mechanically from the string switch they replaced, not retyped.
//
//  * The table is SORTED and the kind ordinals come from a sort of the kind
//    NAMES, not from discovery order — so the file is a pure function of its
//    input and an engine change lands as a reviewable diff rather than a silent
//    renumbering. Same rule as generated/buffTypes.js.
//
//  * An unseen condition maps to KIND_UNKNOWN = 0 and does NOT throw here.
//    That is not the buffTypes rule, and the difference is deliberate:
//    getDependencyValue's `default:` arm already throws "Unknown conditionHrid
//    in trigger", at EVALUATION, and KIND_UNKNOWN routes straight to it, so the
//    loud failure survives at exactly the site and the moment it had before.
//    Throwing at construction instead would break api/lib/triggerSearch, which
//    builds Trigger objects speculatively — the same argument that made
//    genTriggerIndex.mjs fall back rather than throw. Note this is load-bearing
//    for three real conditions: lowest_hp_percentage, number_of_active_units
//    and number_of_dead_units are handled in isActiveMultiTarget and never
//    reach getDependencyValue, so they are legitimately unknown to this table.
//
// Usage:  node tools/genTriggerKinds.mjs          # write the generated file
//         node tools/genTriggerKinds.mjs --stdout # print it, write nothing
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRIGGER_PATH = path.join(ROOT, "src/combatsimulator/trigger.js");
const OUT_PATH = path.join(ROOT, "src/combatsimulator/generated/triggerKinds.js");

// Digits ARE in the class, for the reason genBuffTypes.mjs states: a pattern
// that drops them is how this project once lost hpRegenPer10 and mpRegenPer10.
const HRID = "\\/combat_trigger_conditions\\/[A-Za-z0-9_]+";

/**
 * Pull `export const NAME = [ "...", ... ];` out of the engine source. Bounded
 * by its own closing bracket, so a later list cannot leak into an earlier one.
 */
export function extractList(source, name) {
    const open = source.indexOf(`export const ${name} = [`);
    if (open < 0) throw new Error(`${name} not found in trigger.js`);
    const close = source.indexOf("];", open);
    if (close < 0) throw new Error(`${name} is unterminated in trigger.js`);
    if (source.indexOf(`export const ${name} = [`, open + 1) >= 0) {
        throw new Error(`${name} is declared twice in trigger.js`);
    }
    const body = source.slice(open, close);
    const hrids = (body.match(new RegExp(`"(${HRID})"`, "g")) ?? []).map((s) => s.slice(1, -1));
    if (hrids.length === 0) throw new Error(`${name} is empty in trigger.js`);
    return hrids;
}

/** Pull `export const SCALAR_CONDITION_KINDS = { "hrid": "KIND", ... };`. */
export function extractScalarKinds(source) {
    const name = "SCALAR_CONDITION_KINDS";
    const open = source.indexOf(`export const ${name} = {`);
    if (open < 0) throw new Error(`${name} not found in trigger.js`);
    const close = source.indexOf("};", open);
    if (close < 0) throw new Error(`${name} is unterminated in trigger.js`);
    const body = source.slice(open, close);
    const pairs = [...body.matchAll(new RegExp(`"(${HRID})"\\s*:\\s*"([A-Z0-9_]+)"`, "g"))];
    if (pairs.length === 0) throw new Error(`${name} is empty in trigger.js`);
    return pairs.map((m) => [m[1], m[2]]);
}

export function collect() {
    const source = fs.readFileSync(TRIGGER_PATH, "utf8");
    const exact = extractList(source, "EXACT_BUFF_CONDITIONS");
    const prefix = extractList(source, "PREFIX_BUFF_CONDITIONS");
    const scalars = extractScalarKinds(source);

    const byCondition = new Map();
    const assign = (hrid, kind) => {
        if (byCondition.has(hrid)) {
            throw new Error(`${hrid} is in two groups: ${byCondition.get(hrid)} and ${kind}`);
        }
        byCondition.set(hrid, kind);
    };
    for (const hrid of exact) assign(hrid, "EXACT_BUFF");
    for (const hrid of prefix) assign(hrid, "PREFIX_BUFF");
    for (const [hrid, kind] of scalars) assign(hrid, kind);

    // Ordinals from a sort of the NAMES, never from discovery order.
    const kinds = [...new Set(byCondition.values())].sort();
    return { kinds, conditions: [...byCondition.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}

export function render({ kinds, conditions }) {
    const L = [];
    L.push("// =============================================================================");
    L.push("// GENERATED FILE — DO NOT EDIT BY HAND.");
    L.push("//");
    L.push("// Produced by tools/genTriggerKinds.mjs from the grouping lists in");
    L.push("// src/combatsimulator/trigger.js; see that file for why the grouping is read");
    L.push("// from the engine rather than derived from the game data, and");
    L.push("// api/tests/triggerKinds.test.mjs, which re-runs the generator and compares");
    L.push("// this file byte for byte. Regenerate with:");
    L.push("//");
    L.push("//     node tools/genTriggerKinds.mjs");
    L.push("//");
    L.push("// Kind ordinals come from a sort of the kind NAMES and entries are sorted by");
    L.push("// condition hrid, so this file is a pure function of its input and a change");
    L.push("// lands as a reviewable diff rather than a silent renumbering.");
    L.push("// =============================================================================");
    L.push("");
    L.push("// 0 means \"this table has never seen this condition\". It routes to");
    L.push("// getDependencyValue's `default:` arm, which throws exactly as it always did —");
    L.push("// at evaluation, not at construction, because api/lib/triggerSearch builds");
    L.push("// Trigger objects speculatively. The three multi-target conditions");
    L.push("// (lowest_hp_percentage, number_of_active_units, number_of_dead_units) are");
    L.push("// resolved in isActiveMultiTarget and are legitimately unknown here.");
    L.push("export const KIND_UNKNOWN = 0;");
    kinds.forEach((k, i) => L.push(`export const KIND_${k} = ${i + 1};`));
    L.push("");
    L.push("export const TRIGGER_KIND_COUNT = " + (kinds.length + 1) + ";");
    L.push("");
    L.push("/**");
    L.push(" * condition hrid -> condition kind ordinal.");
    L.push(" * Null-prototype: no inherited keys to shadow a condition named `constructor`.");
    L.push(" */");
    L.push("export const TRIGGER_CONDITION_KIND = Object.freeze(Object.assign(Object.create(null), {");
    for (const [hrid, kind] of conditions) {
        L.push(`    ${JSON.stringify(hrid)}: ${kinds.indexOf(kind) + 1}, // ${kind}`);
    }
    L.push("}));");
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
        const { conditions, kinds } = collect();
        process.stderr.write(
            `wrote ${path.relative(ROOT, OUT_PATH)} (${conditions.length} conditions, ${kinds.length} kinds)\n`
        );
    }
}

export { OUT_PATH };
