// =============================================================================
// genBuffTypes — collect(): every buff-type hrid, sorted, for BUFF_TYPE_NAMES in
// rust/src/generated.rs (tools/genRustTables.mjs). A list wrong by omission gives
// wrong combat numbers with no error, so it is derived, not typed: the game data
// is walked STRUCTURALLY (no character-class bug possible), the Rust engine's
// literals are scanned with a pattern whose class includes DIGITS (hpRegenPer10
// was once lost to one that did not), and the names are SORTED, so a data update
// is a reviewable diff, not a renumbering.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "src/combatsimulator/data");
// The Rust engine names the synthesised buff types as literals.
const ENGINE_DIR = path.join(ROOT, "rust/src");

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
        } else if (entry.name.endsWith(ext) && entry.name !== "generated.rs") { // its BUFF_TYPE_NAMES is this table's output
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
    for (const file of listFiles(ENGINE_DIR, ".rs").sort()) {
        for (const hrid of scanHrids(fs.readFileSync(file, "utf8"))) found.add(hrid);
    }

    // 3. Real game buff types that no bundled data map mentions today. An
    //    absent type is a THROW at runtime (see buffTypeOrdinal), so carry a
    //    few unused ordinals rather than reject a real buff. These came from
    //    the game's localisation table, which left with the legacy UI.
    for (const name of ["combat_experience", "essence_find", "mana_leech", "skilling_experience", "task_action_speed"]) {
        found.add(PREFIX + name);
    }

    // 4. The one site that BUILDS a buff-type hrid by concatenation rather than
    //    writing it out: the engine's level stats are
    //    "/buff_types/" + stat + "_level". A text scan cannot see those, so
    //    they are named here explicitly.
    for (const stat of ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]) {
        found.add(PREFIX + stat + "_level");
    }

    return [...found].sort();
}
