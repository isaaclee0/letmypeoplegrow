// Prototype: one list of people to sort, each with its recommended answer
// already chosen. Dev-only until the design settles (see
// src/dev/SyncDecisionPrototypePage.tsx). Submits the same signed
// selections payload as SyncReview.
import React, { useEffect, useMemo, useState } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CheckCircleIcon, ChevronDownIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid';
import PeoplePickerDialog from './PeoplePickerDialog';
import OutsideSourceReviewSection from './OutsideSourceReviewSection';
import GatheringReviewFilter, { filterGatheringReview, reviewGatherings, type ReviewGathering } from './GatheringReviewFilter';
import { withoutCoveredHouseholdWarnings } from './HouseholdChoiceEditor';
import { useChurchTime } from '../../hooks/useChurchTime';
import { isRefreshOnlyReviewError, peopleSyncErrorMessage } from './apiError';
import type {
  FamilyConflictAction,
  KeptReconciliation,
  PeopleReviewToken,
  PeopleSyncFamilyDisplay,
  PeopleSyncOperationReview,
  PeopleSyncPersonDisplay,
  PeopleSyncSelections,
  SyncProvider,
} from './types';
import {
  automaticChanges,
  buildDecisionGroups,
  choiceChangesData,
  choiceIsRemembered,
  initialChoices,
  linkCollisions,
  compactNames,
  nameOf,
  sameChoice,
  toSelections,
  type Choices,
  type DecisionChoice,
  type DecisionItem,
} from './syncDecisionModel';

export interface SyncDecisionListProps {
  review: PeopleSyncOperationReview;
  provider: SyncProvider;
  batchName?: string;
  gatherings?: ReviewGathering[];
  applying?: boolean;
  interactionDisabled?: boolean;
  applyBlocked?: boolean;
  onRefresh?: () => void | Promise<void>;
  onApply: (reviewToken: PeopleReviewToken<'people_sync'>, selections: PeopleSyncSelections) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Forget a kept difference so it comes back on the next review. */
  onAskAgain?: (kept: KeptReconciliation) => void | Promise<void>;
}

interface Option {
  key: string;
  choice: DecisionChoice;
  /** How the decision reads once chosen. */
  statement: string;
  /** What that means, in a few words. */
  consequence: string;
  /** Menu wording when it differs from the statement. */
  menuLabel?: string;
  recommended?: boolean;
  opensPicker?: boolean;
}

interface DecisionView {
  reason: string;
  options: Option[];
  provider: React.ReactNode;
  lmpg: React.ReactNode;
  after: React.ReactNode;
  /** Short verb phrase for the footer when this choice changes data. */
  summary: string | null;
}

const unresolvedCopy: Record<string, string> = {
  household_member_outside_source: 'This move would separate members of the same household. One of them is outside the source list.',
  unresolved_household_members: 'Some household members need matching first.',
  invalid_existing_family_link: 'The existing household link needs checking first.',
  missing_family_name: 'The source household needs a name before LMPG can use it.',
  multiple_provider_households: 'Some people belong to more than one source household. LMPG supports one family per person and can’t choose between them automatically.',
  unknown_household_membership: 'Household details are incomplete or inconsistent in this sync. Refresh the review; if this persists, the connection or sync needs checking.',
  conflicting_family_ownership: 'This LMPG family is already linked to a different household.',
};

function familyName(family: PeopleSyncFamilyDisplay | undefined, none = 'No family'): string {
  if (family?.state === 'known') return family.name || 'Unnamed family';
  return family?.state === 'none' ? none : 'Family unknown';
}

const quote = (value: string) => `“${value}”`;
const KEEP_CONSEQUENCE = 'LMPG stays as it is. You won’t be asked again unless something changes.';

// SQLite's datetime('now') is UTC without a zone marker.
const asInstant = (value: string | null) => (value && !/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);

