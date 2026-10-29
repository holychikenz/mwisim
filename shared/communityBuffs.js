// =============================================================================
// communityBuffs — the community / MooPass buffs every sim mode shares, built
// from the UI's `extra` flags. One copy for the browser worker (src/worker.js)
// and the API (api/lib/simulator.js buildExtraBuffs). Seals and shrines are per
// character and ride on each player DTO's own `extraBuffs` instead.
// =============================================================================

const buff = (uniqueHrid, typeHrid, flatBoost) => ({
  uniqueHrid,
  typeHrid,
  ratioBoost: 0,
  ratioBoostLevelBonus: 0,
  flatBoost,
  flatBoostLevelBonus: 0,
  startTime: '0001-01-01T00:00:00Z',
  duration: 0,
});

/** @param {{ mooPass?: boolean, comExp?: number, comDrop?: number }} [extra] */
export function buildCommunityBuffs(extra = {}) {
  const buffs = [];
  if (extra.mooPass) buffs.push(buff('/buff_uniques/experience_moo_pass_buff', '/buff_types/wisdom', 0.05));
  if (extra.comExp > 0) {
    buffs.push(buff('/buff_uniques/experience_community_buff', '/buff_types/wisdom', 0.005 * (extra.comExp - 1) + 0.2));
  }
  if (extra.comDrop > 0) {
    buffs.push(buff('/buff_uniques/combat_community_buff', '/buff_types/combat_drop_quantity', 0.005 * (extra.comDrop - 1) + 0.2));
  }
  return buffs;
}
