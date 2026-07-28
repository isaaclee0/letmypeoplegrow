import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addGroup } from '../../services/filterConfig';
import type {
  BooleanFilterConfigV2,
  FilterDimension,
  FilterDimensionValue,
  FilterGroupMode,
  FilterMetadata,
  FilterValueState,
} from './types';

export interface FilterBuilderProps {
  metadata: FilterMetadata;
  value: BooleanFilterConfigV2;
  onChange: (value: BooleanFilterConfigV2) => void;
  disabled?: boolean;
}

function copyConfig(value: BooleanFilterConfigV2): BooleanFilterConfigV2 {
  return {
    branches: value.branches.map((branch) => ({ groups: branch.groups.map((group) => ({ ...group, values: [...group.values] })) })),
    exclusions: value.exclusions.map((exclusion) => ({ ...exclusion, values: [...exclusion.values] })),
  };
}

function labelFor(value: string, values: readonly FilterDimensionValue[]): string {
  if (value === '$not_set') return 'Not set';
  return values.find((candidate) => candidate.id === value)?.label || value;
}

function hasExclusion(config: BooleanFilterConfigV2, dimensionId: string, valueId: string): boolean {
  return config.exclusions.some((exclusion) => exclusion.dimensionId === dimensionId && exclusion.values.includes(valueId));
}

function setMode(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number, mode: FilterGroupMode): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  const group = next.branches[branchIndex]?.groups[groupIndex];
  if (group) group.mode = mode;
  return next;
}

function setState(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number, dimension: FilterDimension, valueId: string, state: FilterValueState): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  // A global NOT must win against all branches, so remove the value everywhere
  // before recording it in the persistent exclusion ledger.
  if (state === 'not') {
    next.branches.forEach((branch) => branch.groups.forEach((group) => {
      if (group.dimensionId === dimension.id) group.values = group.values.filter((current) => current !== valueId);
    }));
    next.exclusions = next.exclusions.map((exclusion) => exclusion.dimensionId === dimension.id
      ? { ...exclusion, values: exclusion.values.filter((current) => current !== valueId) }
      : exclusion).filter((exclusion) => exclusion.values.length > 0);
    next.exclusions.push({ dimensionId: dimension.id, values: [valueId] });
    return next;
  }

  next.exclusions = next.exclusions.map((exclusion) => exclusion.dimensionId === dimension.id
    ? { ...exclusion, values: exclusion.values.filter((current) => current !== valueId) }
    : exclusion).filter((exclusion) => exclusion.values.length > 0);
  const group = next.branches[branchIndex]?.groups[groupIndex];
  if (!group) return next;
  group.values = state === 'include'
    ? [...new Set([...group.values, valueId])]
    : group.values.filter((current) => current !== valueId);
  return next;
}

function removeExclusion(config: BooleanFilterConfigV2, dimensionId: string, valueId: string): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  next.exclusions = next.exclusions.map((exclusion) => exclusion.dimensionId === dimensionId
    ? { ...exclusion, values: exclusion.values.filter((value) => value !== valueId) }
    : exclusion).filter((exclusion) => exclusion.values.length > 0);
  return next;
}

function appendBranch(config: BooleanFilterConfigV2): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  next.branches.push({ groups: [] });
  return next;
}

function deleteBranch(config: BooleanFilterConfigV2, branchIndex: number): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  next.branches.splice(branchIndex, 1);
  return next;
}

function deleteGroup(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number): BooleanFilterConfigV2 {
  const next = copyConfig(config);
  next.branches[branchIndex]?.groups.splice(groupIndex, 1);
  return next;
}

function ValueStateControl({ label, state, disabled, onChange, buttonRef }: {
  label: string;
  state: FilterValueState;
  disabled: boolean;
  onChange: (state: FilterValueState) => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const options: Array<[FilterValueState, string]> = [['off', 'Off'], ['include', 'Include'], ['not', 'NOT']];
  return <div role="group" aria-label={`State for ${label}`} className="inline-flex shrink-0 overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
    {options.map(([next, text], index) => <button key={next} ref={next === 'not' ? buttonRef : undefined} type="button" disabled={disabled}
      onClick={() => onChange(next)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChange(next); } }} aria-pressed={state === next} aria-label={`${text} ${label}`}
      className={`px-2 py-1 text-xs font-medium ${index ? 'border-l border-gray-300 dark:border-gray-600' : ''} ${state === next ? next === 'not' ? 'bg-red-700 text-white' : 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'} disabled:cursor-not-allowed disabled:opacity-50`}>{text}</button>)}
  </div>;
}

