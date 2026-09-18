// =============================================================================
// mwixBridge — receives "Open in csim" payloads from the MWIX userscript.
//
// The in-game launcher (tampermonkey/src/kernel/sim-launch.js) opens this UI
// with `#mwiLabBridge=<encoded>` in the URL. The encoding is
// `json:` + encodeURIComponent(JSON.stringify(payload)); the decoder below
// also accepts the legacy plain encodeURIComponent(JSON) form. (`lz:`
// payloads are not supported here — the sender deliberately emits `json:`
// only; see the comment in sim-launch.js.)
//
// Payload shape:
//   {
//     importSet,            // same schema as ImportExport's solo format
//     mwixContext?: {
//       labUpgrades?: { combatDamage, attackSpeed, castSpeed, criticalRate },
//       maze?: { enabled },
//       guildShrines?: { [guildBuffHrid]: level }   // the character's shrine
//                                                  // levels, e.g.
//                                                  // "/guild_buffs/force_combat": 4
//     },
//     source, version, monsterHrid, loadout?: { name, ... }
//   }
//
// The inline bridge in the old webpack UI (csim/index.html, the
// `mwiLabBridge` IIFE) speaks the same PARAM but is NOT the same decoder, and
// no longer pretends to be: it decodes `lz:` through LZString, tries LZString
// first on the legacy plain form, polls for up to 8 s waiting for its own DOM
// to be ready, and re-runs on `hashchange`. This file does none of those. That
// divergence is deliberate — index.html is upstream-owned and frozen (see
// ui/README.md), so it is not kept in step, and THIS file is canonical for the
// React UI. Do not "reconcile" them.
//
// A roster, as opposed to one character, comes through a different door:
// utils/rosterBridge.js, at `#rosterBridge=`.
// =============================================================================

const PARAM = 'mwiLabBridge';

function getRawHashValue() {
  // Parse the hash manually rather than via URLSearchParams: the latter
  // treats `+` as a space, which would corrupt legacy payloads.
  const raw = String(window.location.hash || '').replace(/^#/, '');
  if (!raw) return null;
  const re = new RegExp('(?:^|&)' + PARAM + '=([^&]*)');
  const m = raw.match(re);
  return m ? m[1] : null;
}

function decodePayload(value) {
  if (!value) return null;
  if (value.startsWith('json:')) {
    try {
      return JSON.parse(decodeURIComponent(value.slice(5)));
    } catch (err) {
      console.error('[mwix-bridge] json: decode failed', err);
      return null;
    }
  }
  if (value.startsWith('lz:')) {
    console.error('[mwix-bridge] lz: payloads are not supported by the React UI — use json: encoding');
    return null;
  }
  // Legacy plain encoding: encodeURIComponent(JSON).
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch (err) {
    console.error('[mwix-bridge] legacy decode failed', err);
    return null;
  }
}

/** Read and decode the MWIX payload from the current URL hash, or null. */
export function readMwixBridgePayload() {
  try {
    return decodePayload(getRawHashValue());
  } catch (err) {
    console.error('[mwix-bridge] readMwixBridgePayload threw:', err);
    return null;
  }
}

/** Remove the bridge parameter from the URL without reloading. */
export function clearMwixBridgeHash() {
  try {
    const url = new URL(window.location.href);
    const raw = String(url.hash || '').replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    params.delete(PARAM);
    const tail = params.toString();
    url.hash = tail ? '#' + tail : '';
    history.replaceState(null, '', url.toString());
  } catch {
    /* noop */
  }
}
