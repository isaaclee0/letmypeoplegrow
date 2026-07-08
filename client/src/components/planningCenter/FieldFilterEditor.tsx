import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { integrationsAPI } from '../../services/api';
import { usePcoRefreshPoll } from '../../hooks/usePcoRefreshPoll';

export interface FieldDefinition {
  id: string;
  name: string;
  dataType: string;
  tabName: string | null;
}

export interface FieldFilterRule {
  fieldDefinitionId: string;
  tabName: string | null;
  fieldName: string;
  values: string[];
}

function fieldLabel(d: FieldDefinition): string {
  return d.tabName ? `${d.tabName} — ${d.name}` : d.name;
}

// Tabless fields sort after every tab group; within a group (or the tabless group),
// fields are alphabetical by name.
function sortDefinitions(definitions: FieldDefinition[]): FieldDefinition[] {
  return [...definitions].sort((a, b) => {
    if (!!a.tabName !== !!b.tabName) return a.tabName ? -1 : 1;
    const tabCompare = (a.tabName || '').localeCompare(b.tabName || '', undefined, { sensitivity: 'base' });
    if (tabCompare !== 0) return tabCompare;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

// Searchable/filterable replacement for a plain <select> — the field list can run
// into dozens of custom-tab fields across many tabs, so a type-to-filter combobox
// keeps it usable.
function FieldPicker({
  definitions,
  selectedId,
  onSelect,
}: {
  definitions: FieldDefinition[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = definitions.find((d) => d.id === selectedId) || null;
  const filtered = query.trim() === ''
    ? definitions
    : definitions.filter((d) => fieldLabel(d).toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Combobox value={selected} onChange={(d: FieldDefinition | null) => onSelect(d ? d.id : '')} onClose={() => setQuery('')}>
      <div className="relative flex-1">
        <ComboboxInput
          className="w-full text-sm rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          displayValue={(d: FieldDefinition | null) => (d ? fieldLabel(d) : '')}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search custom fields…"
        />
        <ComboboxOptions
          anchor="bottom start"
          className="z-10 w-[var(--input-width)] mt-1 max-h-60 overflow-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg empty:invisible [--anchor-gap:4px]"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matching fields.</div>
          ) : (
            filtered.map((d) => (
              <ComboboxOption
                key={d.id}
                value={d}
                className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100 cursor-pointer data-focus:bg-green-50 dark:data-focus:bg-gray-700"
              >
                {fieldLabel(d)}
              </ComboboxOption>
            ))
          )}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}

// Searchable multi-select dropdown for a field's possible values — a field can have
// dozens of options (e.g. a long dropdown/checkbox list in PCO), so this stays closed
// by default and lets the admin type to filter rather than scrolling a long checklist.
function ValuePicker({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; count: number }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = query.trim() === ''
    ? options
    : options.filter((o) => o.value.toLowerCase().includes(query.trim().toLowerCase()));

  const summary = selected.length === 0
    ? 'Select values…'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} values selected`;

  return (
    <Popover className="relative">
      <PopoverButton className="w-full flex items-center justify-between gap-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 px-3 py-2 text-left">
        <span className={`truncate ${selected.length === 0 ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
          {summary}
        </span>
        <ChevronDownIcon className="h-4 w-4 text-gray-400 shrink-0" />
      </PopoverButton>
      <PopoverPanel
        anchor="bottom start"
        className="z-10 w-[var(--button-width)] mt-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg [--anchor-gap:4px]"
      >
        <div className="p-2 border-b border-gray-200 dark:border-gray-700">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search values…"
            autoFocus
            className="w-full text-sm rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <ul className="max-h-60 overflow-auto divide-y divide-gray-100 dark:divide-gray-700">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matching values.</li>
          ) : (
            filtered.map((v) => (
              <li key={v.value}>
                <label className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                  <span className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={selected.includes(v.value)}
                      onChange={() => onToggle(v.value)}
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500 shrink-0"
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate">{v.value}</span>
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{v.count}</span>
                </label>
              </li>
            ))
          )}
        </ul>
      </PopoverPanel>
    </Popover>
  );
}

interface Props {
  rules: FieldFilterRule[];
  onChange: (next: FieldFilterRule[]) => void;
  // Read as a useEffect dependency, so pass a stable/memoized callback (e.g. a useState
  // setter) — an unstable reference will trigger unnecessary re-renders.
  onRefreshingChange?: (refreshing: boolean) => void;
}

export default function FieldFilterEditor({ rules, onChange, onRefreshingChange }: Props) {
  const [definitions, setDefinitions] = useState<FieldDefinition[]>([]);
  const [definitionsLoading, setDefinitionsLoading] = useState(true);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [definitionsRefreshing, setDefinitionsRefreshing] = useState(false);
  // Per-field-definition value tally state, loaded lazily when a field is chosen.
  // Keyed by fieldDefinitionId (not array index) so it stays valid when rules are reordered/removed.
  const [valueOptions, setValueOptions] = useState<Record<string, { value: string; count: number }[]>>({});
  const [valueLoading, setValueLoading] = useState<Record<string, boolean>>({});
  const [valueError, setValueError] = useState<Record<string, string | null>>({});

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Mirrors `definitions` so the stable (useCallback'd) loadDefinitions below can check
  // "do we already have data?" without depending on (and going stale relative to) state.
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  const loadDefinitions = useCallback(() => {
    setDefinitionsError(null);
    return integrationsAPI.getPlanningCenterFieldDefinitions()
      .then((res) => {
        if (!mountedRef.current) return;
        setDefinitions(res.data.definitions || []);
        setDefinitionsRefreshing(!!res.data.refreshing);
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        setDefinitionsRefreshing(false);
        // A background refresh failure shouldn't clobber an already-populated list with
        // a hard error screen — only surface the error when there's no data to preserve
        // (i.e. this was the initial load, not a background refresh of a populated list).
        if (definitionsRef.current.length === 0) {
          setDefinitionsError(e.response?.data?.error || 'Failed to load custom fields.');
        }
      })
      .finally(() => { if (mountedRef.current) setDefinitionsLoading(false); });
  }, []);

  useEffect(() => {
    setDefinitionsLoading(true);
    loadDefinitions();
  }, [loadDefinitions]);

  usePcoRefreshPoll(definitionsRefreshing, loadDefinitions);

  useEffect(() => {
    onRefreshingChange?.(definitionsRefreshing);
    return () => onRefreshingChange?.(false);
  }, [definitionsRefreshing, onRefreshingChange]);

  const loadValuesForRule = (fieldDefinitionId: string) => {
    setValueLoading((prev) => ({ ...prev, [fieldDefinitionId]: true }));
    setValueError((prev) => ({ ...prev, [fieldDefinitionId]: null }));
    integrationsAPI.getPlanningCenterFieldSummary(fieldDefinitionId)
      .then((res) => {
        setValueOptions((prev) => ({ ...prev, [fieldDefinitionId]: res.data.values || [] }));
      })
      .catch((e) => {
        setValueError((prev) => ({ ...prev, [fieldDefinitionId]: e.response?.data?.error || 'Failed to load field values.' }));
      })
      .finally(() => {
        setValueLoading((prev) => ({ ...prev, [fieldDefinitionId]: false }));
      });
  };

  const sortedDefinitions = sortDefinitions(definitions);
  const usedFieldIds = new Set(rules.map((r) => r.fieldDefinitionId));

  const addRule = () => {
    onChange([...rules, { fieldDefinitionId: '', tabName: null, fieldName: '', values: [] }]);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const setRuleField = (index: number, fieldDefinitionId: string) => {
    const def = definitions.find((d) => d.id === fieldDefinitionId);
    const next = rules.map((r, i) => (i === index ? { fieldDefinitionId, tabName: def?.tabName ?? null, fieldName: def?.name ?? '', values: [] } : r));
    onChange(next);
    if (fieldDefinitionId) loadValuesForRule(fieldDefinitionId);
  };

  const toggleRuleValue = (index: number, value: string) => {
    const rule = rules[index];
    const has = rule.values.includes(value);
    const nextValues = has ? rule.values.filter((v) => v !== value) : [...rule.values, value];
    onChange(rules.map((r, i) => (i === index ? { ...r, values: nextValues } : r)));
  };

  if (definitionsLoading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading custom fields…</p>;
  }
  if (definitionsError) {
    return <div className="text-sm text-red-600 dark:text-red-400">{definitionsError}</div>;
  }
  if (!definitions.length) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No dropdown or checkbox custom fields found in Planning Center.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        A person is eligible via this filter only if every rule below matches (AND).
      </p>
      {rules.map((rule, index) => {
        // Defensive: a blank/null value should never reach here (the backend now
        // normalizes it to the '(none)' bucket), but filter it out just in case so a
        // stray falsy entry never renders as an unlabeled, unintentionally-selectable row.
        const options = (valueOptions[rule.fieldDefinitionId] || []).filter((v) => v.value);
        const loadingValues = !!valueLoading[rule.fieldDefinitionId];
        const error = valueError[rule.fieldDefinitionId];
        return (
          <div key={rule.fieldDefinitionId || `empty-${index}`} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <FieldPicker
                definitions={sortedDefinitions.filter((d) => d.id === rule.fieldDefinitionId || !usedFieldIds.has(d.id))}
                selectedId={rule.fieldDefinitionId}
                onSelect={(id) => setRuleField(index, id)}
              />
              <button
                type="button"
                onClick={() => removeRule(index)}
                className="text-sm text-red-600 dark:text-red-400 hover:underline shrink-0"
              >
                Remove
              </button>
            </div>
            {rule.fieldDefinitionId && loadingValues && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Loading values…</p>
            )}
            {rule.fieldDefinitionId && error && (
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            )}
            {rule.fieldDefinitionId && !loadingValues && !error && (
              <ValuePicker
                options={options}
                selected={rule.values}
                onToggle={(value) => toggleRuleValue(index, value)}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRule}
        disabled={usedFieldIds.size >= definitions.length}
        className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
      >
        Add field filter
      </button>
    </div>
  );
}
