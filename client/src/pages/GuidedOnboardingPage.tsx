import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, onboardingAPI, type GatheringType, type GuidedOnboardingState, type GuidedOnboardingStatus } from '../services/api';
import GatheringWizard from '../components/onboarding/GatheringWizard';
import OnboardingPeopleStep from '../components/onboarding/OnboardingPeopleStep';
import LoadingSpinner from '../components/LoadingSpinner';

const primary = 'rounded-md bg-primary-600 px-5 py-3 font-medium text-white hover:bg-primary-700 disabled:opacity-50';
const secondary = 'rounded-md border border-gray-300 px-5 py-3 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 disabled:opacity-50';
function message(error: unknown) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error
    || (error instanceof Error ? error.message : 'Could not save your setup. Please try again.');
}

function resumeState(status: GuidedOnboardingStatus, gatherings: GatheringType[]): GuidedOnboardingState {
  const state = status.state || { step: 'gathering' };
  if (!status.gatheringCount) return { ...state, step: 'gathering' };
  if (state.step === 'invite' && !status.canFinish) return { ...state, step: 'people' };
  if (state.step === 'people' && !status.standardGatheringCount) return { ...state, step: 'invite' };
  if (state.step === 'gathering') {
    // The checkpoint still points at the previous gathering if the create
    // succeeded and the browser never saved the following setup step.
    const previousId = state.lastGatheringId ?? 0;
    const newestId = gatherings.reduce((latest, gathering) => Math.max(latest, gathering.id), previousId);
    if (newestId > previousId) return { ...state, step: 'gathering-created', lastGatheringId: newestId };
  }
  return state;
}

