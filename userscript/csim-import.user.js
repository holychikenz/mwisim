// ==UserScript==
// @name         csim import — game character → csim
// @namespace    local.holychikenz.csim
// @version      0.1.0
// @description  Captures your character from Milky Way Idle (allowlisted fields only) and hands it to csim. Reload the game to refresh it.
// @author       holychikenz
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://holychikenz.github.io/mwisim/*
// @match        http://localhost:5173/*
// @match        http://127.0.0.1:17645/sim/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// =============================================================================
// On the GAME page: hooks MessageEvent.prototype.data, captures the
// `init_character_data` frame, keeps ONLY the allowlisted keys below and stores
// them with GM_setValue, keyed by the game characterId (players rename; the id
// never changes). The raw frame also carries email, guestPassword, user/userInfo,
// Steam/Kongregate ids and chat history — none of it is ever stored or sent.
//
// On the CSIM page: reads the stored snapshots and posts them to the page with
// window.postMessage (ui/src/utils/snapshotBridge.js validates and stores them).
//
// STALE BUFFS: a snapshot is the character as of the last game load — active
// teas, buffs and gear included. Reload the game tab to refresh it.
// =============================================================================

// What csim reads: mwi-econ character_stats.rs/item_value.rs (item times) and
// ui/src/utils/characterToStore.js (combat import). csim's snapshotBridge.js
// keeps the same list; api/tests/csimImportUserscript.test.mjs checks they agree.
const SNAPSHOT_KEYS = [
    'character', // reduced to { id, name }
    'characterSkills', 'characterItems', 'characterLoadoutMap', 'characterHouseRoomMap',
    'actionTypeDrinkSlotsMap', 'actionTypeFoodSlotsMap', 'noncombatStats',
    'communityActionTypeBuffsMap', 'houseActionTypeBuffsMap', 'achievementActionTypeBuffsMap',
    'consumableActionTypeBuffsMap', 'equipmentActionTypeBuffsMap', 'guildActionTypeBuffsMap',
    'mooPassActionTypeBuffsMap', 'personalActionTypeBuffsMap',
    'characterAbilities', 'abilityCombatTriggersMap', 'consumableCombatTriggersMap',
    'characterAchievements', 'characterGuildBuffMap',
    'characterActions' // the action queue: picks the default loadout on import
];
const MESSAGE_TYPE = 'csim-import:snapshots';
const READY_TYPE = 'csim-import:ready';
const STORE_KEY = 'snapshots';

/** The allowlisted copy of an init_character_data frame, or null when it has no character id. */
function filterCharacterData(frame) {
    const id = frame?.character?.id;
    if (id == null) return null;
    const out = { character: { id, name: frame.character.name } };
    for (const key of SNAPSHOT_KEYS) {
        if (key !== 'character' && Object.prototype.hasOwnProperty.call(frame, key)) out[key] = frame[key];
    }
    return out;
}

function onGamePage() {
    const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (!descriptor?.get) return;
    const oriGet = descriptor.get;
    descriptor.get = function () {
        const message = oriGet.call(this);
        // Fenced: this getter is on the game's wire, and a throw here kills its message pipeline.
        try {
            if (!(this.currentTarget instanceof WebSocket)) return message;
            // MWIX (kernel/ws.js) may have defined this own property non-configurable; never redefine it.
            if (!Object.prototype.hasOwnProperty.call(this, 'data')) {
                Object.defineProperty(this, 'data', { value: message, configurable: true });
            }
            if (typeof message === 'string' && message.includes('"init_character_data"')) {
                const frame = JSON.parse(message);
                const snapshot = frame?.type === 'init_character_data' ? filterCharacterData(frame) : null;
                if (snapshot) {
                    const all = GM_getValue(STORE_KEY, {});
                    all[String(snapshot.character.id)] = snapshot;
                    GM_setValue(STORE_KEY, all);
                }
            }
        } catch (e) {
            try { console.error('[csim-import] ws hook threw (frame delivered regardless)', e); } catch { /* ignore */ }
        }
        return message;
    };
    Object.defineProperty(MessageEvent.prototype, 'data', descriptor);
}

function onCsimPage() {
    const page = unsafeWindow;
    const send = () => page.postMessage({ type: MESSAGE_TYPE, snapshots: GM_getValue(STORE_KEY, {}) }, page.location.origin);
    // csim asks once its listener is up (it may load after this script); a capture in the game tab pushes live.
    page.addEventListener('message', (e) => { if (e.source === page && e.data?.type === READY_TYPE) send(); });
    GM_addValueChangeListener(STORE_KEY, send);
    send();
}

if (typeof module !== 'undefined') {
    module.exports = { SNAPSHOT_KEYS, MESSAGE_TYPE, READY_TYPE, filterCharacterData }; // node --test
} else if (/milkywayidle(cn)?\.com$/.test(location.hostname)) {
    onGamePage();
} else {
    onCsimPage();
}
