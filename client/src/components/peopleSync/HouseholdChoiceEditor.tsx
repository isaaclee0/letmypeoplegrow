import React, { useState } from 'react';
import { PencilSquareIcon } from '@heroicons/react/24/outline';
import { compactNames, nameOf } from './syncDecisionModel';
import type { HouseholdChoiceEdits, HouseholdChoiceGroup, HouseholdChoicesPlan, HouseholdDestination, PeopleSyncPlan } from './types';

export function householdChoiceEditsMatch(left: HouseholdChoiceEdits, right: HouseholdChoiceEdits): boolean {
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every((id) => {
    if (!Object.hasOwn(right, id)) return false;
    const a = left[id].destination; const b = right[id].destination;
    return !!a && !!b && a.kind === b.kind && left[id].displayName === right[id].displayName
      && (a.kind !== 'existing' || (b.kind === 'existing' && a.familyId === b.familyId));
  });
}

/** Presentation only: old annotated warnings can be omitted; unrelated issues stay visible. */
export function withoutCoveredHouseholdWarnings<T extends PeopleSyncPlan>(plan: T): T {
  const groupIds = new Set((plan.householdChoices?.groups || []).map((group) => group.id));
  if (!groupIds.size) return plan;
  return { ...plan, familyConflicts: plan.familyConflicts.filter((action) => action.resolution
    || action.reason !== 'multiple_provider_households'
    || !action.householdChoiceGroupIds?.length
    || !action.householdChoiceGroupIds.every((id) => groupIds.has(id))) };
}

interface HouseholdChoiceEditorProps {
  plan: HouseholdChoicesPlan;
  baseGroups: HouseholdChoiceGroup[];
  edits: HouseholdChoiceEdits;
  onChange: (edits: HouseholdChoiceEdits) => void;
  onPreview: () => void | Promise<void>;
  needsPreview: boolean;
  previewing?: boolean;
  disabled?: boolean;
  error?: string | null;
}

const inputClass = 'block w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:disabled:bg-gray-800';
const buttonClass = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const textButtonClass = 'rounded text-xs font-medium text-gray-500 underline-offset-4 hover:text-gray-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400 dark:hover:text-white';
const destinationValue = (destination: HouseholdDestination) => destination.kind === 'existing' ? `existing:${destination.familyId}` : destination.kind;