function describeKept(review: PeopleSyncOperationReview, kept: KeptReconciliation, providerName: string): { title: string; detail: string } {
  const directory = review.plan.people || { external: {}, local: {} };
  if (kept.bucket === 'removeFromGathering') {
    const action = kept.action as { individualId: number; gatheringName?: string | null };
    const gathering = action.gatheringName || 'this attendance list';
    return { title: nameOf(directory.local[String(action.individualId)]), detail: `Kept on ${gathering} · not on the ${providerName} list` };
  }
  const action = kept.action as FamilyConflictAction;
  const moves = action.resolution?.moves || [];
  const movers = moves.map((move) => directory.local[String(move.individualId)]);
  const families = [...new Set(movers.map((person) => familyName(person?.family)))];
  if (action.resolution?.kind === 'detach' || action.resolution?.kind === 'single_person') {
    return { title: nameOf(movers[0]), detail: `${moves[0]?.fromFamilyId === null ? 'Kept without a family' : `Kept in ${quote(families[0] || 'their family')}`} · no household in ${providerName}` };
  }
  const people = (action.memberExternalIds || []).map((id) => directory.external[id]).filter(Boolean);
  return {
    title: compactNames(people.length ? people : movers.filter(Boolean)),
    detail: families.length > 1 ? `Kept in separate families · one household in ${providerName}` : `Kept in ${quote(families[0] || 'their family')}`,
  };
}
const firstName = (person: PeopleSyncPersonDisplay | undefined) => person?.firstName?.trim() || nameOf(person);
const Muted = ({ children }: { children: React.ReactNode }) => <span className="block font-normal text-gray-500 dark:text-gray-400">{children}</span>;

