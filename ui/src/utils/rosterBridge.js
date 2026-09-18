// =============================================================================
// rosterBridge — receives a whole GUILD TRIAL ROSTER from SCLIRoster's
// dashboard, through the URL fragment.
// -----------------------------------------------------------------------------
// The sender is `optimizer/src/model/rosterLink.js` in the SCLIRoster repo; the
// dashboard renders a plain <a href> at `#rosterBridge=gz:<base64url>`. What
// arrives is the same object the dashboard's "copy roster JSON" button copies
// and `handleImportRoster` already accepts: `{ masterBuilds, roster,
// trialConfig? }`. THESE TWO FILES ARE ONE PROTOCOL IN TWO REPOSITORIES — if
// this decoder moves or changes shape, rosterLink.js moves with it.
//
// Why gzip and not something simpler. A real 52-seat roster measures:
//     raw JSON                    189 483 chars
//     lz-string (URI-safe)         47 371 chars
//     gzip + base64url             13 539 chars
// The binding constraint is not Chrome (2 MB fragment cap) but Firefox, whose
// practical URL ceiling is around 65 000 characters. lz-string clears that by
// only 1.4x on the worst payload we have; gzip clears it by 4.4x. The sender
// refuses to emit a link past 60 000 characters rather than hand the reader a
// URL that silently truncates — a dead link is worse than no button.
//
// Why the hash is parsed by regex and not URLSearchParams. mwixBridge.js
// records the trap: URLSearchParams decodes `+` as a space, which quietly
// corrupts any payload whose alphabet contains it. base64url has no `+` — the
// whole point of the alphabet — so this decoder is not itself exposed. The
// rule is kept anyway, because the next payload format to come through this
// door will not be asked whether it is `+`-free first.
//
// Why the hash is cleared after consuming. The fragment is part of the URL,
// so clicking the same dashboard link a second time navigates to a URL the
// browser already shows: no load, no `hashchange`, nothing happens. Clearing
// it on consumption means the next click is always a change, and always fires.
// That is also why the caller listens for `hashchange` and not just mount.
//
// Everything here is PURE apart from `clearRosterLinkHash` — no imports, no
// module-level browser access — so SCLIRoster's Node-side boundary test can
// import this file directly and run the real decoder against the real encoder.
// =============================================================================

export const ROSTER_LINK_PARAM = 'rosterBridge';

/**
 * Pull the raw parameter value out of a location hash string.
 * Pure: the caller passes `window.location.hash`.
 * @param {string} hash
 * @returns {string|null}
 */
export function readRosterLinkValue(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const m = raw.match(new RegExp('(?:^|&)' + ROSTER_LINK_PARAM + '=([^&]*)'));
  return m ? m[1] : null;
}

/**
 * `gz:<base64url(gzip(JSON))>` -> the parsed payload.
 * Throws with a message meant to be shown to a human: the alert that renders
 * it is the only feedback the reader gets.
 * @param {string} value
 */
export async function decodeRosterLinkValue(value) {
  const raw = String(value || '');
  if (!raw.startsWith('gz:')) {
    throw new Error('unrecognised roster link encoding (expected gz:)');
  }
  if (typeof DecompressionStream !== 'function') {
    // Safari gained this in 16.4. Naming the browser is more use to the reader
    // than "decompression unavailable", because the fix is to open it elsewhere.
    throw new Error('this browser cannot decompress the link (needs DecompressionStream)');
  }

  // base64url -> standard base64: the alphabet swap, then the padding the
  // sender dropped (Buffer#toString('base64url') is unpadded by definition).
  let b64 = raw.slice(3).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';

  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new Error('the link is damaged (base64 would not decode)');
  }

  let text;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } catch {
    throw new Error('the link is damaged (gzip would not decompress)');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the link decoded but is not JSON');
  }
}

/**
 * The same guard GuildTrialPanel's paste box applies, so a pasted payload and
 * a linked payload are rejected on identical grounds.
 * @param {unknown} data
 */
export function validateRosterPayload(data) {
  if (!data || typeof data !== 'object' || !data.masterBuilds || !Array.isArray(data.roster)) {
    throw new Error('Expected { masterBuilds, roster }');
  }
  return data;
}

/**
 * Remove ONLY this parameter from the hash, leaving any other fragment state
 * (the MWIX bridge's own param, an anchor) alone. Never throws: it is called
 * from a `finally`, where a throw would mask the real error.
 */
export function clearRosterLinkHash() {
  try {
    const raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw) return;
    const next = raw
      .replace(new RegExp('(?:^|&)' + ROSTER_LINK_PARAM + '=[^&]*'), '')
      .replace(/^&/, '');
    const url = window.location.pathname + window.location.search + (next ? '#' + next : '');
    window.history.replaceState(null, '', url);
  } catch {
    /* a URL we cannot rewrite is not worth failing an import over */
  }
}