function unresolvedWarning(config: BooleanFilterConfigV2, metadata: FilterMetadata): string[] {
  const dimensions = new Map(metadata.dimensions.map((dimension) => [dimension.id, dimension]));
  const warnings: string[] = [];
  const selected = [...config.branches.flatMap((branch) => branch.groups), ...config.exclusions];
  selected.forEach((group) => {
    const dimension = dimensions.get(group.dimensionId);
    if (!dimension) { warnings.push(`The saved filter type “${group.dimensionId}” is no longer available.`); return; }
    group.values.forEach((value) => {
      if (!dimension.values.some((candidate) => candidate.id === value)) warnings.push(`The saved ${dimension.label} value “${value}” is no longer available.`);
    });
  });
  return [...new Set(warnings)];
}

function GroupCard({ branchIndex, groupIndex, group, dimension, config, disabled, onChange, notButtonRef }: {
  branchIndex: number;
  groupIndex: number;
  group: { dimensionId: string; mode: FilterGroupMode; values: string[] };
  dimension: FilterDimension | undefined;
  config: BooleanFilterConfigV2;
  disabled: boolean;
  onChange: (value: BooleanFilterConfigV2) => void;
  notButtonRef: (pair: string) => React.Ref<HTMLButtonElement>;
}) {
  const [query, setQuery] = useState('');
  const resolved = dimension?.values || [];
  const selectedUnknown = group.values.filter((value) => !resolved.some((candidate) => candidate.id === value));
  const values = [...resolved, ...selectedUnknown.map((id) => ({ id, label: id, count: 0 }))];
  const visible = values.filter((candidate) => candidate.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const label = dimension?.label || group.dimensionId;
  const includes = group.values.length;
  return <section aria-label={`${label} in Branch ${branchIndex + 1}`} className="space-y-3 rounded-md border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</h4>{!dimension ? <p className="text-xs text-amber-700 dark:text-amber-300">This saved filter type is no longer available.</p> : null}</div>
      <button type="button" disabled={disabled} onClick={() => onChange(deleteGroup(config, branchIndex, groupIndex))} aria-label={`Remove ${label} from Branch ${branchIndex + 1}`} className="text-sm text-gray-600 underline hover:text-gray-900 disabled:opacity-50 dark:text-gray-300">Remove</button>
    </div>
    {dimension?.cardinality === 'multi' && includes >= 2 ? <div className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600" aria-label={`Match mode for ${label}`}>
      <button type="button" disabled={disabled} onClick={() => onChange(setMode(config, branchIndex, groupIndex, 'any'))} aria-pressed={group.mode === 'any'} aria-label={`Match any for ${label}`} className={`px-2 py-1 text-xs ${group.mode === 'any' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match any</button>
      <button type="button" disabled={disabled} onClick={() => onChange(setMode(config, branchIndex, groupIndex, 'all'))} aria-pressed={group.mode === 'all'} aria-label={`Match all for ${label}`} className={`border-l border-gray-300 px-2 py-1 text-xs dark:border-gray-600 ${group.mode === 'all' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match all</button>
    </div> : null}
    {dimension ? <><button type="button" disabled={disabled} aria-label={`Open ${label} values`} className="sr-only">Open {label} values</button><label className="block text-xs font-medium text-gray-600 dark:text-gray-300">Search {label} values<input aria-label={`Search ${label} values`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} className="mt-1 block w-full rounded-md border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-900" /></label></> : null}
    <div className="space-y-2">{visible.map((candidate) => {
      const state: FilterValueState = hasExclusion(config, group.dimensionId, candidate.id) ? 'not' : group.values.includes(candidate.id) ? 'include' : 'off';
      const valueLabel = labelFor(candidate.id, resolved);
      return <div key={candidate.id} className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 break-words text-sm text-gray-700 dark:text-gray-200">{valueLabel} <span className="text-xs text-gray-500">({candidate.count})</span>{!resolved.some((value) => value.id === candidate.id) ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">Unavailable</span> : null}</span><ValueStateControl label={valueLabel} state={state} disabled={disabled} buttonRef={notButtonRef(`${group.dimensionId}:${candidate.id}`)} onChange={(next) => onChange(setState(config, branchIndex, groupIndex, dimension, candidate.id, next))} /></div>;
    })}</div>
  </section>;
}

export default function FilterBuilder({ metadata, value, onChange, disabled = false }: FilterBuilderProps) {
  const dimensions = useMemo(() => new Map(metadata.dimensions.map((dimension) => [dimension.id, dimension])), [metadata]);
  const notButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const [restorePair, setRestorePair] = useState<string | null>(null);
  const warnings = unresolvedWarning(value, metadata);
  const addDimension = (branchIndex: number, dimension: FilterDimension) => onChange(addGroup(value, branchIndex, dimension));
  const exclusionEntries = value.exclusions.flatMap((exclusion) => exclusion.values.map((valueId) => ({ dimensionId: exclusion.dimensionId, valueId })));

  const notButtonRef = (pair: string) => (element: HTMLButtonElement | null) => { notButtons.current.set(pair, element); };
  useEffect(() => {
    if (!restorePair) return;
    notButtons.current.get(restorePair)?.focus();
    setRestorePair(null);
  }, [restorePair, value]);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Qualification rules</h3><p className="text-sm text-gray-600 dark:text-gray-300">Every bracket in a branch must match; any branch can qualify someone.</p></div>{value.branches.length === 0 ? <button type="button" disabled={disabled} onClick={() => onChange(appendBranch(value))} aria-label="Add Branch 1" className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">Add Branch 1</button> : null}</div>
    {warnings.length > 0 ? <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
    {value.branches.map((branch, branchIndex) => <React.Fragment key={branchIndex}>
      {branchIndex > 0 ? <div className="flex items-center gap-3 py-1" aria-label="OR alternative branch"><span className="h-px flex-1 bg-green-300 dark:bg-green-800" /><span className="rounded-full bg-green-700 px-3 py-1 text-xs font-bold tracking-wide text-white">OR</span><span className="h-px flex-1 bg-green-300 dark:bg-green-800" /></div> : null}
      <section aria-label={`Branch ${branchIndex + 1}`} className="space-y-3 rounded-lg border-2 border-gray-300 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-900/40">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold tracking-wide text-gray-800 dark:text-gray-100">BRANCH {branchIndex + 1}</h3><button type="button" disabled={disabled} onClick={() => onChange(deleteBranch(value, branchIndex))} aria-label={`Remove Branch ${branchIndex + 1}`} className="text-sm text-gray-600 underline hover:text-gray-900 disabled:opacity-50 dark:text-gray-300">Remove branch</button></div>
        {branch.groups.map((group, groupIndex) => <React.Fragment key={`${group.dimensionId}:${groupIndex}`}>{groupIndex > 0 ? <p className="text-center text-xs font-bold tracking-widest text-gray-500">AND</p> : null}<GroupCard branchIndex={branchIndex} groupIndex={groupIndex} group={group} dimension={dimensions.get(group.dimensionId)} config={value} disabled={disabled} onChange={onChange} notButtonRef={notButtonRef} /></React.Fragment>)}
        <div className="rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-600"><p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Add to this branch</p><button type="button" disabled={disabled} aria-label={`Add AND filter type to Branch ${branchIndex + 1}`} className="mb-2 text-sm font-medium text-green-800 underline disabled:opacity-50 dark:text-green-300">+ AND filter type</button><div className="flex flex-wrap gap-2">{metadata.dimensions.filter((dimension) => !branch.groups.some((group) => group.dimensionId === dimension.id)).map((dimension) => <button key={dimension.id} type="button" disabled={disabled} onClick={() => addDimension(branchIndex, dimension)} aria-label={`Add ${dimension.label} to Branch ${branchIndex + 1}`} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:border-green-600 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">Add {dimension.label}</button>)}</div></div>
      </section>
    </React.Fragment>)}
    {value.branches.length > 0 ? <button type="button" disabled={disabled} onClick={() => onChange(appendBranch(value))} aria-label="Add OR alternative branch" className="w-full rounded-md border border-green-700 bg-white px-3 py-2 text-sm font-semibold text-green-800 hover:bg-green-50 disabled:opacity-50 dark:bg-gray-800 dark:text-green-300">+ OR alternative branch</button> : null}
    <section aria-label="Always exclude" className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/25"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-bold text-red-900 dark:text-red-200">Always exclude</h3><p className="text-xs text-red-800 dark:text-red-300">These values veto every branch.</p></div>{exclusionEntries.length ? <ul className="mt-3 space-y-2">{exclusionEntries.map(({ dimensionId, valueId }) => { const dimension = dimensions.get(dimensionId); const label = labelFor(valueId, dimension?.values || []); return <li key={`${dimensionId}:${valueId}`} className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-3 py-2 text-sm dark:bg-gray-900/40"><span><span className="font-medium">{dimension?.label || dimensionId}:</span> {label}</span><button type="button" disabled={disabled} onClick={() => { setRestorePair(`${dimensionId}:${valueId}`); onChange(removeExclusion(value, dimensionId, valueId)); }} aria-label={`Remove exclusion ${label}`} className="text-red-800 underline hover:text-red-950 disabled:opacity-50 dark:text-red-300">Remove</button></li>; })}</ul> : <p className="mt-2 text-sm text-red-800 dark:text-red-300">No global exclusions.</p>}</section>
    {value.branches.length === 0 && value.exclusions.length === 0 ? <p className="rounded-md bg-gray-100 p-3 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">No one matches until you add a branch or an exclusion.</p> : null}
    {value.branches.length === 0 && value.exclusions.length > 0 ? <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Everyone except the excluded people matches.</p> : null}
  </div>;
}
