import { useState } from 'react';
import { Select as MantineSelect } from '@mantine/core';

// =============================================================================
// Select — Mantine's Select with the modern "type to replace" behaviour for
// searchable fields. Focusing a filled field empties the text box so typing
// starts a fresh search at once, and the full list shows; the current choice
// stays visible as the placeholder. Leaving without picking restores it.
//
// Non-searchable selects, and any caller that controls `searchValue` itself,
// pass straight through to Mantine unchanged.
// =============================================================================

function labelOf(data, value) {
  if (value == null || !Array.isArray(data)) return null;
  for (const entry of data) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      if (entry === value) return entry;
    } else if (Array.isArray(entry.items)) {
      const hit = labelOf(entry.items, value);
      if (hit != null) return hit;
    } else if (entry.value === value) {
      return entry.label ?? entry.value;
    }
  }
  return null;
}

export function Select(props) {
  const {
    searchable,
    searchValue: controlledSearch,
    value: controlledValue,
    defaultValue,
    data,
    placeholder,
    onChange,
    onSearchChange,
    onDropdownOpen,
    onDropdownClose,
    ...rest
  } = props;

  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  // Track the value ourselves only when the caller leaves it uncontrolled.
  const [ownValue, setOwnValue] = useState(defaultValue ?? null);

  if (!searchable || controlledSearch !== undefined) {
    return <MantineSelect {...props} />;
  }

  const value = controlledValue !== undefined ? controlledValue : ownValue;
  const selectedLabel = labelOf(data, value);

  return (
    <MantineSelect
      {...rest}
      searchable
      data={data}
      value={value}
      placeholder={editing && selectedLabel ? selectedLabel : placeholder}
      searchValue={editing ? search : (selectedLabel ?? '')}
      onSearchChange={(v) => {
        if (editing) setSearch(v);
        onSearchChange?.(v);
      }}
      onChange={(v, option) => {
        if (controlledValue === undefined) setOwnValue(v);
        setEditing(false);
        onChange?.(v, option);
      }}
      onDropdownOpen={() => {
        setSearch('');
        setEditing(true);
        onDropdownOpen?.();
      }}
      onDropdownClose={() => {
        setEditing(false);
        onDropdownClose?.();
      }}
    />
  );
}