export default function HouseholdChoiceEditor({ plan, baseGroups, edits, onChange, onPreview, needsPreview, previewing = false, disabled = false, error }: HouseholdChoiceEditorProps) {
  const [nameEditor, setNameEditor] = useState<{ groupId: string; previousEdit: HouseholdChoiceEdits[string] | undefined } | null>(null);
  if (plan.version !== 2) return <p role="alert">Household choices have changed. Refresh this review before applying.</p>;
  if (!plan.groups.length) return null;
  const update = (id: string, value: HouseholdChoiceEdits[string]) => onChange({ ...edits, [id]: value });
  const reset = (id: string) => {
    const next = { ...edits };
    delete next[id];
    onChange(next);
    setNameEditor(null);
  };
  const cancelNameEdit = () => {
    if (!nameEditor) return;
    if (nameEditor.previousEdit) update(nameEditor.groupId, nameEditor.previousEdit);
    else reset(nameEditor.groupId);
    setNameEditor(null);
  };
  const missingCreateName = Object.values(edits).some((edit) => edit.destination.kind === 'create' && !edit.displayName?.trim());
  const localName = (id: number | null) => id === null ? 'No family' : plan.localFamilies.find((family) => family.id === id)?.familyName;
  return <section aria-label="LMPG household choices" className="space-y-3">
    <div>
      <h3 className="text-lg font-semibold text-gray-950 dark:text-white">Choose a household for LMPG</h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Keep the current arrangement, choose an existing LMPG family, or create one for everyone on a card.</p>
    </div>
    <fieldset disabled={disabled || previewing} className="space-y-3">
      {plan.groups.map((group) => {
        const base = baseGroups.find((entry) => entry.id === group.id) || group;
        const edit = edits[group.id];
        const requiresForget = !!base.invalidReason && !base.sourceChanged;
        const destination = edit?.destination || base.selectedDestination;
        const sharedFamilyId = group.people.length > 0 && group.people.every((person) => person.currentFamilyId === group.people[0].currentFamilyId)
          ? group.people[0].currentFamilyId : null;
        const multipleArrangements = new Set(group.people.map((person) => person.currentFamilyId)).size > 1;
        const targetFamilyId = destination.kind === 'existing' ? destination.familyId : destination.kind === 'keep' ? sharedFamilyId : null;
        const targetFamily = plan.localFamilies.find((family) => family.id === targetFamilyId);
        const title = compactNames(group.people);
        const defaultName = targetFamily?.familyName || (destination.kind === 'keep' && !multipleArrangements ? group.people[0]?.currentFamilyName || 'No family' : 'Current arrangement');
        const nameValue = edit?.displayName !== undefined ? edit.displayName : defaultName;
        const displayName = nameValue.trim() || defaultName;
        const creating = destination.kind === 'create';
        const forgetting = destination.kind === 'forget';
        const editingName = creating || nameEditor?.groupId === group.id;
        const canRename = !!targetFamily && !requiresForget && !forgetting;
        const unavailable = destination.kind === 'existing' && !targetFamily;
        const decision = plan.decisions.find((entry) => entry.groupId === group.id);
        return <div key={group.id} role="group" aria-label={`Household choice for ${title}`} className="overflow-hidden rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold text-gray-950 dark:text-white">{title}</h4>
            <div className="flex items-center gap-3">
              {base.saved && <span className="text-xs text-gray-500 dark:text-gray-400">Saved choice</span>}
              {edit && <button type="button" className={textButtonClass} onClick={() => reset(group.id)}>Reset card</button>}
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Currently: {[...new Set(group.people.map((person) => person.currentFamilyName || 'No family'))].join(' · ')}</p>
          <div className="mt-4 min-w-0">
            <label className="sr-only" htmlFor={`household-${group.id}`}>Household for everyone on this card</label>
            <select id={`household-${group.id}`} value={unavailable ? 'unavailable' : destinationValue(destination)} className={inputClass}
              disabled={(!creating && editingName) || requiresForget}
              onChange={(event) => {
                setNameEditor(null);
                if (event.target.value === 'create') update(group.id, { destination: { kind: 'create' }, displayName: group.suggestedName });
                else if (event.target.value === 'keep') update(group.id, { destination: { kind: 'keep' } });
                else if (event.target.value.startsWith('existing:')) update(group.id, { destination: { kind: 'existing', familyId: Number(event.target.value.slice('existing:'.length)) } });
              }}>
              <option value="keep">{multipleArrangements ? 'Keep everyone in their current LMPG families' : 'Keep the current LMPG household'}</option>
              {plan.localFamilies.map((family) => <option key={family.id} value={`existing:${family.id}`}>
                {family.familyName}{family.memberNames.length ? ` — ${family.memberNames.join(', ')}` : ' — Empty family'}
              </option>)}
              <option value="create">Create a new LMPG family…</option>
              {forgetting && <option value="forget">Forget saved choice (no move)</option>}
              {unavailable && <option value="unavailable" disabled>Saved LMPG household unavailable</option>}
            </select>
            {(creating || (editingName && canRename)) ? <div className="mt-3 space-y-2">
              <label className="sr-only" htmlFor={`household-name-${group.id}`}>{creating ? 'New family name' : 'LMPG family display name (optional)'}</label>
              <input id={`household-name-${group.id}`} type="text" maxLength={200} required={creating} className={inputClass}
                autoFocus onFocus={(event) => event.currentTarget.select()}
                value={nameValue} placeholder={creating ? group.suggestedName || 'New family name' : defaultName}
                onChange={(event) => update(group.id, { destination, displayName: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); if (!creating) setNameEditor(null); }
                  if (event.key === 'Escape' && !creating) { event.preventDefault(); cancelNameEdit(); }
                }} />
              {creating && !nameValue.trim() && <p role="alert" className="text-xs text-amber-800 dark:text-amber-200">Enter a name for the new family.</p>}
              <div className="flex flex-wrap items-center gap-4">
                {!creating && <>
                  <button type="button" aria-label="Done editing name" className={textButtonClass} onClick={() => setNameEditor(null)}>Done</button>
                  <button type="button" aria-label="Cancel name edit" className={textButtonClass} onClick={cancelNameEdit}>Cancel</button>
                </>}
                {creating && group.suggestedName && <button type="button" className={textButtonClass}
                  onClick={() => update(group.id, { destination, displayName: group.suggestedName })}>Use suggested name</button>}
              </div>
            </div> : !forgetting && !unavailable && <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="text-gray-500 dark:text-gray-400">{multipleArrangements && destination.kind === 'keep' ? 'LMPG arrangement' : 'LMPG name'}</span>
              {targetFamily && targetFamily.familyName !== displayName && <>
                <span className="text-gray-400 line-through dark:text-gray-500">{targetFamily.familyName}</span>
                <span aria-label="changes to" className="text-gray-400">→</span>
              </>}
              <span data-testid="household-display-name" className="font-medium text-gray-900 dark:text-gray-100">{displayName}</span>
              {canRename && <button type="button" aria-label={`Edit family name for ${title}`} title="Edit LMPG family name"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:bg-gray-700 dark:hover:text-white"
                onClick={() => setNameEditor({ groupId: group.id, previousEdit: edit })}>
                <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
              </button>}
            </div>}
            {(!base.saved || base.sourceChanged) && !edit && !requiresForget && <button type="button" className={`mt-3 ${buttonClass}`}
              onClick={() => update(group.id, { destination })}>
              {multipleArrangements ? 'Remember this arrangement' : 'Remember this household'}
            </button>}
          </div>
          {decision && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-900/50 dark:text-gray-200">
            <p className="font-medium">{needsPreview ? 'Last preview' : 'On Apply'}</p>
            {decision.destination.kind === 'forget' ? <p>Forget the saved choice. Everyone stays in their current LMPG family.</p> : <>
              {decision.destination.kind === 'create' && <p>Create family: <strong>{decision.resolvedName}</strong></p>}
              {decision.fromName && decision.resolvedName && decision.fromName !== decision.resolvedName && <p>Family name: {decision.fromName} → {decision.resolvedName}</p>}
              <ul>{decision.people.map((person) => {
                const member = group.people.find((entry) => entry.externalPersonId === person.externalPersonId);
                const from = localName(person.fromFamilyId) || member?.currentFamilyName || 'Family unavailable';
                const to = decision.resolvedName || (decision.destination.kind === 'existing' ? localName(decision.destination.familyId) : from) || from;
                return <li key={person.externalPersonId}>{nameOf(member)}: {from === to ? `stays in ${to}` : `${from} → ${to}`}</li>;
              })}</ul>
              <p className="mt-1 text-xs">This LMPG arrangement will be remembered until Planning Center household membership changes.</p>
            </>}
          </div>}
          <details className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            <summary className="w-fit cursor-pointer hover:text-gray-800 dark:hover:text-gray-200">Planning Center household details</summary>
            <ul className="mt-2 space-y-2">{group.sourceHouseholds.map((household) => <li key={household.externalFamilyId}>
              <span className="font-medium">{household.name}</span>: {household.members.map((member) => `${nameOf(member)}${member.inSource ? '' : ' (outside source)'}`).join(', ') || 'Members unavailable'}
            </li>)}</ul>
          </details>
          {base.invalidReason && !forgetting && <p role="alert" className="mt-3 text-sm text-amber-800 dark:text-amber-200">{!base.sourceChanged && 'This saved household choice is no longer valid. '}{base.invalidReason}</p>}
          {forgetting && <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">The saved household choice will be forgotten when you apply. Current family membership stays unchanged.</p>}
          {base.saved && !forgetting && <button type="button" className={`mt-3 ${textButtonClass}`} onClick={() => {
            setNameEditor(null); update(group.id, { destination: { kind: 'forget' } });
          }}>Forget saved choice</button>}
        </div>;
      })}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} onClick={() => { setNameEditor(null); void onPreview(); }} disabled={!needsPreview || previewing || disabled || missingCreateName}>
          {previewing ? 'Previewing household choices…' : 'Preview household choices'}
        </button>
        {needsPreview ? <p role="status" className="text-sm text-amber-800 dark:text-amber-200">Preview your household choices before applying.</p>
          : Object.keys(edits).length > 0 && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Preview ready. These choices are saved only when you apply.</p>}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">Apply updates the LMPG households shown in your preview and remembers your choices until Planning Center household membership changes.</p>
    </fieldset>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">{error}</p>}
  </section>;
}