function describe(
  review: PeopleSyncOperationReview,
  decision: DecisionItem,
  choice: DecisionChoice,
  groupTitle: string,
  providerName: string,
): DecisionView {
  const plan = review.plan;
  const directory = plan.people || { external: {}, local: {} };
  const later = (consequence: string): Option => ({ key: 'later', choice: { kind: 'later' }, statement: 'Decide later', consequence });

  if (decision.kind === 'outsideSourceMatch') {
    const action = plan.archive.find((entry) => entry.id === decision.actionId);
    const local = directory.local[String(decision.individualId)];
    const external = directory.external[decision.externalId || ''] || {
      firstName: action?.externalFirstName || '', lastName: action?.externalLastName || '',
    };
    const label = action?.linkRequired ? 'Link and archive' : 'Archive in LMPG';
    const selected = choice.kind === 'accept';
    return {
      reason: 'Active in Planning Center, but outside every enabled sync list.',
      options: [
        { key: 'accept', choice: { kind: 'accept' }, statement: label,
          consequence: action?.linkRequired ? `Link ${nameOf(local)} to ${nameOf(external)} and archive their existing LMPG record` : 'Archive their existing LMPG record; keep the Planning Center link' },
        { key: 'later', choice: { kind: 'later' }, statement: 'Keep active for now', consequence: 'Stays active and unchanged in LMPG' },
      ],
      provider: <>{nameOf(external)}<Muted>Active · outside every enabled sync list</Muted><Muted>{action?.pcoHouseholdNames?.join(', ') || 'No Planning Center household'}</Muted>{!!action?.sourceNames?.length && <Muted>Checked lists: {action.sourceNames.join(', ')}</Muted>}</>,
      lmpg: <>{nameOf(local)}<Muted>Active · {familyName(local?.family)}</Muted><Muted>{action?.linkRequired ? 'Not linked to Planning Center' : 'Linked to Planning Center'}</Muted></>,
      after: selected ? <>Archived in LMPG<Muted>{action?.linkRequired ? `Linked to ${nameOf(external)}` : 'Existing Planning Center link kept'}</Muted><Muted>Attendance history is kept.</Muted><Muted>Planning Center stays unchanged.</Muted></> : 'Active and unchanged in LMPG',
      summary: selected ? `${label} ${nameOf(local)}` : null,
    };
  }

  if (decision.kind === 'identity' && decision.externalId) {
    const entry = plan.reviewContext?.identities[decision.externalId];
    const external = directory.external[decision.externalId]
      || (entry?.createPerson ? { firstName: entry.createPerson.firstName, lastName: entry.createPerson.lastName } : undefined);
    const name = nameOf(external);
    const suggestedId = entry?.suggestedIndividualId ?? null;
    const suggested = suggestedId === null ? undefined : directory.local[String(suggestedId)];
    const linked = choice.kind === 'link' ? directory.local[String(choice.individualId)] : undefined;
    const household = directory.external[decision.externalId]?.family;
    const create = entry?.createPerson;
    const singlePersonFamilyName = plan.addFamilies.find((family) => family.singlePersonExternalId === decision.externalId)?.familyName
      || create?.singlePersonFamilyName;
    const gatheringCount = entry?.gatheringAssignments?.length || 0;
    const gatheringConsequence = gatheringCount > 0
      ? <Muted>Joins {gatheringCount} attendance {gatheringCount === 1 ? 'list' : 'lists'} in this sync</Muted>
      : null;
    const newPersonDetails = [
      create?.peopleType === 'regular' ? 'Regular' : create?.peopleType === 'local_visitor' ? 'Local visitor' : 'Visitor',
      create?.isChild ? 'child' : null,
      singlePersonFamilyName ? `in ${quote(singlePersonFamilyName)}`
        : household?.state === 'known' ? `in ${quote(household.name)}` : 'no family',
    ].filter(Boolean).join(', ');
    const options: Option[] = [];
    if (suggestedId !== null) {
      options.push({ key: 'accept', choice: { kind: 'accept' }, statement: `Same person as ${nameOf(suggested)}`, consequence: 'Links to their existing LMPG record', recommended: true });
    }
    if (entry?.canCreate) {
      options.push({ key: 'create', choice: { kind: 'create' }, statement: 'Add as a new person', consequence: newPersonDetails, recommended: suggestedId === null });
    }
    options.push({
      key: 'link',
      choice: choice.kind === 'link' ? choice : { kind: 'later' },
      statement: `Same person as ${nameOf(linked)}`,
      consequence: 'Links to their existing LMPG record',
      menuLabel: choice.kind === 'link' ? 'A different LMPG person…' : 'Someone already in LMPG…',
      opensPicker: true,
    });
    options.push(later('Not added; asked again next sync'));
    return {
      reason: [
        suggestedId !== null ? `Looks like ${nameOf(suggested)}, who’s already in LMPG.` : `New in ${providerName}. Nobody in LMPG looks like a match.`,
        decision.held ? 'You left this for later last time.' : '',
      ].filter(Boolean).join(' '),
      options,
      provider: <>{name}<Muted>{familyName(household, 'No household')}</Muted></>,
      lmpg: suggested ? <>{nameOf(suggested)}<Muted>{familyName(suggested.family)}</Muted></> : 'Not in LMPG',
      after: choice.kind === 'accept' ? <>Linked to {nameOf(suggested)}<Muted>{familyName(suggested?.family)}</Muted>{gatheringConsequence}</>
        : choice.kind === 'create' ? <>New person<Muted>{newPersonDetails}</Muted>{gatheringConsequence}</>
          : choice.kind === 'link' ? <>Linked to {nameOf(linked)}<Muted>{familyName(linked?.family)}</Muted>{gatheringConsequence}</>
            : 'Not in LMPG',
      summary: choice.kind === 'create' ? `Add ${name}`
        : choice.kind === 'accept' ? `Link ${name}`
          : choice.kind === 'link' ? `Link ${name} to ${nameOf(linked)}` : null,
    };
  }

  if (decision.kind === 'household') {
    const action = plan.familyConflicts.find((entry: FamilyConflictAction) => entry.id === decision.actionId)
      || plan.familyConflicts[Number(decision.id.split(':').pop())];
    const resolution = action?.resolution;
    const moves = resolution?.moves || [];
    const movers = moves.map((move) => directory.local[String(move.individualId)]);
    const fromFamilies = [...new Set(movers.map((person) => familyName(person?.family)))];
    const externalMembers = (action?.memberExternalIds || []).map((id) => nameOf(directory.external[id]));
    if (!resolution) {
      return {
        reason: unresolvedCopy[String(action?.reason)] || `${providerName} and LMPG don’t agree about this household.`,
        options: [],
        provider: action?.externalFamilyName || 'Household',
        lmpg: fromFamilies.join(', ') || 'Unknown',
        after: 'No change',
        summary: null,
      };
    }
    if (resolution.kind === 'detach') {
      const person = movers[0];
      const from = fromFamilies[0] || 'their family';
      return {
        reason: `${providerName} no longer has ${firstName(person)} in a household.`,
        options: [
          { key: 'accept', choice: { kind: 'accept' }, statement: `Separate from ${quote(from)}`, consequence: `${firstName(person)} will have no family`, recommended: true },
          { key: 'keep', choice: { kind: 'keep' }, statement: `Keep in ${quote(from)}`, consequence: KEEP_CONSEQUENCE },
          later('No change for now; asked again next sync'),
        ],
        provider: 'No household',
        lmpg: `In ${quote(from)}`,
        after: choice.kind === 'accept'
          ? <>No family<Muted>{quote(from)} keeps its name and other members</Muted></>
          : `In ${quote(from)}`,
        summary: choice.kind === 'accept' ? `Separate ${nameOf(person)} from ${quote(from)}` : null,
      };
    }
    if (resolution.kind === 'single_person') {
      const person = movers[0];
      const destinationName = resolution.destination.kind === 'none' ? '' : resolution.destination.familyName;
      const current = moves[0]?.fromFamilyId === null ? 'No family' : `In ${quote(fromFamilies[0] || 'their family')}`;
      return {
        reason: `${providerName} has no household for ${firstName(person)}. LMPG can give them a family of their own.`,
        options: [
          { key: 'accept', choice: { kind: 'accept' }, statement: `Create ${quote(destinationName || nameOf(person))}`,
            consequence: 'A single-person family in LMPG', recommended: true },
          { key: 'keep', choice: { kind: 'keep' }, statement: moves[0]?.fromFamilyId === null ? 'Keep without a family' : `Keep in ${quote(fromFamilies[0] || 'their family')}`, consequence: KEEP_CONSEQUENCE },
          later('No change for now; asked again next sync'),
        ],
        provider: `No household in ${providerName}`,
        lmpg: current,
        after: choice.kind === 'accept'
          ? <>{destinationName}<Muted>A later {providerName} household change will still be reviewed</Muted></>
          : current,
        summary: choice.kind === 'accept' ? `Create a family for ${nameOf(person)}` : null,
      };
    }
    const destination = resolution.destination;
    const destinationName = destination.kind === 'none' ? 'no family' : destination.familyName || 'existing family';
    const leftAsIs = `${fromFamilies.map(quote).join(' and ')} ${fromFamilies.length > 1 ? 'are' : 'is'} left as ${fromFamilies.length > 1 ? 'they are' : 'it is'}`;
    return {
      reason: fromFamilies.length > 1
        ? `One household in ${providerName}, but ${fromFamilies.length} separate families in LMPG.`
        : `${providerName} has them in a different household from LMPG.`,
      options: [
        {
          key: 'accept', choice: { kind: 'accept' }, recommended: true,
          statement: `Put together in ${quote(destinationName)}`,
          consequence: destination.kind === 'create' ? 'Creates a new family for them' : 'Moves them into that family',
        },
        { key: 'keep', choice: { kind: 'keep' }, statement: fromFamilies.length > 1 ? 'Keep separate families' : 'Keep LMPG’s family', consequence: KEEP_CONSEQUENCE },
        later('No change for now; asked again next sync'),
      ],
      provider: <>{action?.externalFamilyName || 'Household'}<Muted>{externalMembers.join(', ')}</Muted></>,
      lmpg: <>{movers.map((person, index) => <span key={moves[index].individualId} className="block">{firstName(person)} <span className="text-gray-500 dark:text-gray-400">in {quote(familyName(person?.family))}</span></span>)}</>,
      after: choice.kind === 'accept' ? <>Together in {quote(destinationName)}<Muted>{leftAsIs}</Muted></> : 'Unchanged',
      summary: choice.kind === 'accept' ? `Put ${groupTitle} together` : null,
    };
  }

  const person = decision.individualId === undefined ? undefined : directory.local[String(decision.individualId)];
  if (decision.kind === 'listRemoval') {
    const action = plan.removeFromGathering.find((entry) => entry.id === decision.actionId);
    const gathering = action?.gatheringName || 'this attendance list';
    const source = action?.sourceNames?.join(' / ') || `the ${providerName} list`;
    return {
      reason: `No longer on the ${providerName} list that feeds ${gathering}.`,
      options: [
        { key: 'accept', choice: { kind: 'accept' }, statement: `Remove from ${gathering}`, consequence: 'Stays in LMPG; attendance history kept', recommended: true },
        { key: 'keep', choice: { kind: 'keep' }, statement: `Keep on ${gathering}`, consequence: KEEP_CONSEQUENCE },
        later('No change for now; asked again next sync'),
      ],
      provider: `Not in ${quote(source)}`,
      lmpg: `On ${gathering}`,
      after: choice.kind === 'accept' ? <>Off {gathering}<Muted>Attendance history kept</Muted></> : `On ${gathering}`,
      summary: choice.kind === 'accept' ? `Take ${nameOf(person)} off ${gathering}` : null,
    };
  }

  return {
    reason: `No longer active in ${providerName}.`,
    options: [
      { key: 'accept', choice: { kind: 'accept' }, statement: 'Archive', consequence: 'Attendance history kept', recommended: true },
      later('Stays active for now; asked again next sync'),
    ],
    provider: 'Inactive',
    lmpg: 'Active',
    after: choice.kind === 'accept' ? <>Archived<Muted>Attendance history kept</Muted></> : 'Active',
    summary: choice.kind === 'accept' ? `Archive ${nameOf(person)}` : null,
  };
}

