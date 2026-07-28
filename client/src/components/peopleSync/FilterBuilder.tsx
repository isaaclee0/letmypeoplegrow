import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addBranch, addGroup, removeBranch, removeExclusionValue, removeGroup, setBranchValueState, setGroupMode } from '../../services/filterConfig';
import type { BooleanFilterConfigV2, FilterDimension, FilterDimensionValue, FilterGroupMode, FilterMetadata, FilterValueState } from './types';

export interface FilterBuilderProps {
  metadata: FilterMetadata;
  value: BooleanFilterConfigV2;
  onChange: (value: BooleanFilterConfigV2) => void;
  disabled?: boolean;
}

function labelFor(value: string, values: readonly FilterDimensionValue[]): string {
  return value === '$not_set' ? 'Not set' : values.find((candidate) => candidate.id === value)?.label || value;
}

function stateFor(config: BooleanFilterConfigV2, dimensionId: string, groupValues: readonly string[], valueId: string): FilterValueState {
  if (config.exclusions.some((exclusion) => exclusion.dimensionId === dimensionId && exclusion.values.includes(valueId))) return 'not';
  return groupValues.includes(valueId) ? 'include' : 'off';
}

function selectedWarnings(config: BooleanFilterConfigV2, metadata: FilterMetadata): string[] {
  const byId = new Map(metadata.dimensions.map((dimension) => [dimension.id, dimension]));
  const selected = [...config.branches.flatMap((branch) => branch.groups), ...config.exclusions];
  return [...new Set(selected.flatMap((group) => {
    const dimension = byId.get(group.dimensionId);
    if (!dimension) return [`The saved filter type “${group.dimensionId}” is no longer available.`];
    return group.values.filter((value) => !dimension.values.some((candidate) => candidate.id === value))
      .map((value) => `The saved ${dimension.label} value “${value}” is no longer available.`);
  }))];
}

function ValueStateControl({ label, state, disabled, onChange, notRef }: {
  label: string;
  state: FilterValueState;
  disabled: boolean;
  onChange: (state: FilterValueState) => void;
  notRef: React.Ref<HTMLButtonElement>;
}) {
  const options: Array<[FilterValueState, string]> = [['off', 'Off'], ['include', 'Include'], ['not', 'NOT']];
  const activate = (next: FilterValueState) => onChange(next);
  return <div role="group" aria-label={`State for ${label}`} className="inline-flex shrink-0 overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
    {options.map(([next, text], index) => <button key={next} ref={next === 'not' ? notRef : undefined} type="button" disabled={disabled}
      onClick={() => activate(next)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(next); } }}
      aria-pressed={state === next} aria-label={`${text} ${label}`} className={`px-2 py-1 text-xs font-medium ${index ? 'border-l border-gray-300 dark:border-gray-600' : ''} ${state === next ? next === 'not' ? 'bg-red-700 text-white' : 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'} disabled:cursor-not-allowed disabled:opacity-50`}>{text}</button>)}
  </div>;
}

