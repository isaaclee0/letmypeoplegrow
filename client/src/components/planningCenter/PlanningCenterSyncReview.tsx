import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleSyncPlan, PeopleSyncReview } from '../peopleSync/types';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import PcoPersonSearchPicker, { type PcoPersonResult } from './PcoPersonSearchPicker';
import { toLegacyPcoSelections, type LegacyPcoSelectionMap } from './syncSelections';

interface CandidateDetail { pcoId: string; firstName: string; lastName: string; membership: string | null; }
interface AmbiguousEntry { individualId: number; firstName: string; lastName: string; candidates: string[]; candidateDetails: CandidateDetail[]; }
interface VisitorMatchEntry { individualId: number; firstName: string; lastName: string; peopleType: string; candidate: CandidateDetail; }
interface FamilyNameUpdateEntry { familyId: number; oldName: string; newName: string; }
interface LegacyPcoPlan {
  link: { individualId: number; pcoId: string }[];
  restore: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  visitorMatches: VisitorMatchEntry[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  familyNameUpdates: FamilyNameUpdateEntry[];
  pcoFetchedAt?: string;
}

const emptyPlan = (): PeopleSyncPlan => ({
  provider: 'planning_center', authoritative: false, snapshot: { fetchedAt: null, mode: null },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [], promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [], renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [], familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

export function mapLegacyPcoPlan(legacy: LegacyPcoPlan): PeopleSyncPlan {
  const plan = emptyPlan();
  plan.snapshot = { fetchedAt: legacy.pcoFetchedAt || null, mode: legacy.pcoFetchedAt ? 'full' : null };
  plan.linkPeople = legacy.link.map((item) => ({ id: `pco-link:${item.individualId}`, externalPersonId: item.pcoId, individualId: item.individualId, reason: 'Matched in Planning Center', reviewRequired: false }));
  plan.reactivate = legacy.restore.map((item) => ({ id: `pco-restore:${item.individualId}`, externalPersonId: item.pcoId, individualId: item.individualId, reason: 'Active in Planning Center' }));
  plan.ambiguousPeople = legacy.ambiguous.map((item) => ({
    id: `pco-ambiguous:${item.individualId}`,
    externalPersonId: `pco-ambiguous:${item.individualId}`,
    reason: `${item.firstName} ${item.lastName} — choose the Planning Center match`,
    candidateIndividualIds: item.candidateDetails.map((candidate) => Number(candidate.pcoId)).filter(Number.isFinite),
  }));
  plan.promoteToRegular = legacy.visitorMatches.map((item) => ({ id: `pco-visitor:${item.individualId}`, externalPersonId: `pco-visitor:${item.individualId}`, individualId: item.individualId, fromPeopleType: item.peopleType === 'local_visitor' ? 'local_visitor' : 'traveller_visitor', toPeopleType: 'regular', reason: `Matches ${item.candidate.firstName} ${item.candidate.lastName} in Planning Center`, reviewRequired: true }));
  plan.addPeople = legacy.add.map((item) => ({ id: `pco-add:${item.pcoId}`, externalPersonId: item.pcoId, firstName: item.firstName, lastName: item.lastName, isChild: item.isChild, familyId: item.householdId, peopleType: 'regular', reason: item.membership || 'New Planning Center person', reviewRequired: true }));
  plan.updateManagedFields = legacy.update.map((item) => ({ id: `pco-update:${item.individualId}`, externalPersonId: `pco-update:${item.individualId}`, individualId: item.individualId, changes: [], reason: `${item.firstName} ${item.lastName} changed in Planning Center`, reviewRequired: false }));
  plan.reactivate.push(...legacy.reactivate.map((item) => ({ id: `pco-reactivate:${item.individualId}`, externalPersonId: item.pcoId, individualId: item.individualId, reason: 'Reactivated by Planning Center' })));
  // The old endpoint archives these automatically and has no opt-out field.
  // Keep that behavior visible without falsely presenting it as a neutral opt-in archive.
  plan.skipped.push(...legacy.archive.map((item) => ({ id: `pco-auto-archive:${item.individualId}`, externalPersonId: item.pcoId, individualId: item.individualId, reason: 'Will be archived automatically by the Planning Center sync' })));
  plan.renameFamily = legacy.familyNameUpdates.map((item) => ({ id: `pco-rename:${item.familyId}`, familyId: item.familyId, familyName: item.newName, reason: `Rename from ${item.oldName}` }));
  return plan;
}

function legacySelectionMap(plan: LegacyPcoPlan): LegacyPcoSelectionMap {
  return {
    ambiguousIndividualByExternalId: Object.fromEntries(plan.ambiguous.map((item) => [`pco-ambiguous:${item.individualId}`, item.individualId])),
    visitorIndividualByExternalId: Object.fromEntries(plan.visitorMatches.map((item) => [`pco-visitor:${item.individualId}`, item.individualId])),
    familyIdByRenameActionId: Object.fromEntries(plan.familyNameUpdates.map((item) => [`pco-rename:${item.familyId}`, item.familyId])),
  };
}

function buildReview(batchId: number, legacy: LegacyPcoPlan): PeopleSyncReview {
  const plan = mapLegacyPcoPlan(legacy);
  const summary = Object.fromEntries(Object.entries(plan)
    .filter(([key]) => !['provider', 'authoritative', 'snapshot'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])) as PeopleSyncReview['summary'];
  return { runId: batchId, reviewToken: `legacy-pco-${batchId}`, summary, plan, snapshot: plan.snapshot };
}

export default function PlanningCenterSyncReview({ connected, batchId }: { connected: boolean; batchId: number }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<LegacyPcoPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);

  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const response = await integrationsAPI.getPlanningCenterBatchPlan(batchId, { force: opts?.force });
      setPlan(response.data.plan);
    } catch (caught: any) {
      logger.error('Failed to compute Planning Center batch sync plan', caught);
      setError(caught.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { if (connected) void loadPlan(); }, [connected, loadPlan]);
  const review = useMemo(() => plan ? buildReview(batchId, plan) : null, [batchId, plan]);
  const selectionMap = useMemo(() => plan ? legacySelectionMap(plan) : null, [plan]);

  if (!connected) return <div className="text-sm text-gray-600 dark:text-gray-300">Planning Center is not connected. <button className="underline" onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.</div>;
  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => void loadPlan()}>Retry</button></div>;
  if (!plan || !review || !selectionMap) return null;

  const apply = async (_reviewToken: string, selections: Parameters<typeof toLegacyPcoSelections>[0]) => {
    setApplying(true); setError(null);
    try {
      const response = await integrationsAPI.applyPlanningCenterBatch(batchId, { selections: toLegacyPcoSelections(selections, selectionMap) });
      setResult(response.data.result);
      await loadPlan({ preserveResult: true });
    } catch (caught: any) {
      logger.error('Failed to apply Planning Center batch sync', caught);
      throw caught;
    } finally {
      setApplying(false);
    }
  };
  const renderCandidateSearch = ({ action, selectCandidate }: { action: { externalPersonId: string }; selectCandidate: (candidateId: number) => void }) => (
    <PcoPersonSearchPicker onPick={(person: PcoPersonResult) => {
      const pcoId = Number(person.pcoId);
      if (Number.isFinite(pcoId) && action.externalPersonId.startsWith('pco-ambiguous:')) selectCandidate(pcoId);
    }} />
  );
  const candidateLabel = (action: { externalPersonId: string }, candidateId: number) => {
    const individualId = Number(action.externalPersonId.replace('pco-ambiguous:', ''));
    const candidate = plan.ambiguous.find((item) => item.individualId === individualId)?.candidateDetails.find((item) => Number(item.pcoId) === candidateId);
    return candidate ? `${candidate.firstName} ${candidate.lastName}${candidate.membership ? ` — ${candidate.membership}` : ''}` : `Planning Center person ${candidateId}`;
  };

  return <div className="space-y-4"><SyncReview provider="planning_center" review={review} onRefresh={() => loadPlan()} onApply={apply} applying={applying} renderCandidateSearch={renderCandidateSearch} renderCandidateLabel={candidateLabel} />
    <button type="button" className="text-sm underline text-gray-600 dark:text-gray-300" disabled={applying} onClick={() => void loadPlan({ force: true })}>Refresh from Planning Center</button>
    {plan.pcoFetchedAt && <p className="text-xs text-gray-500 dark:text-gray-400">Planning Center data as of {new Date(plan.pcoFetchedAt).toLocaleTimeString()}.</p>}
    {result && <div className="text-sm text-green-700 dark:text-green-400">Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked{result.familyNamesUpdated ? `, ${result.familyNamesUpdated} family names updated` : ''}{result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}</div>}
  </div>;
}
