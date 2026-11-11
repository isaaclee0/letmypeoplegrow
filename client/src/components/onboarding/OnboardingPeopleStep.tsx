import React, { useCallback, useEffect, useRef, useState } from 'react';
import { csvImportAPI, individualsAPI, integrationsAPI, peopleSyncAPI, type GatheringType, type GuidedOnboardingState, type GuidedOnboardingStatus } from '../../services/api';
import AddPeopleModal, { type PeopleImportSummary } from '../people/AddPeopleModal';
import PeopleImportDialog from '../peopleImport/PeopleImportDialog';

interface Person {
  id: number; firstName: string; lastName: string; peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  isActive?: boolean; familyId?: number; gatheringAssignments?: { id: number; name: string }[];
}
interface Props {
  state: GuidedOnboardingState;
  status: GuidedOnboardingStatus;
  gatherings: GatheringType[];
  onStateChange: (state: GuidedOnboardingState) => Promise<void>;
  onPeopleAdded: () => Promise<void>;
  onContinue: () => Promise<void>;
  onBack: () => Promise<void>;
}
const primary = 'rounded-md bg-primary-600 px-4 py-3 font-medium text-white hover:bg-primary-700 disabled:opacity-50';
const secondary = 'rounded-md border border-gray-300 px-4 py-3 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 disabled:opacity-50';
const choice = 'w-full rounded-lg border border-gray-300 p-4 text-left text-gray-900 hover:border-primary-500 hover:bg-primary-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50';
function errorMessage(error: unknown) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error
    || (error instanceof Error ? error.message : 'Could not load your people. Please try again.');
}

