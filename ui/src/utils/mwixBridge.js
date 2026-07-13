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
//       maze?: { enabled }
//     },
//     source, version, monsterHrid, loadout?: { name, ... }
//   }
//
// This mirrors the inline bridge in the old webpack UI (csim/index.html,
// the `mwiLabBridge` IIFE) — keep the two in sync if the protocol changes.
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
