// Prototype model for the single-list sync review (dev only for now).
//
// The server plans by action type (identities, familyConflicts,
// removeFromGathering, archive...). Reviewers think in people. This module
// regroups the signed plan into one decision card per person or household,
// attaches a recommendation to every decision, and converts the reviewer's
// choices back into the exact PeopleSyncSelections payload SyncReview submits.
import type {
  FamilyConflictAction,
  IdentityDecision,
  PeopleSyncPersonDisplay,
  PeopleSyncReview,
  PeopleSyncSelections,
} from './types';
import { buildSyncSelections, initializeSyncSelectionState } from './syncSelections';

export type DecisionKind = 'identity' | 'household' | 'listRemoval' | 'archive' | 'outsideSourceMatch';

export type DecisionChoice =
  | { kind: 'accept' }
  | { kind: 'create' }
  | { kind: 'link'; individualId: number }
  | { kind: 'keep' }
  | { kind: 'later' };

export interface DecisionItem {
  id: string;
  kind: DecisionKind;
  /** Signed plan action id for household, list and archive decisions. */
  actionId?: string;
  externalId?: string;
  individualId?: number;
  recommended: DecisionChoice | null;
  initial: DecisionChoice;
  /** The reviewer left this for later in an earlier sync. */
  held: boolean;
  /** The server could not build a proposal; nothing can be applied yet. */
  needsInfo: boolean;
  priority: number;
  peopleKeys: string[];
}

export interface DecisionGroup {
  key: string;
  title: string;
  decisions: DecisionItem[];
  priority: number;
  needsYou: boolean;
}

export interface AutomaticChange {
  label: string;
  names: string[];
}

export type Choices = Record<string, DecisionChoice>;

const ACCEPT: DecisionChoice = { kind: 'accept' };
const LATER: DecisionChoice = { kind: 'later' };

export function nameOf(person: Pick<PeopleSyncPersonDisplay, 'firstName' | 'lastName'> | undefined, fallback = 'Unknown person'): string {
  const value = person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() : '';
  return value || fallback;
}