export default function OnboardingPeopleStep({ state, status, gatherings, onStateChange, onPeopleAdded, onContinue, onBack }: Props) {
  const [people, setPeople] = useState<Person[]>([]);
  const [ready, setReady] = useState(false);
  const [allowManual, setAllowManual] = useState(false);
  const [pcoAvailable, setPcoAvailable] = useState(false);
  const [pcoCheckFailed, setPcoCheckFailed] = useState(false);
  const [error, setError] = useState('');
  const [savedRefreshPending, setSavedRefreshPending] = useState(false);
  const [importSummary, setImportSummary] = useState<PeopleImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const [adding, setAdding] = useState(!status.canFinish);
  const [localChoices, setLocalChoices] = useState(state.provider === null);
  const [assignmentId, setAssignmentId] = useState<number | null>(gatherings.length === 1 ? gatherings[0].id : null);
  const [assignmentSkipped, setAssignmentSkipped] = useState(false);

  const load = useCallback(async (refreshProgress?: () => Promise<void>) => {
    const current = ++generation.current;
    setError(''); setReady(false);
    try {
      const [roster, policy, pco] = await Promise.all([
        individualsAPI.getAll(), peopleSyncAPI.getSettings(),
        integrationsAPI.getPlanningCenterStatus().then(response => ({ data: response.data, failed: false })).catch(() => ({ data: null, failed: true })),
        refreshProgress && Promise.resolve().then(refreshProgress),
      ]);
      if (current !== generation.current) return;
      setPeople((roster.data.people || []).filter((person: Person) => person.isActive !== false));
      const settings = policy.data.settings;
      setAllowManual(settings.authorityProvider === 'none' || settings.peopleEditingLocked === false);
      // `configured` describes this church's saved connection, not installation availability.
      // New churches must be able to choose Planning Center before connecting it.
      setPcoAvailable(pco.data?.enabled === true);
      setPcoCheckFailed(pco.failed);
      setSavedRefreshPending(false);
      setReady(true);
    } catch (cause) {
      if (current === generation.current) {
        const detail = errorMessage(cause);
        setError(refreshProgress ? `Your changes were saved. Setup could not refresh your people and progress. ${detail}` : detail);
      }
    }
  }, []);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(errorMessage(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const chooseProvider = (provider: 'elvanto' | 'planning_center' | null) => perform(async () => {
    await onStateChange({ ...state, provider, mode: undefined, peopleMethod: undefined });
    setLocalChoices(provider === null); setAdding(true);
  });
  const backToChoice = () => perform(async () => {
    await onStateChange({ ...state, provider: undefined, mode: undefined, peopleMethod: undefined });
    setLocalChoices(false);
  });
  const added = async (summary?: PeopleImportSummary) => {
    setAdding(false);
    setAssignmentSkipped(false);
    setImportSummary(summary ?? null);
    setSavedRefreshPending(true);
    await load(onPeopleAdded);
  };
  const downloadTemplate = () => perform(async () => {
    const response = await csvImportAPI.downloadTemplate();
    const url = URL.createObjectURL(new Blob([response.data], { type: 'text/tab-separated-values' }));
    const link = document.createElement('a'); link.href = url; link.download = 'people_import_template.tsv'; link.click(); URL.revokeObjectURL(url);
  });

  const providerName = state.provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const unassigned = people.filter(person => !person.gatheringAssignments?.length);
  const needsAssignment = !adding && allowManual && unassigned.length > 0 && !assignmentSkipped;
  const defaultGatheringId = gatherings.length === 1 ? gatherings[0].id : undefined;

  return <div className="space-y-5">
    {error && <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}{!ready && <button className="ml-3 underline" onClick={() => void load(savedRefreshPending ? onPeopleAdded : undefined)}>Try again</button>}</div>}
    {!ready && !error && <p role="status" className="text-gray-600 dark:text-gray-300">{savedRefreshPending ? 'Your changes were saved. Refreshing your people and setup progress…' : 'Loading your people options…'}</p>}
    {ready && <>
      {!adding && <>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{people.length ? 'Your people are here' : 'No people have been added yet'}</h2>
        <p className="text-gray-600 dark:text-gray-300">{people.length ? `${people.length} ${people.length === 1 ? 'person is' : 'people are'} in Let My People Grow.` : 'Add at least one person or family to continue with attendance by name.'}</p>
        {importSummary && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{importSummary.imported} added · {importSummary.duplicates} {importSummary.duplicates === 1 ? 'existing match' : 'existing matches'} · {importSummary.skipped} skipped</p>}
        {needsAssignment && <div className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-600">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">Add people to an attendance list</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">{unassigned.length} {unassigned.length === 1 ? 'person has' : 'people have'} no gathering yet. Choose a gathering so they appear when you take attendance.</p>
          <details className="text-sm text-gray-600 dark:text-gray-300"><summary>Show people</summary><ul className="mt-2 max-h-40 overflow-auto">{unassigned.map(person => <li key={person.id}>{person.firstName} {person.lastName}</li>)}</ul></details>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Gathering<select className="mt-1 block w-full rounded-md border border-gray-300 bg-white p-2 dark:border-gray-600 dark:bg-gray-700" value={assignmentId ?? ''} onChange={event => setAssignmentId(Number(event.target.value) || null)}><option value="">Choose a gathering</option>{gatherings.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
          <div className="flex flex-wrap gap-3"><button className={primary} disabled={busy || !assignmentId} onClick={() => void perform(async () => { if (!assignmentId) return; await csvImportAPI.massAssign(assignmentId, unassigned.map(person => person.id)); await added(); })}>Add to gathering</button><button className="text-sm text-gray-600 underline dark:text-gray-300" disabled={busy} onClick={() => setAssignmentSkipped(true)}>Assign later</button></div>
        </div>}
        <div className="flex flex-wrap gap-3"><button className={secondary} disabled={busy} onClick={() => void perform(async () => { await onStateChange({ ...state, provider: undefined, mode: undefined, peopleMethod: undefined }); setLocalChoices(false); setAdding(true); })}>Add more people</button><button className={primary} disabled={busy || !status.canFinish || needsAssignment} onClick={() => void perform(onContinue)}>Continue</button></div>
        {!status.canFinish && people.length > 0 && <p className="text-sm text-gray-600 dark:text-gray-300">Setup needs a family with at least one active person. A single person can be a family too.</p>}
      </>}

      {adding && !state.provider && !localChoices && <>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Bring your people with you</h2>
        <p className="text-gray-600 dark:text-gray-300">There are several ways to add people to Let My People Grow. First, do you use Elvanto or Planning Center to manage people in your church?</p>
        <div className="grid gap-3 sm:grid-cols-3"><button className={secondary} disabled={busy} onClick={() => void chooseProvider('elvanto')}>Elvanto</button><button className={secondary} disabled={busy || !pcoAvailable} onClick={() => void chooseProvider('planning_center')}>Planning Center</button><button className={secondary} disabled={busy || !allowManual} onClick={() => void chooseProvider(null)}>No</button></div>
        {!pcoAvailable && <p className="text-sm text-gray-500 dark:text-gray-400">{pcoCheckFailed ? 'Planning Center availability could not be checked.' : "Planning Center isn't available on this installation."}{pcoCheckFailed && <button className="ml-2 underline" onClick={() => void load()}>Try again</button>}</p>}
        {!allowManual && <p className="text-sm text-gray-600 dark:text-gray-300">Your connected service currently manages your people. Keep using its sync to add people.</p>}
      </>}

      {adding && state.provider && !state.mode && <>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Where would you like to manage your people?</h2>
        <button className={choice} disabled={busy} onClick={() => void perform(() => onStateChange({ ...state, mode: 'sync' }))}><span className="block font-semibold">Keep using {providerName} — sync people</span><span className="mt-2 block text-sm text-gray-600 dark:text-gray-300">Add and update people in {providerName}. People in your selected list or group will appear in Let My People Grow after synchronisation. Use Let My People Grow to take attendance.</span></button>
        <button className={choice} disabled={busy || !allowManual} onClick={() => void perform(() => onStateChange({ ...state, mode: 'import' }))}><span className="block font-semibold">Manage people here — one-time import</span><span className="mt-2 block text-sm text-gray-600 dark:text-gray-300">Copy people from {providerName} once, then add and update them in Let My People Grow. Later changes in {providerName} will not be synchronised.</span></button>
        <button className="text-sm underline text-gray-600 dark:text-gray-300" disabled={busy} onClick={() => void backToChoice()}>Back</button>
      </>}

      {adding && state.provider && state.mode && <>
        <PeopleImportDialog isOpen embedded initialProvider={state.provider} initialMode={state.mode} allowImport={allowManual} returnTo="/app/onboarding" defaultGatheringId={defaultGatheringId} resumeSetup onApplied={() => added()} onSyncComplete={added} onClose={() => void perform(() => onStateChange({ ...state, mode: undefined }))} />
      </>}

      {adding && !state.provider && localChoices && !state.peopleMethod && <>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Three ways to add people</h2>
        <div className="space-y-3">
          <button className={choice} disabled={busy || !allowManual} onClick={() => void perform(() => onStateChange({ ...state, peopleMethod: 'person' }))}><span className="block font-semibold">Add people manually</span><span className="mt-1 block text-sm text-gray-600 dark:text-gray-300">Start with one person or a family.</span></button>
          <button className={choice} disabled={busy || !allowManual} onClick={() => void perform(() => onStateChange({ ...state, peopleMethod: 'csv' }))}><span className="block font-semibold">Upload a spreadsheet file</span><span className="mt-1 block text-sm text-gray-600 dark:text-gray-300">Upload a TSV (tab-separated values) or CSV file using our template columns.</span></button>
          <button className={choice} disabled={busy || !allowManual} onClick={() => void perform(() => onStateChange({ ...state, peopleMethod: 'copy-paste' }))}><span className="block font-semibold">Copy and paste</span><span className="mt-1 block text-sm text-gray-600 dark:text-gray-300">Copy rows from Excel or Google Sheets and paste them here.</span></button>
        </div>
        <div className="flex flex-wrap gap-4"><button className="text-sm text-primary-700 underline dark:text-primary-300" disabled={busy} onClick={() => void downloadTemplate()}>Download template for Excel or Google Sheets</button><button className="text-sm underline text-gray-600 dark:text-gray-300" disabled={busy} onClick={() => void backToChoice()}>Back</button></div>
      </>}
      {adding && !state.provider && localChoices && state.peopleMethod && allowManual && <AddPeopleModal isOpen embedded initialMethod={state.peopleMethod} initialGatheringId={defaultGatheringId} defaultMode={gatherings[0]?.individualMode ? 'individual' : 'family'} showModeToggle people={people} gatheringTypes={gatherings.map(group => ({ ...group, dayOfWeek: group.dayOfWeek || '', startTime: group.startTime || '', frequency: group.frequency || '' }))} onClose={() => void perform(() => onStateChange({ ...state, peopleMethod: undefined }))} onSuccess={added} />}
      {adding && !state.provider && !localChoices && <button className="text-sm underline text-gray-600 dark:text-gray-300" disabled={busy} onClick={() => void perform(onBack)}>Back to gatherings</button>}
      {adding && status.canFinish && !state.mode && !state.peopleMethod && <button className={secondary} disabled={busy} onClick={() => setAdding(false)}>Done adding people</button>}
    </>}
  </div>;
}
