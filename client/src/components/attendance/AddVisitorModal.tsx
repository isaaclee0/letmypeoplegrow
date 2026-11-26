import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { ChevronDownIcon, DocumentDuplicateIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { attendanceAPI, type VisitorDetails, type VisitorDetailsInput } from '../../services/api';
import { generateFamilyName } from '../../utils/familyNameUtils';
import { countedVisitors, MAX_VISITORS, parseVisitorEntry, type VisitorName } from '../../utils/visitorQuickEntry';

interface Props {
  gatheringId: number;
  date: string;
  visitorId?: number;
  canSetType: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}

interface Row extends VisitorName {
  key: string;
  id?: number;
  locked?: boolean;
}

const field = 'block w-full min-w-0 rounded-md border border-gray-300 bg-white px-2.5 py-2 text-base text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder:text-gray-300 sm:text-sm';
const link = 'inline-flex items-center gap-1 rounded text-sm font-medium text-primary-700 hover:underline dark:text-primary-300';

function previewRows(people: VisitorName[]): Row[] {
  const occurrences = new Map<string, number>();
  return people.map(person => {
    const name = JSON.stringify([person.firstName, person.isChild]);
    const index = (occurrences.get(name) || 0) + 1;
    occurrences.set(name, index);
    return { ...person, key: name + index };
  });
}

export default function AddVisitorModal({ gatheringId, date, visitorId, canSetType, onSaved, onClose }: Props) {
  const [details, setDetails] = useState<VisitorDetails | null>(null);
  const [entry, setEntry] = useState('');
  const [counts, setCounts] = useState({ adults: 0, children: 0 });
  const [additional, setAdditional] = useState<Row[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(visitorId ? String(visitorId) : null);
  const [surnameSourceKey, setSurnameSourceKey] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, Partial<VisitorName> | null>>({});
  const [peopleType, setPeopleType] = useState<VisitorDetailsInput['peopleType']>('local_visitor');
  const [notes, setNotes] = useState('');
  const [customFamilyName, setCustomFamilyName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nextKey = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!visitorId) return;
    let current = true;
    attendanceAPI.getVisitorDetails(gatheringId, date, visitorId).then(({ data }) => {
      if (!current) return;
      setDetails(data);
      setNotes(data.notes);
      setPeopleType(data.peopleType);
      if (!data.familyEditable || data.familyName !== generateFamilyName(data.people)) setCustomFamilyName(data.familyName);
    }).catch(err => {
      if (current) setError(err.response?.data?.error || 'Could not load these visitors. Close and try again.');
    });
    return () => { current = false; };
  }, [gatheringId, date, visitorId]);

  const preview = parseVisitorEntry(entry);
  const countTotal = counts.adults + counts.children;
  const issue = preview.familySurname && countTotal > MAX_VISITORS ? 'Add up to 10 people at a time.' : preview.issue;
  const parsed = preview.familySurname && !issue ? countedVisitors(counts.adults, counts.children, preview.familySurname) : preview.people;
  const baseRows = details ? details.people.map(person => ({ ...person, key: String(person.id) })) : previewRows(parsed);
  const rows = [...baseRows, ...additional].filter(p => changes[p.key] !== null).map(p => ({ ...p, ...changes[p.key] }));
  const blankSurnames = rows.filter(person => !person.locked && !person.lastName.trim());
  const surnameSource = rows.find(person => person.key === surnameSourceKey && person.lastName.trim())
    ?? rows.find(person => person.lastName.trim());
  const familyName = customFamilyName ?? generateFamilyName(rows);
  const canEditFamily = details?.familyEditable ?? true;
  const ready = !visitorId || Boolean(details);
  const limit = Math.max(MAX_VISITORS, details?.people.length || 0);

  function changePerson(key: string, change: Partial<VisitorName>) {
    setChanges(old => ({ ...old, [key]: { ...old[key], ...change } }));
  }

  function fillBlankSurnames(lastName: string) {
    setChanges(old => {
      const next = { ...old };
      for (const person of blankSurnames) {
        next[person.key] = { ...old[person.key], lastName: lastName.trim() };
      }
      return next;
    });
  }

  function addPerson() {
    if (issue) setEntry('');
    const key = 'manual-' + nextKey.current++;
    setAdditional(previous => [...previous, { key, firstName: '', lastName: '', isChild: false }]);
    setExpandedKey(key);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current || !ready || issue || !rows.length || rows.length > limit) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const payload: VisitorDetailsInput = {
      revision: details?.revision, peopleType, notes,
      familyName: canEditFamily ? familyName.trim() || generateFamilyName(rows) : details!.familyName,
      people: rows.map(({ id, firstName, lastName, isChild }) => ({ id, firstName: firstName.trim(), lastName: lastName.trim(), isChild })),
    };
    try {
      if (visitorId) await attendanceAPI.updateVisitorDetails(gatheringId, date, visitorId, payload);
      else await attendanceAPI.createVisitorDetails(gatheringId, date, payload);
      onSaved(visitorId ? 'Visitor details saved' : rows.length === 1 ? 'Visitor added' : rows.length + ' visitors added');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not save the visitors. Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={() => { if (!savingRef.current) onClose(); }} className="relative z-[9999]">
      <div aria-hidden="true" className="fixed inset-0 bg-gray-900/50" />
      <div className="fixed inset-0 flex items-end justify-center sm:items-center sm:p-6">
        <DialogPanel className="flex max-h-[100dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100 sm:max-h-[calc(100dvh-3rem)] sm:rounded-xl">
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 sm:px-5 sm:pt-4">
            <DialogTitle className="text-xl font-semibold">{visitorId ? 'Edit visitor details' : 'Add visitors'}</DialogTitle>
            <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-gray-700"><XMarkIcon className="size-5" /></button>
          </header>
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <fieldset disabled={saving} className="min-w-0 space-y-4 px-4 pb-4 pt-2 sm:px-5 sm:pt-3">
                {!visitorId && <div>
                  <label htmlFor="visitor-entry" className="mb-1 block font-medium">Who came?</label>
                  <textarea id="visitor-entry" data-autofocus rows={2} value={entry} onChange={e => setEntry(e.target.value)}
                    placeholder="e.g. John and Judy Smith, 2 kids" className={field + ' resize-none sm:resize-y'} />
                </div>}
                {preview.familySurname && <fieldset>
                  <legend className="mb-2 text-sm font-medium">How many adults and children came with the {preview.familySurname} family?</legend>
                  <div className="flex gap-4">{(['adults', 'children'] as const).map(kind =>
                    <label key={kind} className="text-sm capitalize">{kind}
                      <input type="number" min="0" max={MAX_VISITORS} value={counts[kind]} className={field}
                        onChange={e => setCounts({ ...counts, [kind]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                    </label>)}</div>
                </fieldset>}
                {issue && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{issue}</p>}
                {!ready && !error && <p role="status">Loading visitor details…</p>}
                {rows.length > 0 && <section aria-label="Visitor details" className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{rows.length === 1 ? '1 visitor' : rows.length + ' visitors'}</h3>
                    {rows.length > limit && <span role="alert" className="text-sm">Add up to {limit} people.</span>}
                  </div>
                  <div className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700 sm:space-y-2 sm:divide-y-0 sm:overflow-visible sm:border-0">
                    {rows.map((person, index) => {
                      const number = index + 1;
                      const fullName = [person.firstName.trim(), person.lastName.trim()].filter(Boolean).join(' ');
                      const expanded = expandedKey === person.key;
                      const editorId = 'visitor-person-' + number;
                      return (
                        <div key={person.key} className="sm:rounded-lg sm:bg-gray-50 dark:sm:bg-gray-900/40">
                          <button type="button" aria-label={'Edit ' + (fullName || 'unnamed visitor')} aria-expanded={expanded} aria-controls={editorId}
                            onClick={() => {
                              setExpandedKey(expanded ? null : person.key);
                              setSurnameSourceKey(person.key);
                            }}
                            className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left sm:hidden">
                            <span className="min-w-0 flex-1 break-words text-sm font-medium">{fullName || 'Unnamed visitor'}</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300">{person.isChild ? 'Child' : 'Adult'}</span>
                            <ChevronDownIcon className={'size-4 shrink-0 text-gray-500 ' + (expanded ? 'rotate-180' : '')} />
                          </button>
                          <div id={editorId} className={`${expanded ? 'grid' : 'hidden'} grid-cols-2 items-end gap-2 bg-gray-50 px-3 pb-3 pt-2 dark:bg-gray-900/40 sm:grid sm:grid-cols-[1fr_1fr_5.5rem_2rem] sm:rounded-lg sm:p-2.5`}>
                            <label className="min-w-0 text-xs">First name
                              <input aria-label={'First name ' + number} required value={person.firstName} disabled={person.locked}
                                autoFocus={person.key.startsWith('manual-')} className={field}
                                onChange={e => changePerson(person.key, { firstName: e.target.value })} />
                            </label>
                            <label className="min-w-0 text-xs">Surname
                              <input aria-label={'Surname ' + number} placeholder="Optional" value={person.lastName} disabled={person.locked} className={field}
                                onFocus={() => setSurnameSourceKey(person.key)}
                                onChange={e => {
                                  setSurnameSourceKey(person.key);
                                  changePerson(person.key, { lastName: e.target.value });
                                }} />
                            </label>
                            <select aria-label={'Age group ' + number} value={person.isChild ? 'child' : 'adult'} disabled={person.locked} className={field}
                              onChange={e => changePerson(person.key, { isChild: e.target.value === 'child' })}>
                              <option value="adult">Adult</option><option value="child">Child</option>
                            </select>
                            {!person.id && <button type="button" className="flex min-h-10 items-center justify-self-end gap-1 rounded px-2 text-sm text-gray-600 hover:text-red-600 dark:text-gray-300"
                              aria-label={'Remove visitor ' + number} onClick={() => setChanges(old => ({ ...old, [person.key]: null }))}>
                              <XMarkIcon className="size-4" /><span className="sm:hidden">Remove</span>
                            </button>}
                            {surnameSource?.key === person.key && blankSurnames.length > 0 && (
                              <button type="button" className={link + ' col-span-full min-h-10 justify-self-start text-left'}
                                onClick={() => fillBlankSurnames(person.lastName)}>
                                <DocumentDuplicateIcon className="size-4 shrink-0" />
                                Fill {blankSurnames.length} blank surname{blankSurnames.length === 1 ? '' : 's'} with {person.lastName.trim()}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>}
                {ready && canEditFamily && rows.length < limit && <button type="button" className={link + ' min-h-10'} onClick={addPerson}>
                  <PlusIcon className="size-4" />{rows.length ? 'Add another person' : 'Enter a person manually'}
                </button>}
                {ready && <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                  {canSetType && canEditFamily && <label className="flex items-center gap-3 text-sm">Visitor type
                    <select value={peopleType} className={field + ' max-w-40'} onChange={e => setPeopleType(e.target.value as typeof peopleType)}>
                      <option value="local_visitor">Local visitor</option><option value="traveller_visitor">Traveller visitor</option>
                    </select>
                  </label>}
                  {details && canEditFamily && <label className="block text-sm">Family name
                    <input value={familyName} onChange={e => setCustomFamilyName(e.target.value || null)} className={field} />
                  </label>}
                  <label className="block text-sm">Family note
                    <textarea rows={2} value={notes} disabled={details?.notesEditable === false} onChange={e => setNotes(e.target.value)} className={field} />
                  </label>
                </div>}
                {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
              </fieldset>
            </div>
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-gray-700 dark:bg-gray-800 sm:px-5">
              <button type="button" onClick={onClose} disabled={saving} className="rounded-md px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving || !ready || !!issue || !rows.length || rows.length > limit || rows.some(p => !p.firstName.trim())}
                className="min-h-11 flex-1 rounded-md bg-primary-600 px-4 py-2 text-sm sm:min-h-0 sm:flex-none font-medium text-white hover:bg-primary-700 disabled:opacity-50 dark:bg-primary-700 dark:hover:bg-primary-800">
                {saving ? 'Saving…' : visitorId ? 'Save changes' : rows.length > 1 ? 'Add ' + rows.length + ' visitors' : 'Add visitor'}
              </button>
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
