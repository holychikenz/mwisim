// Names, not hrids: the one place a result view turns an engine id into the
// name a player knows. `playerN` → the party member's name (or "PN"); any other
// hrid → its monster / item / ability name; failing that, its last path
// segment with underscores (and camelCase) as spaces and a capital first letter.
export function nameOf(hrid, { playerNames, monsters, items, abilities } = {}) {
  const id = String(hrid ?? '');
  const player = /^player(\d+)$/.exec(id);
  if (player) return playerNames?.[id] || `P${player[1]}`;
  const known = monsters?.[id]?.name || items?.[id]?.name || abilities?.[id]?.name;
  if (known) return known;
  const tail = id.split('/').pop().replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`);
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}