function GroupCard({ branchIndex, groupIndex, group, dimension, config, disabled, open, onToggleOpen, onChange, onNotOrigin, notButtonRef }: {
  branchIndex: number;
  groupIndex: number;
  group: { dimensionId: string; mode: FilterGroupMode; values: string[] };
  dimension: FilterDimension | undefined;
  config: BooleanFilterConfigV2;
  disabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (next: BooleanFilterConfigV2) => void;
  onNotOrigin: (key: string) => void;
  notButtonRef: (key: string) => React.Ref<HTMLButtonElement>;
}) {
  const [query, setQuery] = useState('');
  const knownValues = dimension?.values || [];
  const unresolved = group.values.filter((value) => !knownValues.some((candidate) => candidate.id === value));
  const candidates = dimension ? [...knownValues, ...unresolved.map((id) => ({ id, label: id, count: 0 }))] : unresolved.map((id) => ({ id, label: id, count: 0 }));
  const visible = candidates.filter((candidate) => candidate.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const label = dimension?.label || group.dimensionId;
  const mixedNotSet = group.mode === 'all' && group.values.includes('$not_set') && group.values.length > 1;
  const groupKey = `${branchIndex}:${group.dimensionId}`;
  const apply = (valueId: string, state: FilterValueState) => {
    const origin = `${branchIndex}:${group.dimensionId}:${valueId}`;
    if (state === 'not') onNotOrigin(origin);
    onChange(setBranchValueState(config, branchIndex, dimension || group.dimensionId, valueId, state, dimension?.cardinality || 'multi'));
  };
  return <section aria-label={`${label} in Branch ${branchIndex + 1}`} className="space-y-3 rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</h4>{!dimension ? <p className="text-xs text-amber-700 dark:text-amber-300">This saved filter type is unavailable; you can remove it below.</p> : null}</div><div className="flex items-center gap-3"><button type="button" disabled={disabled} onClick={onToggleOpen} aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${label} values`} className="text-sm text-green-800 underline disabled:opacity-50 dark:text-green-300">{open ? 'Close values' : 'Open values'}</button><button type="button" disabled={disabled} onClick={() => onChange(removeGroup(config, branchIndex, groupIndex))} aria-label={`Remove ${label} from Branch ${branchIndex + 1}`} className="text-sm text-gray-600 underline disabled:opacity-50 dark:text-gray-300">Remove</button></div></div>
    {dimension?.cardinality === 'multi' && group.values.length >= 2 && !mixedNotSet ? <div className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600" aria-label={`Match mode for ${label}`}><button type="button" disabled={disabled} onClick={() => onChange(setGroupMode(config, branchIndex, groupIndex, 'any'))} aria-pressed={group.mode === 'any'} aria-label={`Match any for ${label}`} className={`px-2 py-1 text-xs ${group.mode === 'any' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match any</button><button type="button" disabled={disabled} onClick={() => onChange(setGroupMode(config, branchIndex, groupIndex, 'all'))} aria-pressed={group.mode === 'all'} aria-label={`Match all for ${label}`} className={`border-l border-gray-300 px-2 py-1 text-xs dark:border-gray-600 ${group.mode === 'all' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match all</button></div> : null}
    {mixedNotSet ? <p role="alert" className="text-xs text-amber-800 dark:text-amber-200">Not set cannot be combined with Match all; this bracket now matches any selected value.</p> : null}
    {open ? <><label className="block text-xs font-medium text-gray-600 dark:text-gray-300">Search {label} values<input aria-label={`Search ${label} values`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} className="mt-1 block w-full rounded-md border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-900" /></label><div className="space-y-2">{visible.map((candidate) => { const valueLabel = labelFor(candidate.id, knownValues); return <div key={candidate.id} className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 break-words text-sm text-gray-700 dark:text-gray-200">{valueLabel} <span className="text-xs text-gray-500">({candidate.count})</span>{!knownValues.some((value) => value.id === candidate.id) ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">Unavailable</span> : null}</span><ValueStateControl label={valueLabel} state={stateFor(config, group.dimensionId, group.values, candidate.id)} disabled={disabled} notRef={notButtonRef(`${groupKey}:${candidate.id}`)} onChange={(state) => apply(candidate.id, state)} /></div>; })}</div></> : null}
  </section>;
}

export default function FilterBuilder({ metadata, value, onChange, disabled = false }: FilterBuilderProps) {
  const dimensions = useMemo(() => new Map(metadata.dimensions.map((dimension) => [dimension.id, dimension])), [metadata]);
  const [pickerBranch, setPickerBranch] = useState<number | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [restoreKey, setRestoreKey] = useState<string | null>(null);
  const notButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const lastNotOrigin = useRef(new Map<string, string>());
  const warnings = selectedWarnings(value, metadata);
  const exclusions = value.exclusions.flatMap((group) => group.values.map((valueId) => ({ dimensionId: group.dimensionId, valueId })));
  const toggleOpen = (key: string) => setOpenGroups((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const notButtonRef = (key: string) => (element: HTMLButtonElement | null) => { notButtons.current.set(key, element); };
  const rememberNotOrigin = (key: string) => { lastNotOrigin.current.set(key.split(':').slice(1).join(':'), key); };
  useEffect(() => { if (!restoreKey) return; notButtons.current.get(restoreKey)?.focus(); setRestoreKey(null); }, [restoreKey, value]);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Qualification rules</h3><p className="text-sm text-gray-600 dark:text-gray-300">Every bracket in a branch must match; any branch can qualify someone.</p></div>{value.branches.length === 0 ? <button type="button" disabled={disabled} onClick={() => onChange(addBranch(value))} aria-label="Add Branch 1" className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Add Branch 1</button> : null}</div>
    {warnings.length ? <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
    {value.branches.map((branch, branchIndex) => <React.Fragment key={branchIndex}>{branchIndex > 0 ? <div className="flex items-center gap-3 py-1" aria-label="OR alternative branch"><span className="h-px flex-1 bg-green-300 dark:bg-green-800" /><span className="rounded-full bg-green-700 px-3 py-1 text-xs font-bold tracking-wide text-white">OR</span><span className="h-px flex-1 bg-green-300 dark:bg-green-800" /></div> : null}<section aria-label={`Branch ${branchIndex + 1}`} className="space-y-3 rounded-lg border-2 border-gray-300 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-900/40"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold tracking-wide text-gray-800 dark:text-gray-100">BRANCH {branchIndex + 1}</h3><button type="button" disabled={disabled} onClick={() => onChange(removeBranch(value, branchIndex))} aria-label={`Remove Branch ${branchIndex + 1}`} className="text-sm text-gray-600 underline disabled:opacity-50 dark:text-gray-300">Remove branch</button></div>{branch.groups.map((group, groupIndex) => <React.Fragment key={`${group.dimensionId}:${groupIndex}`}>{groupIndex > 0 ? <p className="text-center text-xs font-bold tracking-widest text-gray-500">AND</p> : null}<GroupCard branchIndex={branchIndex} groupIndex={groupIndex} group={group} dimension={dimensions.get(group.dimensionId)} config={value} disabled={disabled} open={openGroups.has(`${branchIndex}:${group.dimensionId}`)} onToggleOpen={() => toggleOpen(`${branchIndex}:${group.dimensionId}`)} onChange={onChange} onNotOrigin={rememberNotOrigin} notButtonRef={notButtonRef} /></React.Fragment>)}<div className="rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-600"><button type="button" disabled={disabled} onClick={() => setPickerBranch((current) => current === branchIndex ? null : branchIndex)} aria-expanded={pickerBranch === branchIndex} aria-label={`Add AND filter type to Branch ${branchIndex + 1}`} className="text-sm font-medium text-green-800 underline disabled:opacity-50 dark:text-green-300">+ AND filter type</button>{pickerBranch === branchIndex ? <div className="mt-2 flex flex-wrap gap-2">{metadata.dimensions.filter((dimension) => !branch.groups.some((group) => group.dimensionId === dimension.id)).map((dimension) => <button key={dimension.id} type="button" disabled={disabled} onClick={() => { onChange(addGroup(value, branchIndex, dimension)); setPickerBranch(null); setOpenGroups((current) => new Set(current).add(`${branchIndex}:${dimension.id}`)); }} aria-label={`Add ${dimension.label} to Branch ${branchIndex + 1}`} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">Add {dimension.label}</button>)}</div> : null}</div></section></React.Fragment>)}
    {value.branches.length > 0 ? <button type="button" disabled={disabled} onClick={() => onChange(addBranch(value))} aria-label="Add OR alternative branch" className="w-full rounded-md border border-green-700 bg-white px-3 py-2 text-sm font-semibold text-green-800 disabled:opacity-50 dark:bg-gray-800 dark:text-green-300">+ OR alternative branch</button> : null}
    <section aria-label="Always exclude" className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/25"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-bold text-red-900 dark:text-red-200">Always exclude</h3><p className="text-xs text-red-800 dark:text-red-300">These values veto every branch.</p></div>{exclusions.length ? <ul className="mt-3 space-y-2">{exclusions.map(({ dimensionId, valueId }) => { const dimension = dimensions.get(dimensionId); const label = labelFor(valueId, dimension?.values || []); const pair = `${dimensionId}:${valueId}`; return <li key={pair} className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-3 py-2 text-sm dark:bg-gray-900/40"><span><span className="font-medium">{dimension?.label || dimensionId}:</span> {label}</span><button type="button" disabled={disabled} onClick={() => { setRestoreKey(lastNotOrigin.current.get(pair) || null); onChange(removeExclusionValue(value, dimensionId, valueId)); }} aria-label={`Remove exclusion ${label}`} className="text-red-800 underline disabled:opacity-50 dark:text-red-300">Remove</button></li>; })}</ul> : <p className="mt-2 text-sm text-red-800 dark:text-red-300">No global exclusions.</p>}</section>
    {value.branches.length === 0 && value.exclusions.length === 0 ? <p className="rounded-md bg-gray-100 p-3 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">No one matches until you add a branch or an exclusion.</p> : null}{value.branches.length === 0 && value.exclusions.length > 0 ? <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Everyone except the excluded people matches.</p> : null}
  </div>;
}
