// =============================================================================
// schema — the trust boundary for tool arguments a model wrote.
//
// Handles the JSON-Schema subset the tools use: type (or a union of types),
// enum, items, maxItems, required, and no unknown keys. It is forgiving where
// small models are sloppy and strict where a wrong value would edit state:
//   - numeric strings become numbers ("3" → 3);
//   - enum strings are normalised (case, spaces/hyphens → _, an hrid prefix
//     dropped), so "Main Hand" and "/equipment_types/main_hand" are main_hand;
//   - a scalar where an array is expected becomes [scalar];
//   - null for an optional, non-nullable key counts as "not given".
// minimum/maximum are hints for the model only; tools clamp in `apply`.
// Pure: no React, no browser globals.
// =============================================================================

const typesOf = (schema) => (Array.isArray(schema.type) ? schema.type : [schema.type]);

export const normaliseEnum = (v) =>
  String(v).trim().toLowerCase().split('/').pop().replace(/[\s-]+/g, '_');

function coerce(schema, value, path) {
  const types = typesOf(schema);
  if (value === null) {
    return types.includes('null') ? { value } : { error: `${path} cannot be null.` };
  }
  if (types.includes('array')) {
    const list = Array.isArray(value) ? value : [value];
    if (schema.maxItems != null && list.length > schema.maxItems) {
      return { error: `${path} takes at most ${schema.maxItems} entries.` };
    }
    const out = [];
    for (const [i, item] of list.entries()) {
      const r = coerce(schema.items || {}, item, `${path}[${i}]`);
      if (r.error) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  const numeric = types.includes('integer') || types.includes('number');
  if (numeric && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    value = Number(value);
  }
  if (typeof value === 'number') {
    if (types.includes('integer') && Number.isInteger(value)) return { value };
    if (types.includes('number') && Number.isFinite(value)) return { value };
  }
  if (typeof value === 'string' && types.includes('string')) {
    if (!schema.enum) return { value };
    const v = normaliseEnum(value);
    return schema.enum.includes(v)
      ? { value: v }
      : { error: `${path} must be one of: ${schema.enum.join(', ')}.` };
  }
  if (typeof value === 'boolean' && types.includes('boolean')) return { value };
  const want = types.filter(t => t !== 'null').join(' or ');
  return { error: `${path} must be ${schema.enum ? `one of: ${schema.enum.join(', ')}` : `a ${want}`}.` };
}

/** @returns {{value: object, errors: string[]}} */
export function validateArgs(schema, args) {
  const errors = [];
  const props = schema.properties || {};
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { value: {}, errors: ['Arguments must be an object.'] };
  }
  const value = {};
  for (const [key, raw] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      const allowed = Object.keys(props);
      errors.push(`Unknown argument '${key}'. Allowed: ${allowed.length ? allowed.join(', ') : 'none'}.`);
      continue;
    }
    if (raw === null && !typesOf(prop).includes('null')) continue;
    const r = coerce(prop, raw, key);
    if (r.error) errors.push(r.error);
    else value[key] = r.value;
  }
  for (const key of schema.required || []) {
    if (!(key in value) && !errors.some(e => e.startsWith(`${key} `))) errors.push(`Missing required argument '${key}'.`);
  }
  return { value, errors };
}
