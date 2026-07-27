import React from 'react';
import type { ElvantoFilterConfig, ElvantoMetadata } from '../peopleSync/types';

type Operator = 'any' | 'all';
type Status = ElvantoFilterConfig['statuses'][number];

export function defaultElvantoFilter(): ElvantoFilterConfig {
  return {
    statuses: ['active', 'contact'],
    categoryIds: [],
    groups: { ids: [], operator: 'any' },
    demographics: { values: [], operator: 'any' },
    departments: { values: [], operator: 'any' },
    serviceTypes: { ids: [], operator: 'any' },
    locations: { ids: [], operator: 'any' },
    customFields: [],
  };
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

function MatchOperator({ value, selectedCount, onChange }: { value: Operator; selectedCount: number; onChange: (value: Operator) => void }) {
  if (selectedCount < 2) return null;
  return (
    <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden" aria-label="Match selection">
      <button type="button" onClick={() => onChange('any')} aria-pressed={value === 'any'} className={`px-2 py-1 text-xs ${value === 'any' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match any</button>
      <button type="button" onClick={() => onChange('all')} aria-pressed={value === 'all'} className={`px-2 py-1 text-xs border-l border-gray-300 dark:border-gray-600 ${value === 'all' ? 'bg-green-600 text-white' : 'bg-white dark:bg-gray-800'}`}>Match all</button>
    </div>
  );
}

function Checkboxes({ options, selected, onChange }: { options: Array<{ id: string; name: string; detail?: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  return <div className="grid gap-1 sm:grid-cols-2">
    {options.map((option) => <label key={option.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
      <input aria-label={option.name} type="checkbox" checked={selected.includes(option.id)} onChange={() => onChange(toggle(selected, option.id))} />
      <span>{option.name}{option.detail ? <span className="ml-1 text-xs text-gray-500">{option.detail}</span> : null}</span>
    </label>)}
  </div>;
}

function FilterDimension({ title, options, selected, operator, onSelectedChange, onOperatorChange }: {
  title: string; options: Array<{ id: string; name: string; detail?: string }>; selected: string[]; operator: Operator;
  onSelectedChange: (next: string[]) => void; onOperatorChange: (next: Operator) => void;
}) {
  if (options.length === 0) return null;
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3><MatchOperator value={operator} selectedCount={selected.length} onChange={onOperatorChange} /></div>
    <Checkboxes options={options} selected={selected} onChange={onSelectedChange} />
  </section>;
}

function removedWarnings(metadata: ElvantoMetadata, value: ElvantoFilterConfig): string[] {
  const warnings: string[] = [];
  const addMissing = (label: string, selected: string[], current: string[]) => selected.filter((id) => !current.includes(id)).forEach((id) => warnings.push(`Selected ${label} "${id}" no longer exists in Elvanto.`));
  addMissing('category', value.categoryIds, metadata.categories.map((item) => item.id));
  addMissing('group', value.groups.ids, metadata.groups.map((item) => item.id));
  addMissing('service type', value.serviceTypes.ids, metadata.serviceTypes.map((item) => item.id));
  addMissing('location', value.locations.ids, metadata.locations.map((item) => item.id));
  addMissing('demographic', value.demographics.values, metadata.demographics.map((item) => item.value));
  addMissing('department', value.departments.values, metadata.departments.map((item) => item.value));
  for (const rule of value.customFields) {
    const field = metadata.customFields.find((item) => item.id === rule.fieldId);
    if (!field) warnings.push(`Selected custom field "${rule.fieldId}" no longer exists in Elvanto.`);
    else addMissing(`custom-field value for ${field.name}`, rule.values, field.values.map((item) => item.id));
  }
  return warnings;
}

export interface ElvantoFilterEditorProps {
  metadata: ElvantoMetadata;
  value: ElvantoFilterConfig;
  onChange: (next: ElvantoFilterConfig) => void;
}

export default function ElvantoFilterEditor({ metadata, value, onChange }: ElvantoFilterEditorProps) {
  const update = (patch: Partial<ElvantoFilterConfig>) => onChange({ ...value, ...patch });
  const warnings = removedWarnings(metadata, value);
  const dimensions = [
    metadata.categories.length > 0 && <FilterDimension key="categories" title="Categories" options={metadata.categories.map((item) => ({ id: item.id, name: item.name }))} selected={value.categoryIds} operator="any" onSelectedChange={(categoryIds) => update({ categoryIds })} onOperatorChange={() => undefined} />,
    metadata.groups.length > 0 && <FilterDimension key="groups" title="Groups" options={metadata.groups.map((item) => ({ id: item.id, name: item.name, detail: `(${item.memberCount})` }))} selected={value.groups.ids} operator={value.groups.operator} onSelectedChange={(ids) => update({ groups: { ...value.groups, ids } })} onOperatorChange={(operator) => update({ groups: { ...value.groups, operator } })} />,
    metadata.demographics.length > 0 && <FilterDimension key="demographics" title="Demographics" options={metadata.demographics.map((item) => ({ id: item.value, name: item.value, detail: `(${item.count})` }))} selected={value.demographics.values} operator={value.demographics.operator} onSelectedChange={(values) => update({ demographics: { ...value.demographics, values } })} onOperatorChange={(operator) => update({ demographics: { ...value.demographics, operator } })} />,
    metadata.departments.length > 0 && <FilterDimension key="departments" title="Departments" options={metadata.departments.map((item) => ({ id: item.value, name: item.value, detail: `(${item.count})` }))} selected={value.departments.values} operator={value.departments.operator} onSelectedChange={(values) => update({ departments: { ...value.departments, values } })} onOperatorChange={(operator) => update({ departments: { ...value.departments, operator } })} />,
    metadata.serviceTypes.length > 0 && <FilterDimension key="serviceTypes" title="Service types" options={metadata.serviceTypes.map((item) => ({ id: item.id, name: item.name }))} selected={value.serviceTypes.ids} operator={value.serviceTypes.operator} onSelectedChange={(ids) => update({ serviceTypes: { ...value.serviceTypes, ids } })} onOperatorChange={(operator) => update({ serviceTypes: { ...value.serviceTypes, operator } })} />,
    metadata.locations.length > 0 && <FilterDimension key="locations" title="Locations" options={metadata.locations.map((item) => ({ id: item.id, name: item.name }))} selected={value.locations.ids} operator={value.locations.operator} onSelectedChange={(ids) => update({ locations: { ...value.locations, ids } })} onOperatorChange={(operator) => update({ locations: { ...value.locations, operator } })} />,
  ].filter((dimension): dimension is React.ReactElement => Boolean(dimension));

  const setCustomFieldValues = (fieldId: string, values: string[]) => {
    const current = value.customFields.find((rule) => rule.fieldId === fieldId);
    const rest = value.customFields.filter((rule) => rule.fieldId !== fieldId);
    update({ customFields: values.length === 0 ? rest : [...rest, { fieldId, values, operator: current?.operator || 'any' }] });
  };
  const setCustomFieldOperator = (fieldId: string, operator: Operator) => update({ customFields: value.customFields.map((rule) => rule.fieldId === fieldId ? { ...rule, operator } : rule) });

  return <div className="space-y-4">
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">People status</h3>
      <Checkboxes options={([['active', 'Active'], ['contact', 'Contact'], ['archived', 'Archived'], ['deceased', 'Deceased']] as Array<[Status, string]>).map(([id, name]) => ({ id, name }))} selected={value.statuses} onChange={(statuses) => update({ statuses: statuses as Status[] })} />
    </section>
    {dimensions.map((dimension, index) => <React.Fragment key={index}>{index > 0 ? <p className="text-center text-xs font-semibold tracking-wide text-gray-500">AND</p> : null}{dimension}</React.Fragment>)}
    {metadata.customFields.length > 0 && <>
      <p className="text-center text-xs font-semibold tracking-wide text-gray-500">AND</p>
      <section className="space-y-3"><h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Custom fields</h3>
        {metadata.customFields.map((field) => {
          const rule = value.customFields.find((item) => item.fieldId === field.id);
          return <div key={field.id} className="border border-gray-200 dark:border-gray-700 rounded p-2 space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{field.name}</h4><MatchOperator value={rule?.operator || 'any'} selectedCount={rule?.values.length || 0} onChange={(operator) => setCustomFieldOperator(field.id, operator)} /></div>
            <Checkboxes options={field.values.map((item) => ({ id: item.id, name: item.name }))} selected={rule?.values || []} onChange={(values) => setCustomFieldValues(field.id, values)} />
          </div>;
        })}
      </section>
    </>}
    {warnings.length > 0 && <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
  </div>;
}
