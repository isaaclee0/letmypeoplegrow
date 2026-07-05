import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  useEffect(() => () => { mountedRef.current = false; }, []);

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
        const options = valueOptions[rule.fieldDefinitionId] || [];
        const loadingValues = !!valueLoading[rule.fieldDefinitionId];
        const error = valueError[rule.fieldDefinitionId];
        return (
          <div key={rule.fieldDefinitionId || `empty-${index}`} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <select
                value={rule.fieldDefinitionId}
                onChange={(e) => setRuleField(index, e.target.value)}
                className="flex-1 text-sm rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="">Select a custom field…</option>
                {definitions
                  .filter((d) => d.id === rule.fieldDefinitionId || !usedFieldIds.has(d.id))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.tabName ? `${d.tabName} — ${d.name}` : d.name}
                    </option>
                  ))}
              </select>
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
              <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
                {options.map((v) => (
                  <li key={v.value} className="flex items-center justify-between px-3 py-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.values.includes(v.value)}
                        onChange={() => toggleRuleValue(index, v.value)}
                        className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <span className="text-sm text-gray-900 dark:text-gray-100">{v.value}</span>
                    </label>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{v.count}</span>
                  </li>
                ))}
              </ul>
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