export default function GuidedOnboardingPage() {
  const { user, refreshUserData, refreshOnboardingStatus } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const start = params.get('start') === '1';
  const [status, setStatus] = useState<GuidedOnboardingStatus | null>(null);
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [state, setState] = useState<GuidedOnboardingState>({ step: 'gathering' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const response = await onboardingAPI.getStatus();
      let guided: GuidedOnboardingStatus = response.data.guided;
      if (!guided) throw new Error('Setup progress is unavailable. Please try again.');
      if (start && guided.version !== 2) guided = (await onboardingAPI.startGuided()).data.guided;
      if (current !== generation.current) return;
      if (!guided.required) { navigate('/app', { replace: true }); return; }
      const groups = await gatheringsAPI.getAll();
      if (current !== generation.current) return;
      const activeGatherings = (groups.data.gatherings || []).filter((group: GatheringType) => group.isActive !== false);
      setGatherings(activeGatherings);
      setStatus(guided); setState(resumeState(guided, activeGatherings));
    } catch (cause) { if (current === generation.current) setError(message(cause)); }
    finally { if (current === generation.current) setLoading(false); }
  }, [start, navigate, user?.church_id]);

  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  const saveState = async (next: GuidedOnboardingState) => {
    const response = await onboardingAPI.saveGuidedProgress(next);
    setStatus(response.data.guided); setState(next);
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const transition = (step: GuidedOnboardingState['step']) => perform(() => saveState({ ...state, step }));

  const created = async (gathering: { id: number; name: string; attendanceType: 'standard' | 'headcount'; individualMode?: boolean }) => {
    // Once the create endpoint succeeds, never leave a submit button that creates it again.
    const next = { ...state, step: 'gathering-created' as const, lastGatheringId: gathering.id };
    setState(next);
    setGatherings(groups => [...groups.filter(group => group.id !== gathering.id), { ...gathering, isActive: true }]);
    await perform(async () => {
      await saveState(next);
      await refreshUserData();
      localStorage.removeItem('gatherings_cached_data');
      localStorage.removeItem('checkins_available');
    });
  };

  const refreshPeople = async () => {
    const [progress, groups] = await Promise.all([onboardingAPI.getStatus(), gatheringsAPI.getAll()]);
    const guided = progress.data.guided;
    if (guided?.version !== 2) throw new Error('Setup progress is unavailable. Please try again.');
    setStatus(guided);
    setGatherings((groups.data.gatherings || []).filter((group: GatheringType) => group.isActive !== false));
  };

  const finish = (deferred: boolean) => perform(async () => {
    const { data } = await onboardingAPI.getStatus();
    const guided = data.guided as GuidedOnboardingStatus | undefined;
    const alreadyCompleted = guided?.required === false && (data.completed === true || data.completed === 1);
    if (guided?.version !== 2 || (guided.required !== true && !alreadyCompleted)) {
      throw new Error('Setup progress is unavailable. Please try again.');
    }

    const latestState = guided.state ?? state;
    const inviteDeferred = alreadyCompleted ? latestState.inviteDeferred === true : deferred;
    if (!alreadyCompleted) {
      if (!guided.canFinish) {
        setStatus(guided);
        throw new Error('The saved gathering or people have changed. Go back to finish setting them up.');
      }
      await saveState({ ...latestState, step: 'invite', inviteDeferred });
      await onboardingAPI.complete();
    }
    await refreshOnboardingStatus(true);
    await refreshUserData(true);
    localStorage.removeItem('gatherings_cached_data');
    localStorage.removeItem('checkins_available');
    if (inviteDeferred) localStorage.setItem(`invite_hint:${user?.church_id}:${user?.id}`, 'show');
    const gathering = gatherings.find(group => group.id === latestState.lastGatheringId) || gatherings[0];
    navigate(`/app/attendance${gathering ? `?gathering=${gathering.id}` : ''}`, { replace: true, state: { inviteHint: inviteDeferred } });
  });

  if (loading) return <LoadingSpinner />;
  if (!status) return <div className="mx-auto max-w-lg p-8"><p role="alert" className="mb-4 text-red-700 dark:text-red-300">{error}</p><button className={primary} onClick={() => void load()}>Try again</button></div>;
  const hasStandard = status.standardGatheringCount > 0 || gatherings.some(group => group.attendanceType === 'standard');
  const steps = hasStandard || !status.gatheringCount ? ['Gatherings', 'People', 'Invite users'] : ['Gatherings', 'Invite users'];
  const active = state.step.startsWith('gathering') ? 'Gatherings' : state.step === 'people' ? 'People' : 'Invite users';
  const lastGathering = gatherings.find(group => group.id === state.lastGatheringId) || gatherings.at(-1);

  return <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
    <header className="mb-8">
      <p className="text-sm font-medium text-primary-700 dark:text-primary-300">Welcome to Let My People Grow</p>
      <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">Let's get your church ready</h1>
      <nav aria-label="Setup progress" className="mt-6"><ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{steps.map((step, index) => <li key={step} aria-current={step === active ? 'step' : undefined} className={step === active ? 'font-semibold text-primary-700 dark:text-primary-300' : 'text-gray-500 dark:text-gray-400'}>{index + 1}. {step}</li>)}</ol></nav>
    </header>
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8 dark:border-gray-700 dark:bg-gray-800">
      {['cancelled', 'error'].includes(params.get('pco') || '') && <p role="status" className="mb-5 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">{params.get('pco') === 'cancelled' ? 'Planning Center connection was cancelled.' : 'Planning Center could not be connected.'} Your setup is saved. Try connecting again, or go Back to choose another way to add people.</p>}
      {error && <div role="alert" className="mb-5 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}
      {state.step === 'gathering' && <GatheringWizard onCreated={created} timeZone={user?.timezone} onCancel={status.gatheringCount ? () => void transition('gathering-created') : undefined} />}
      {state.step === 'gathering-created' && <div className="space-y-5">
        <p className="text-sm font-medium text-green-700 dark:text-green-300">{lastGathering ? `${lastGathering.name} is ready.` : 'Your gathering is ready.'}</p>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Want to create another gathering?</h2>
        <p className="text-gray-600 dark:text-gray-300">You can add more gatherings now or come back to them later.</p>
        <div className="flex flex-wrap gap-3"><button disabled={busy} className={secondary} onClick={() => void transition('gathering')}>Create another gathering</button><button disabled={busy} className={primary} onClick={() => void transition(hasStandard ? 'people' : 'invite')}>{hasStandard ? 'Add people' : 'Continue'}</button></div>
      </div>}
      {state.step === 'people' && <OnboardingPeopleStep state={state} status={status} gatherings={gatherings.filter(group => group.attendanceType === 'standard')} onStateChange={saveState} onPeopleAdded={refreshPeople} onContinue={() => transition('invite')} onBack={() => transition('gathering-created')} />}
      {state.step === 'invite' && <div className="space-y-5">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Would you like someone else to help take attendance?</h2>
        <p className="text-gray-600 dark:text-gray-300">Invite your team and choose which gatherings they can help with. You can always invite more users later.</p>
        <div className="flex flex-wrap gap-3">
          <button className={primary} disabled={busy || !status.canFinish} onClick={() => void perform(async () => { await saveState({ ...state, step: 'invite' }); navigate('/app/users?onboarding=1'); })}>Invite users</button>
          <button className={secondary} disabled={busy || !status.canFinish} onClick={() => void finish(true)}>Not now</button>
          {params.get('invited') === '1' && <button className={primary} disabled={busy} onClick={() => void finish(false)}>Finish setup</button>}
        </div>
        {params.get('invited') === '1' && <p role="status" className="text-green-700 dark:text-green-300">User invited. You can invite another person or finish setup.</p>}
        <button className="text-sm text-gray-600 underline dark:text-gray-300" disabled={busy} onClick={() => void transition(hasStandard ? 'people' : 'gathering-created')}>Back</button>
      </div>}
    </section>
    <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">Your completed steps are saved. You can return to setup after signing in again.</p>
  </main>;
}