export default function SyncDecisionList({
  review: receivedReview,
  provider,
  batchName,
  gatherings,
  applying: externallyApplying = false,
  interactionDisabled = false,
  applyBlocked = false,
  onRefresh,
  onApply,
  onDirtyChange,
  onAskAgain,
}: SyncDecisionListProps) {
  const { formatInstant } = useChurchTime();
  const review = useMemo(() => ({ ...receivedReview, plan: withoutCoveredHouseholdWarnings(receivedReview.plan) }), [receivedReview]);
  const providerName = provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const groups = useMemo(() => buildDecisionGroups(review), [review]);
  const initial = useMemo(() => initialChoices(groups), [groups]);
  const [choices, setChoices] = useState<Choices>(initial);
  const [outsideSearch, setOutsideSearch] = useState('');
  const [gatheringFilter, setGatheringFilter] = useState('all');
  const [pickerFor, setPickerFor] = useState<DecisionItem | null>(null);
  const [askingAgain, setAskingAgain] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const applying = externallyApplying || submitting || askingAgain !== null;
  const kept = review.plan.keptReconciliations || [];
  const gatheringOptions = useMemo(() => reviewGatherings(review, gatherings), [review, gatherings]);
  const automatic = useMemo(() => automaticChanges(review, gatheringOptions), [review, gatheringOptions]);
  const displayedReview = filterGatheringReview(review, gatheringFilter);
  const shownAutomatic = automaticChanges(displayedReview, gatheringOptions);
  const collisions = useMemo(() => linkCollisions(review, groups, choices), [review, groups, choices]);
  const directory = review.plan.people || { external: {}, local: {} };

  useEffect(() => { setChoices(initial); setError(null); setRefreshRequired(false); }, [initial]);
  const dirty = Object.keys(initial).some((id) => !sameChoice(initial[id], choices[id]));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const choose = (decision: DecisionItem, option: Option) => {
    if (option.opensPicker) setPickerFor(decision);
    else setChoices((current) => ({ ...current, [decision.id]: option.choice }));
  };

  const views = groups.map((group) => ({
    group,
    rows: group.decisions.map((decision) => ({ decision, view: describe(review, decision, choices[decision.id], group.title, providerName) })),
  }));
  const allRows = views.flatMap((entry) => entry.rows);
  const outsideViews = views.flatMap(({ group, rows }) => rows.filter((row) => row.decision.kind === 'outsideSourceMatch').map((row) => ({
    group: { ...group, key: `outside:${row.decision.id}`, title: nameOf(directory.local[String(row.decision.individualId)]), decisions: [row.decision], needsYou: false },
    rows: [row],
  })));
  const outsideCount = outsideViews.length;
  const collapseOutside = outsideCount > 5;
  const outsideSelectedCount = outsideViews.filter(({ rows }) => choices[rows[0].decision.id]?.kind === 'accept').length;
  const mainViews = collapseOutside ? views.map(({ group, rows }) => {
    const ordinaryRows = rows.filter((row) => row.decision.kind !== 'outsideSourceMatch');
    return { group: { ...group, needsYou: ordinaryRows.some((row) => row.decision.priority === 0) }, rows: ordinaryRows };
  }).filter(({ rows }) => rows.length > 0) : views;
  const visibleRemovalIds = new Set(displayedReview.plan.removeFromGathering.map((action) => action.id));
  const shownMainViews = mainViews.map((entry) => ({ ...entry,
    rows: entry.rows.filter(({ decision }) => decision.kind !== 'listRemoval' || visibleRemovalIds.has(decision.actionId || '')),
  })).filter((entry) => entry.rows.length > 0);
  const outsideQuery = outsideSearch.trim().toLocaleLowerCase();
  const shownOutsideViews = outsideViews.filter(({ group, rows }) => {
    const decision = rows[0].decision;
    const action = review.plan.archive.find((entry) => entry.id === decision.actionId);
    const external = directory.external[decision.externalId || ''] || { firstName: action?.externalFirstName || '', lastName: action?.externalLastName || '' };
    return `${group.title} ${nameOf(external)}`.toLocaleLowerCase().includes(outsideQuery);
  });
  const summaries = allRows.map((row) => row.view.summary).filter((value): value is string => !!value);
  const automaticCount = automatic.reduce((total, entry) => total + entry.names.length, 0);
  const changeCount = allRows.filter((row) => choiceChangesData(choices[row.decision.id]) && !row.decision.needsInfo).length;
  const keptCount = allRows.filter((row) => choiceIsRemembered(row.decision, choices[row.decision.id])).length;
  const laterCount = allRows.length - changeCount - keptCount - (collapseOutside ? outsideCount - outsideSelectedCount : 0);
  const newDeferrals = allRows.filter((row) => row.decision.kind === 'identity' && !row.decision.held
    && choices[row.decision.id]?.kind === 'later').length;
  const householdChoiceCount = Object.keys(review.plan.householdChoices?.edits || {}).length;
  const sourceChangeCount = review.plan.sourceContext?.promotions?.length || 0;
  const total = changeCount + automaticCount + householdChoiceCount + sourceChangeCount;
  const applyDisabled = applying || interactionDisabled || applyBlocked || refreshRequired || collisions.size > 0 || (total === 0 && newDeferrals === 0 && keptCount === 0);
  const fetchedAt = review.snapshot?.fetchedAt || review.plan.snapshot?.fetchedAt || null;
  const needsYou = mainViews.filter(({ group }) => group.needsYou).length;

  const claimedBy = useMemo(() => {
    const claims = new Map<number, string>();
    const context = review.plan.reviewContext;
    for (const [externalId, link] of Object.entries(context?.projectedEstablishedLinks || context?.establishedLinks || {})) {
      claims.set(link.individualId, externalId);
    }
    for (const [decisionId, choice] of Object.entries(choices)) {
      if (!decisionId.startsWith('identity:')) continue;
      const externalId = decisionId.slice('identity:'.length);
      const target = choice?.kind === 'link' ? choice.individualId
        : choice?.kind === 'accept' ? context?.identities[externalId]?.suggestedIndividualId : null;
      if (target !== null && target !== undefined) claims.set(target, externalId);
    }
    for (const action of review.plan.archive) {
      if (action.reason === 'outside_all_sync_sources' && action.linkRequired
        && choices[`outside-source:${action.id}`]?.kind === 'accept') claims.set(action.individualId, action.externalPersonId);
    }
    return claims;
  }, [review, choices]);

  const submit = async () => {
    if (applyDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onApply(review.reviewToken, {
        ...toSelections(review, groups, choices),
        ...(review.plan.householdChoices ? { householdChoices: review.plan.householdChoices.edits } : {}),
      });
    } catch (cause) {
      setError(peopleSyncErrorMessage(cause, 'Failed to apply this review.'));
      setRefreshRequired(isRefreshOnlyReviewError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const renderCards = (entries: typeof views, label: string) => (
    <fieldset disabled={applying || interactionDisabled}><ol className="mt-4 space-y-3" aria-label={label}>
          {entries.map(({ group, rows }) => (
            <li key={group.key} data-testid={`decision-card-${group.key}`}
              className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
                <h4 className="text-base font-semibold text-gray-950 dark:text-white">{group.title}</h4>
                {group.needsYou && <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Needs you</span>}
              </div>
              {rows.map(({ decision, view }) => (
                <section key={decision.id} aria-label={view.reason}>
                  <div className="px-5 pb-4 pt-1">
                    <p className="text-sm text-gray-600 dark:text-gray-300">{view.reason}</p>
                    {view.options.length > 0
                      ? <DecisionLine view={view} choice={choices[decision.id]} onChoose={(option) => choose(decision, option)} />
                      : <p className="mt-3 flex items-start gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                        <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        No household changes will be made for this case. Other reviewed changes can still be applied.
                      </p>}
                    {collisions.get(decision.id) && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{collisions.get(decision.id)}</p>}
                  </div>
                  <DetailsBand view={view} providerName={providerName} />
                </section>
              ))}
            </li>
          ))}
        </ol></fieldset>
  );

  return (
    <div className="text-gray-900 dark:text-gray-100">
      <header className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-950 dark:text-white">{providerName} sync review</h3>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {batchName && <span>{batchName} · </span>}
              {fetchedAt ? <>Fetched <time dateTime={fetchedAt}>{formatInstant(fetchedAt, { dateStyle: 'medium', timeStyle: 'short' })}</time></> : 'Fetch time unknown'}
            </p>
          </div>
          {onRefresh && (
            <button type="button" onClick={() => void onRefresh()} disabled={applying || interactionDisabled}
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-primary-700 hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:text-primary-300 dark:hover:bg-primary-950/40">
              Refresh
            </button>
          )}
        </div>
        <p className="mt-4 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">
          {mainViews.length === 0
            ? collapseOutside ? 'No other reconciliation decisions are pending.' : review.plan.householdChoices?.groups.length ? 'Review the LMPG household choices and their preview above.' : `Everyone matches ${providerName}. Nothing needs a decision.`
            : <>
              <strong className="font-semibold">{mainViews.length} {mainViews.length === 1 ? 'person or household' : 'people and households'} to review.</strong>{' '}
              Each one has the recommended answer chosen{needsYou ? `, apart from ${needsYou} that need${needsYou === 1 ? 's' : ''} you` : ''}. Change anything that’s wrong.
            </>}
        </p>
        {collapseOutside && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Outside-list archiving is optional; those people stay active unless you select them below.</p>}
        {shownAutomatic.length > 0 && (
          <details className="mt-3 text-sm text-gray-600 dark:text-gray-300">
            <summary className="cursor-pointer select-none">
              Also applied automatically: {shownAutomatic.map((entry) => `${entry.names.length} ${entry.label}`).join(', ')}
            </summary>
            <ul className="mt-2 space-y-1 pl-4">
              {shownAutomatic.map((entry) => <li key={entry.label}><span className="font-medium">{entry.label}:</span> {entry.names.join(', ')}</li>)}
            </ul>
          </details>
        )}
      </header>

      {gatherings && <GatheringReviewFilter gatherings={gatheringOptions} value={gatheringFilter}
        onChange={setGatheringFilter} disabled={applying || interactionDisabled} />}
      {shownMainViews.length > 0 && renderCards(shownMainViews, 'People to review')}
      {gatheringFilter !== 'all' && mainViews.length > 0 && shownMainViews.length === 0 && <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">No decisions are shown for this gathering. Your selections in other gatherings are kept.</p>}
      {collapseOutside && <OutsideSourceReviewSection count={outsideCount} selectedCount={outsideSelectedCount}
        shownCount={shownOutsideViews.length} search={outsideSearch} onSearchChange={setOutsideSearch}>
        {renderCards(shownOutsideViews, 'People outside synced lists')}
      </OutsideSourceReviewSection>}

      {kept.length > 0 && (
        <details className="group mt-4 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm dark:border-gray-700 dark:bg-gray-800">
          <summary className="flex cursor-pointer select-none list-none items-baseline gap-1 [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon aria-hidden="true" className="h-4 w-4 shrink-0 self-center text-gray-400 transition-transform -rotate-90 group-open:rotate-0" />
            <span className="font-medium text-gray-800 dark:text-gray-100">Kept as is</span>
            <span className="ml-1 text-gray-500 dark:text-gray-400">({kept.length})</span>
            <span className="ml-2 text-gray-500 dark:text-gray-400">Differences you chose to leave alone. They come back if anything changes.</span>
          </summary>
          <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700/70">
            {kept.map((entry) => {
              const { title, detail } = describeKept(review, entry, providerName);
              const keptAt = asInstant(entry.keptAt);
              return (
                <li key={entry.keepId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{title}</p>
                    <p className="text-gray-500 dark:text-gray-400">
                      {detail}{keptAt ? ` · kept ${formatInstant(keptAt, { dateStyle: 'medium' })}` : ''}
                    </p>
                  </div>
                  {onAskAgain && (
                    <button type="button" disabled={applying || askingAgain !== null}
                      onClick={async () => {
                        setAskingAgain(entry.keepId);
                        setError(null);
                        try { await onAskAgain(entry); }
                        catch (cause) { setError(peopleSyncErrorMessage(cause, 'Failed to bring back this decision.')); }
                        finally { setAskingAgain(null); }
                      }}
                      className="rounded-md px-2.5 py-1.5 font-medium text-primary-700 hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:text-primary-300 dark:hover:bg-primary-950/40">
                      {askingAgain === entry.keepId ? 'Bringing back…' : 'Ask again'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">{error}</p>}

      <footer className="sticky bottom-0 z-10 mt-4 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:bg-gray-800/95">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {total === 0 ? 'Nothing in LMPG will change yet.' : `${total} ${total === 1 ? 'change' : 'changes'} will be made in LMPG.`}
            {(keptCount > 0 || laterCount > 0) && (
              <span className="font-normal text-gray-500 dark:text-gray-400">
                {' '}{[keptCount > 0 ? `${keptCount} kept as is` : '', laterCount > 0 ? `${laterCount} for later` : ''].filter(Boolean).join(', ')}.
              </span>
            )}
          </p>
          {summaries.length > 0 && (
            <p className="mt-0.5 truncate text-gray-600 dark:text-gray-300" title={summaries.join(' · ')}>
              {summaries.join(' · ')}{automaticCount > 0 ? ` · ${automaticCount} automatic` : ''}
            </p>
          )}
          {householdChoiceCount > 0 && <p className="mt-1 text-gray-600 dark:text-gray-300">Save {householdChoiceCount} household {householdChoiceCount === 1 ? 'choice' : 'choices'} and any reviewed display names.</p>}
          {sourceChangeCount > 0 && <p className="mt-1 text-gray-600 dark:text-gray-300">Save {sourceChangeCount} list source {sourceChangeCount === 1 ? 'change' : 'changes'} reviewed above.</p>}
          {applyBlocked && <p className="mt-1 text-amber-800 dark:text-amber-200">Preview the latest household choices before applying.</p>}
          {collisions.size > 0 && <p className="mt-1 text-red-700 dark:text-red-300">Two people are matched to the same LMPG person. Fix that first.</p>}
        </div>
        <button type="button" onClick={submit} disabled={applyDisabled}
          className="shrink-0 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600 disabled:shadow-none dark:focus:ring-offset-gray-900 dark:disabled:bg-gray-700 dark:disabled:text-gray-400">
          {applying ? 'Applying…' : total > 0 ? `Apply ${total} ${total === 1 ? 'change' : 'changes'}` : keptCount > 0 || newDeferrals > 0 ? 'Save choices' : 'Nothing to apply'}
        </button>
      </footer>

      {pickerFor?.externalId && (
        <PeoplePickerDialog
          open
          externalId={pickerFor.externalId}
          directory={directory}
          availableIndividualIds={new Set(review.plan.reviewContext?.manualCandidateIndividualIds || [])}
          claimedBy={claimedBy}
          allowCreate={review.plan.reviewContext?.identities[pickerFor.externalId]?.canCreate === true}
          selectedIndividualId={choices[pickerFor.id]?.kind === 'link' ? (choices[pickerFor.id] as { individualId: number }).individualId : null}
          excludedIndividualIds={review.plan.reviewContext?.identities[pickerFor.externalId]?.excludedIndividualIds || []}
          onSelectPerson={(individualId) => { setChoices((current) => ({ ...current, [pickerFor.id]: { kind: 'link', individualId } })); setPickerFor(null); }}
          onSelectCreate={() => { setChoices((current) => ({ ...current, [pickerFor.id]: { kind: 'create' } })); setPickerFor(null); }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

function DecisionLine({ view, choice, onChoose }: {
  view: DecisionView;
  choice: DecisionChoice;
  onChoose: (option: Option) => void;
}) {
  const current = view.options.find((option) => (option.opensPicker ? choice.kind === 'link' : sameChoice(option.choice, choice)))
    || view.options[0];
  const recommended = view.options.find((option) => option.recommended);
  const alternatives = view.options.filter((option) => option !== current || option.opensPicker);
  const changing = choiceChangesData(current.choice) || current.opensPicker;
  return (
    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <CheckCircleIcon aria-hidden="true"
          className={`mt-0.5 h-5 w-5 shrink-0 ${changing ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`} />
        <div className="min-w-0">
          <p className="font-medium text-gray-950 dark:text-white">
            {current.statement}
            {current.recommended && (
              <span className="ml-2 align-middle text-[11px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">Recommended</span>
            )}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300">{current.consequence}</p>
          {!current.recommended && recommended && (
            <button type="button" onClick={() => onChoose(recommended)}
              className="mt-1 text-sm font-medium text-primary-700 underline decoration-primary-300 underline-offset-2 hover:text-primary-800 dark:text-primary-300">
              Use recommended: {recommended.statement}
            </button>
          )}
        </div>
      </div>
      <Listbox value={null as Option | null} onChange={(option) => option && onChoose(option)}>
        <ListboxButton className="inline-flex shrink-0 items-center gap-1 self-start rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
          Something else
          <ChevronDownIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
        </ListboxButton>
        <ListboxOptions anchor="bottom end"
          className="z-30 w-80 rounded-lg border border-gray-200 bg-white p-1 shadow-lg [--anchor-gap:6px] focus:outline-none dark:border-gray-700 dark:bg-gray-800">
          {alternatives.map((option) => (
            <ListboxOption key={option.key} value={option}
              className="cursor-pointer rounded-md px-3 py-2 data-[focus]:bg-gray-100 dark:data-[focus]:bg-gray-700">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {option.menuLabel || option.statement}
                {option.recommended && <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">Recommended</span>}
              </p>
              {!option.opensPicker && <p className="text-xs text-gray-500 dark:text-gray-400">{option.consequence}</p>}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </div>
  );
}

function DetailsBand({ view, providerName }: { view: DecisionView; providerName: string }) {
  const label = 'text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500';
  return (
    <dl className="grid gap-x-6 gap-y-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-xs leading-relaxed text-gray-600 sm:grid-cols-[1fr_1fr_auto_1fr] dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-gray-300">
      <div>
        <dt className={label}>{providerName}</dt>
        <dd className="mt-0.5">{view.provider}</dd>
      </div>
      <div>
        <dt className={label}>LMPG now</dt>
        <dd className="mt-0.5">{view.lmpg}</dd>
      </div>
      <div aria-hidden="true" className="hidden self-center text-base text-gray-300 sm:block dark:text-gray-600">→</div>
      <div>
        <dt className={label}>After applying</dt>
        <dd className="mt-0.5 font-medium text-gray-800 dark:text-gray-100">{view.after}</dd>
      </div>
    </dl>
  );
}