/** Show a shared surname once when listing household members. */
export function compactNames(people: Array<Pick<PeopleSyncPersonDisplay, 'firstName' | 'lastName'>>): string {
  if (people.length === 0) return 'Unknown person';
  if (people.length === 1) return nameOf(people[0]);
  const lastNames = new Set(people.map((person) => (person.lastName || '').trim().toLocaleLowerCase()));
  const sharedLast = lastNames.size === 1 && people[0].lastName ? people[0].lastName.trim() : null;
  const parts = sharedLast ? people.map((person) => person.firstName.trim()) : people.map((person) => nameOf(person));
  const joined = `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
  return sharedLast ? `${joined} ${sharedLast}` : joined;
}

export function sameChoice(left: DecisionChoice | null | undefined, right: DecisionChoice | null | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind !== 'link' || (right.kind === 'link' && left.individualId === right.individualId);
}

export function choiceChangesData(choice: DecisionChoice | undefined): boolean {
  return !!choice && choice.kind !== 'keep' && choice.kind !== 'later';
}

/** Kept differences change nothing in LMPG but are remembered on apply. */
export function choiceIsRemembered(decision: DecisionItem, choice: DecisionChoice | undefined): boolean {
  return choice?.kind === 'keep' && (decision.kind === 'household' || decision.kind === 'listRemoval');
}

function establishedIndividual(review: PeopleSyncReview, externalId: string): number | undefined {
  const context = review.plan.reviewContext;
  return context?.projectedEstablishedLinks?.[externalId]?.individualId
    ?? context?.establishedLinks?.[externalId]?.individualId;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(key, root);
    return root;
  }
  union(left: string, right: string) {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(b, a);
  }
}

export function buildDecisionItems(review: PeopleSyncReview): DecisionItem[] {
  const plan = review.plan;
  const context = plan.reviewContext;
  const items: DecisionItem[] = [];

  for (const [externalId, entry] of Object.entries(context?.identities || {})) {
    const recommended: DecisionChoice | null = entry.suggestedIndividualId !== null
      ? ACCEPT
      : entry.canCreate ? { kind: 'create' } : null;
    const keys = [`x:${externalId}`];
    if (entry.suggestedIndividualId !== null) keys.push(`i:${entry.suggestedIndividualId}`);
    items.push({
      id: `identity:${externalId}`,
      kind: 'identity',
      externalId,
      recommended,
      // Recommendations are pre-selected even for people held earlier; the
      // card says they were left for later last time.
      initial: recommended || LATER,
      held: entry.held,
      needsInfo: false,
      priority: !recommended ? 0 : entry.held || entry.suggestedIndividualId !== null ? 1 : 2,
      peopleKeys: keys,
    });
  }

  plan.familyConflicts.forEach((action: FamilyConflictAction, index) => {
    const keys = [
      ...(action.memberExternalIds || []).map((id) => `x:${id}`),
      ...(action.resolution?.moves || []).map((move) => `i:${move.individualId}`),
    ];
    const proposal = !!(action.id && action.resolution);
    items.push({
      id: `household:${action.id || index}`,
      kind: 'household',
      actionId: action.id,
      recommended: proposal ? ACCEPT : null,
      initial: proposal ? ACCEPT : LATER,
      held: false,
      needsInfo: !proposal,
      priority: !proposal ? 0 : action.resolution?.kind === 'detach' ? 1 : 2,
      peopleKeys: keys,
    });
  });

  for (const action of plan.removeFromGathering.filter((entry) => entry.reviewRequired)) {
    items.push({
      id: `list:${action.id}`,
      kind: 'listRemoval',
      actionId: action.id,
      externalId: action.externalPersonId,
      individualId: action.individualId,
      recommended: ACCEPT,
      initial: ACCEPT,
      held: false,
      needsInfo: false,
      priority: 3,
      peopleKeys: [`i:${action.individualId}`, ...(action.externalPersonId ? [`x:${action.externalPersonId}`] : [])],
    });
  }

  for (const action of plan.archive) {
    const outsideSource = action.reason === 'outside_all_sync_sources';
    items.push({
      id: `${outsideSource ? 'outside-source' : 'archive'}:${action.id}`,
      kind: outsideSource ? 'outsideSourceMatch' : 'archive',
      actionId: action.id,
      externalId: action.externalPersonId,
      individualId: action.individualId,
      recommended: outsideSource ? null : ACCEPT,
      initial: outsideSource ? LATER : ACCEPT,
      held: false,
      needsInfo: false,
      priority: outsideSource ? 0 : 1,
      peopleKeys: [`i:${action.individualId}`, `x:${action.externalPersonId}`],
    });
  }
  return items;
}

interface Subject { key: string; person: PeopleSyncPersonDisplay | undefined }

/** The humans a decision is about, keyed so the same person is never named twice. */
function subjectsFor(review: PeopleSyncReview, decision: DecisionItem): Subject[] {
  const directory = review.plan.people || { external: {}, local: {} };
  const external = (externalId: string): PeopleSyncPersonDisplay | undefined => {
    const created = review.plan.reviewContext?.identities[externalId]?.createPerson;
    return directory.external[externalId] || (created ? { firstName: created.firstName, lastName: created.lastName } : undefined);
  };
  if (decision.kind === 'outsideSourceMatch' && decision.individualId !== undefined) {
    return [{ key: decision.externalId ? `x:${decision.externalId}` : `i:${decision.individualId}`, person: directory.local[String(decision.individualId)] || (decision.externalId ? external(decision.externalId) : undefined) }];
  }
  if (decision.kind === 'identity' && decision.externalId) {
    return [{ key: `x:${decision.externalId}`, person: external(decision.externalId) }];
  }
  if (decision.kind === 'household') {
    const action = review.plan.familyConflicts.find((entry) => entry.id === decision.actionId);
    const members = (action?.memberExternalIds || []).map((id) => ({ key: `x:${id}`, person: external(id) }));
    if (members.length) return members;
    return (action?.resolution?.moves || []).map((move) => ({ key: `i:${move.individualId}`, person: directory.local[String(move.individualId)] }));
  }
  const localPerson = decision.individualId === undefined ? undefined : directory.local[String(decision.individualId)];
  const key = decision.externalId ? `x:${decision.externalId}` : `i:${decision.individualId}`;
  return [{ key, person: (decision.externalId && directory.external[decision.externalId]) || localPerson }];
}

export function buildDecisionGroups(review: PeopleSyncReview): DecisionGroup[] {
  const items = buildDecisionItems(review);
  const sets = new UnionFind();
  const externalByIndividual = new Map<number, string>();
  for (const externalId of Object.keys(review.plan.reviewContext?.establishedLinks || {})) {
    const individualId = establishedIndividual(review, externalId);
    if (individualId === undefined) continue;
    externalByIndividual.set(individualId, externalId);
    // Bundle every decision about the same person, however the plan refers to them.
    sets.union(`x:${externalId}`, `i:${individualId}`);
  }
  for (const item of items) item.peopleKeys.forEach((key) => sets.union(item.peopleKeys[0], key));

  const groups = new Map<string, DecisionItem[]>();
  for (const item of items) {
    const root = sets.find(item.peopleKeys[0]);
    groups.set(root, [...(groups.get(root) || []), item]);
  }

  return [...groups.entries()].map(([key, decisions]) => {
    const sorted = [...decisions].sort((left, right) => left.priority - right.priority);
    const named = new Map<string, PeopleSyncPersonDisplay>();
    for (const subject of sorted.flatMap((decision) => subjectsFor(review, decision))) {
      const canonical = subject.key.startsWith('i:') && externalByIndividual.has(Number(subject.key.slice(2)))
        ? `x:${externalByIndividual.get(Number(subject.key.slice(2)))}` : subject.key;
      if (subject.person && !named.has(canonical)) named.set(canonical, subject.person);
    }
    return {
      key,
      title: compactNames([...named.values()]),
      decisions: sorted,
      priority: sorted[0].priority,
      needsYou: sorted.some((decision) => decision.priority === 0),
    };
  }).sort((left, right) => left.priority - right.priority || left.title.localeCompare(right.title));
}

export function initialChoices(groups: DecisionGroup[]): Choices {
  return Object.fromEntries(groups.flatMap((group) => group.decisions.map((decision) => [decision.id, decision.initial])));
}

function identityDecision(choice: DecisionChoice | undefined, held: boolean): IdentityDecision | null {
  switch (choice?.kind) {
    case 'accept': return { outcome: 'accept' };
    case 'create': return { outcome: 'create' };
    case 'link': return { outcome: 'link', individualId: choice.individualId };
    // An existing hold already means "later"; only a new deferral needs saying.
    default: return held ? null : { outcome: 'defer' };
  }
}

export function toSelections(review: PeopleSyncReview, groups: DecisionGroup[], choices: Choices): PeopleSyncSelections {
  const state = initializeSyncSelectionState(review);
  const identityDecisions: Record<string, IdentityDecision | null> = { ...(state.identityDecisions || {}) };
  for (const decision of groups.flatMap((group) => group.decisions)) {
    const choice = choices[decision.id];
    if (decision.kind === 'identity' && decision.externalId) {
      identityDecisions[decision.externalId] = identityDecision(choice, decision.held);
      continue;
    }
    if (choice?.kind === 'keep' && decision.actionId && (decision.kind === 'household' || decision.kind === 'listRemoval')) {
      state.keptReconciliationIds = new Set([...(state.keptReconciliationIds || []), decision.actionId]);
      continue;
    }
    if (choice?.kind !== 'accept' || !decision.actionId) continue;
    if (decision.kind === 'household') state.acceptedFamilyResolutionIds?.add(decision.actionId);
    if (decision.kind === 'listRemoval') state.acceptedGatheringRemovalIds?.add(decision.actionId);
    if ((decision.kind === 'archive' || decision.kind === 'outsideSourceMatch') && decision.individualId !== undefined) state.acceptedArchiveIds.add(decision.individualId);
  }
  return buildSyncSelections({ ...state, identityDecisions });
}

/** Two provider people must not end up linked to the same LMPG person. */
export function linkCollisions(review: PeopleSyncReview, groups: DecisionGroup[], choices: Choices): Map<string, string> {
  const context = review.plan.reviewContext;
  const claims = new Map<number, string[]>();
  const claim = (individualId: number, owner: string) => claims.set(individualId, [...(claims.get(individualId) || []), owner]);
  for (const externalId of Object.keys(context?.establishedLinks || {})) {
    const individualId = establishedIndividual(review, externalId);
    if (individualId !== undefined) claim(individualId, `established:${externalId}`);
  }
  for (const decision of groups.flatMap((group) => group.decisions)) {
    const choice = choices[decision.id];
    if (decision.kind === 'outsideSourceMatch' && choice?.kind === 'accept' && decision.individualId !== undefined) {
      const action = review.plan.archive.find((entry) => entry.id === decision.actionId);
      if (action?.linkRequired) claim(decision.individualId, decision.id);
      continue;
    }
    if (decision.kind !== 'identity' || !decision.externalId) continue;
    const target = choice?.kind === 'link' ? choice.individualId
      : choice?.kind === 'accept' ? context?.identities[decision.externalId]?.suggestedIndividualId ?? null : null;
    if (target !== null && target !== undefined) claim(target, decision.id);
  }
  const directory = review.plan.people || { external: {}, local: {} };
  const result = new Map<string, string>();
  for (const [individualId, owners] of claims) {
    if (owners.length < 2) continue;
    for (const owner of owners.filter((entry) => !entry.startsWith('established:'))) {
      result.set(owner, `${nameOf(directory.local[String(individualId)], 'That person')} is already chosen for someone else.`);
    }
  }
  return result;
}

export function automaticChanges(review: PeopleSyncReview, gatherings: Array<{ id: number; name: string }> = []): AutomaticChange[] {
  const plan = review.plan;
  const directory = plan.people || { external: {}, local: {} };
  const local = (id: number | null | undefined) => nameOf(id === null || id === undefined ? undefined : directory.local[String(id)], `Person #${id}`);
  const external = (id: string) => nameOf(directory.external[id], 'Planning Center person');
  const gatheringName = (id: number) => gatherings.find((gathering) => gathering.id === id)?.name || `Gathering ${id}`;
  const entries: AutomaticChange[] = [
    { label: 'name or age updates', names: plan.updateManagedFields.map((action) => local(action.individualId)) },
    { label: 'made regulars', names: plan.promoteToRegular.map((action) => local(action.individualId)) },
    { label: 'made local visitors', names: plan.demoteToLocalVisitor.map((action) => local(action.individualId)) },
    { label: 'reactivated', names: plan.reactivate.map((action) => local(action.individualId)) },
    { label: 'linked to Planning Center', names: plan.linkPeople.filter((action) => !action.reviewRequired
      && !plan.reviewContext?.identities[action.externalPersonId]).map((action) => local(action.individualId)) },
    { label: 'added to attendance lists', names: plan.addToGathering.map((action) => `${action.individualId === null ? external(action.externalPersonId) : local(action.individualId)} → ${gatheringName(action.gatheringTypeId)}`) },
    { label: 'removed from attendance lists', names: plan.removeFromGathering.filter((action) => !action.reviewRequired).map((action) => `${local(action.individualId)} → ${action.gatheringName || gatheringName(action.gatheringTypeId)}`) },
  ];
  return entries.filter((entry) => entry.names.length > 0);
}
