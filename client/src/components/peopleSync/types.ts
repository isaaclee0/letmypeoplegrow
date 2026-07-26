// Client-side mirror of the provider-neutral people-sync server contracts
// (Task 17 of the provider-neutral people-sync project). Every interface
// here is meant to match, field-for-field, what the server actually sends
// -- not the abbreviated pseudocode in the project's planning doc. See the
// header of each section below for the exact server file/function each
// shape was read from.
//
// Do not add `any` to this file. A bucket with no current producer (see the
// "no producer yet" notes below) still gets a best-effort, non-`any` shape
// inferred from how apply.js reads that bucket's actions -- these are
// flagged explicitly so a future change to plan.js's real producer can be
// diffed against them.

// ─── Providers ───────────────────────────────────────────────────────────

// server/services/peopleSync/{batchRepository,authority,runRepository}.js's
// own PROVIDERS/AUTHORITY_PROVIDERS sets.
export type SyncProvider = 'planning_center' | 'elvanto';

// server/services/peopleSync/authority.js's AUTHORITY_PROVIDERS plus the
// unlocked 'none' state (people_sync_settings.authority_provider's default).
export type AuthorityProvider = SyncProvider | 'none';

export type PeopleType = 'regular' | 'local_visitor' | 'traveller_visitor';

// server/routes/individuals.js and server/routes/families.js already attach
// this exact shape to every individual/family DTO (see `externalLinks`
// construction in both files) -- confirmed against
// server/routes/families.dbintegration.test.js's own assertions.
export type ExternalLinks = Partial<Record<SyncProvider, string>>;

// ─── Sync batches (server/services/peopleSync/batchRepository.js) ──────────

// Exact camelCase DTO produced by batchRepository.js's toBatch(), which
// server/routes/integrations/elvanto.js's sync-batch routes forward
// unmodified (GET/POST /elvanto/sync-batches, PUT/DELETE
// /elvanto/sync-batches/:id all `res.json({ success: true, batch(es) })`
// straight from batchRepository's own return value) -- so this is exactly
// what the client receives, including `legacyProviderBatchId`, which the
// plan's own abbreviated snippet omits. Elvanto batches never populate that
// field (it exists for Planning Center's dual-write migration -- see
// planningCenterSync.js), but it is still present (always null) on every
// Elvanto batch response, so it is included here for an exact shape match.
export interface PeopleSyncBatch<TFilter = Record<string, unknown>> {
  id: number;
  provider: SyncProvider;
  name: string;
  enabled: boolean;
  filterSchemaVersion: number;
  filterConfig: TFilter;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
  gatheringAutoRemoveEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDay: number;
  legacyProviderBatchId: number | null;
  lastExternalWatermark: string | null;
  lastSyncAt: string | null;
  // IMPORTANT DEVIATION from the plan's own inline snippet (which showed
  // `Record<string, number | string> | null`): batchRepository.js's
  // toBatch() does NOT JSON.parse this column -- `lastSyncResult:
  // row.last_sync_result` is a raw passthrough of a TEXT column. The two
  // write paths that populate it disagree on shape:
  //   - Elvanto (batchRepository.recordBatchResult, called from
  //     elvanto.js's POST /sync-batches/:id/run-now -- the ONLY writer for
  //     provider='elvanto' rows) always writes one of the four run-status
  //     strings (see RUN_STATUSES in batchRepository.js).
  //   - Planning Center's still-reachable legacy path
  //     (planningCenterSync.js's recordBatchSyncResult) instead writes
  //     `JSON.stringify(summary)` for provider='planning_center' rows.
  // Since this type is shared across providers, `string | null` is the only
  // honest shape; ElvantoLastSyncResult below narrows it for the Elvanto
  // case this project actually needs today.
  lastSyncResult: string | null;
}

// Elvanto batches are only ever written through batchRepository's own
// recordBatchResult (see the note on `lastSyncResult` above), so for an
// Elvanto batch specifically, lastSyncResult -- once non-null -- is always
// one of these four strings.
export type ElvantoLastSyncResult = 'review_required' | 'applied' | 'failed' | 'cancelled';

// Request body accepted by POST /elvanto/sync-batches (name required) and
// PUT /elvanto/sync-batches/:id (all fields optional -- a partial patch
// merged over the existing stored batch). Mirrors elvanto.js's own
// BATCH_BODY_ALLOWED allow-list exactly.
export interface ElvantoSyncBatchInput<TFilter = Record<string, unknown>> {
  name: string;
  enabled?: boolean;
  filterSchemaVersion?: number;
  filterConfig?: TFilter;
  defaultPeopleType?: PeopleType;
  gatheringTypeId?: number | null;
  gatheringAutoRemoveEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleFrequency?: 'daily' | 'weekly' | 'monthly';
  scheduleDay?: number;
}

export type ElvantoSyncBatchPatch = Partial<ElvantoSyncBatchInput>;

// ─── Elvanto metadata (server/services/elvanto/metadata.js's computeMetadata) ──

export interface ElvantoMetadataOption {
  id: string;
  name: string;
}

export interface ElvantoMetadataGroup extends ElvantoMetadataOption {
  status: string | null;
  memberCount: number;
}

export interface ElvantoMetadataValueCount {
  value: string;
  count: number;
}

export type ElvantoMetadataCustomFieldValue = ElvantoMetadataOption;

export interface ElvantoMetadataCustomField extends ElvantoMetadataOption {
  type: string | null;
  values: ElvantoMetadataCustomFieldValue[];
}

export interface ElvantoSyncMetadata {
  fetchedAt: string;
  categories: ElvantoMetadataOption[];
  groups: ElvantoMetadataGroup[];
  demographics: ElvantoMetadataValueCount[];
  departments: ElvantoMetadataValueCount[];
  serviceTypes: ElvantoMetadataOption[];
  locations: ElvantoMetadataOption[];
  customFields: ElvantoMetadataCustomField[];
}

// ─── people-sync settings (server/routes/integrations/peopleSync.js) ──────

export interface PeopleSyncSettings {
  authorityProvider: AuthorityProvider;
  pendingAuthorityProvider: SyncProvider | null;
  elvantoIncludeContacts: boolean;
  elvantoAlignPeopleType: boolean;
  fullReconciliationFrequency: 'daily' | 'weekly' | 'monthly';
  fullReconciliationDay: number;
}

// Mirrors peopleSync.js's SETTINGS_ALLOWED_KEYS strict allow-list exactly.
export interface PeopleSyncSettingsPatch {
  elvantoIncludeContacts?: boolean;
  elvantoAlignPeopleType?: boolean;
  fullReconciliationFrequency?: 'daily' | 'weekly' | 'monthly';
  fullReconciliationDay?: number;
}

// server/services/peopleSync/authority.js's getAuthority/beginAuthoritySwitch/
// commitAuthoritySwitch/disableAuthority all return this same shape.
export interface PeopleSyncAuthorityState {
  active: AuthorityProvider;
  pending: SyncProvider | null;
}

// ─── Plan actions (server/services/peopleSync/plan.js) ────────────────────
//
// Every bucket below is read directly off plan.js's own action-building
// code (not the plan doc's abbreviated pseudocode). Buckets with no current
// producer in plan.js (linkFamilies, addFamilies, moveFamily, renameFamily,
// familyConflicts) are marked "no producer yet" -- their shape is inferred
// from how apply.js *reads* an action of that bucket, since that is the
// only place in the codebase today that assumes anything about their
// fields. Flagged in Task 17's report as a documented, non-`any` best
// guess, not a confirmed contract.

export interface LinkPersonAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  reason: string;
  reviewRequired: boolean;
}

// No producer yet (family matching is future work -- plan.js's own BUCKETS
// list includes this key, but nothing ever pushes to it; apply.js handles
// it "defensively/forward-compatibly", per its own comment). Shape inferred
// from apply.js's linkFamilies handling (externalFamilyId, familyId,
// linkSource).
export interface LinkFamilyAction {
  id: string;
  externalFamilyId: string;
  familyId: number;
  linkSource?: string;
  reason?: string;
}

export interface AddPersonAction {
  id: string;
  externalPersonId: string;
  // Elvanto's normalizer.js always produces a string here (trimmedOrEmpty),
  // never null/undefined -- an empty string is possible, not absence.
  firstName: string;
  lastName: string;
  isChild: boolean | null;
  // The EXTERNAL provider's household/family id (a string on this project's
  // only two providers today), NOT a local families.id -- see plan.js's own
  // comment on this field and apply.js's resolution of it through
  // external_family_links.
  familyId: string | null;
  peopleType: PeopleType;
  reason: string;
  reviewRequired: true;
}

// No producer yet (same caveat as LinkFamilyAction). Shape inferred from
// apply.js's addFamilies handling (familyName, externalFamilyId).
export interface AddFamilyAction {
  id: string;
  externalFamilyId?: string | null;
  familyName: string;
  reason?: string;
}

export type ManagedFieldName = 'firstName' | 'lastName' | 'isChild';

export interface ManagedFieldChange {
  field: ManagedFieldName;
  localValue: string | boolean | null | undefined;
  externalValue: string | boolean | null | undefined;
}

export interface UpdateManagedFieldsAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  changes: ManagedFieldChange[];
  reason: string;
  reviewRequired: boolean;
}

export interface PromoteToRegularAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  fromPeopleType: PeopleType;
  toPeopleType: 'regular';
  reason: string;
  reviewRequired: boolean;
}

export interface DemoteToLocalVisitorAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  fromPeopleType: PeopleType;
  toPeopleType: 'local_visitor';
  reason: string;
  reviewRequired: boolean;
}

export interface ArchiveAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  reason: string;
  missingFullSyncCount: number | null;
}

export interface ReactivateAction {
  id: string;
  externalPersonId: string;
  individualId: number;
  reason: string;
}

// No producer yet -- apply.js's own comment calls this bucket "SPECULATIVE
// / UNVALIDATED ... no anchor in plan.js or in any spec text at all".
// Shape inferred from apply.js's moveFamily handling (familyId, individualId).
export interface MoveFamilyAction {
  id: string;
  individualId: number;
  familyId: number;
  reason?: string;
}

// No producer yet (same caveat as LinkFamilyAction). Shape inferred from
// apply.js's renameFamily handling (familyName, familyId).
export interface RenameFamilyAction {
  id: string;
  familyId: number;
  familyName: string;
  reason?: string;
}

export interface AddToGatheringAction {
  id: string;
  batchId: number;
  gatheringTypeId: number;
  externalPersonId: string;
  // null when this action targets a brand-new addPeople person (resolved to
  // a real individual id only after that addPeople action is applied).
  individualId: number | null;
  eligibleBatchIds: number[];
  reason: string;
}

export interface RemoveFromGatheringAction {
  id: string;
  batchId: number;
  gatheringTypeId: number;
  individualId: number;
  reason: string;
}

// Base shape from matcher.js's own `ambiguous` entries, plus plan.js's
// added `matcherBuckets` (from its own conflicting-identity detection).
export interface AmbiguousPersonAction {
  id: string;
  externalPersonId: string;
  reason: string;
  candidateIndividualIds?: number[];
  staleLinkedIndividualIds?: number[];
  matcherBuckets?: string[];
}

// plan.js never generates this bucket's contents itself -- it only clones
// whatever `input.familyConflicts` the caller passes (orchestrator.js
// always passes an empty array today; family-conflict detection is future
// work), so there is no real shape to pin down yet.
export interface FamilyConflictAction {
  id?: string;
  [key: string]: unknown;
}

export interface UnmatchedLocalRegularAction {
  id: string;
  individualId: number;
  reason: string;
  reviewRequired: true;
}

// Different producers attach different optional fields (individualId is
// absent for a "create_regular_non_authoritative" skip, present for others;
// activeAuthority/missingFullSyncCount are each only set by their own
// producer) -- see plan.js's several `plan.skipped.push(...)` call sites.
export interface SkippedAction {
  id: string;
  externalPersonId: string;
  individualId?: number;
  reason: string;
  activeAuthority?: AuthorityProvider;
  missingFullSyncCount?: number;
}

export interface PeopleSyncSnapshotInfo {
  fetchedAt: string | null;
  mode: 'full' | 'incremental' | null;
}

// The full plan shape as the CLIENT actually receives it -- i.e. after
// orchestrator.js's sanitizePlanForReview() strips raw attribute/
// custom-field maps (a defensive no-op today, since none of plan.js's own
// action shapes carry those keys) -- not plan.js's internal shape, which
// also carries a `presenceProjection` field the sanitizer deliberately
// drops before it ever reaches a route response.
export interface PeopleSyncPlan {
  provider: SyncProvider;
  authoritative: boolean;
  snapshot: PeopleSyncSnapshotInfo;
  linkPeople: LinkPersonAction[];
  linkFamilies: LinkFamilyAction[];
  addPeople: AddPersonAction[];
  addFamilies: AddFamilyAction[];
  updateManagedFields: UpdateManagedFieldsAction[];
  promoteToRegular: PromoteToRegularAction[];
  demoteToLocalVisitor: DemoteToLocalVisitorAction[];
  archive: ArchiveAction[];
  reactivate: ReactivateAction[];
  moveFamily: MoveFamilyAction[];
  renameFamily: RenameFamilyAction[];
  addToGathering: AddToGatheringAction[];
  removeFromGathering: RemoveFromGatheringAction[];
  ambiguousPeople: AmbiguousPersonAction[];
  familyConflicts: FamilyConflictAction[];
  unmatchedLocalRegulars: UnmatchedLocalRegularAction[];
  skipped: SkippedAction[];
}

// The 17 action-bucket keys of PeopleSyncPlan (i.e. plan.js's own BUCKETS
// list), derived rather than re-typed so it can never drift from the
// interface above.
export type PeopleSyncBucketName = Exclude<keyof PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'>;

// server/services/peopleSync/plan.js's summarizePlan(): bucket name -> count.
export type PeopleSyncPlanSummary = Record<PeopleSyncBucketName, number>;

// server/services/peopleSync/apply.js's emptyResult()/applyPeopleSyncPlan()
// return shape: the same bucket keys (this time counting actions actually
// APPLIED, which can diverge from the plan's own bucket sizes -- see
// apply.js's own comment on emptyResult), plus three extra tallies.
export type PeopleSyncApplyCounts = Record<PeopleSyncBucketName, number> & {
  familyNamesUpdated: number;
  gatheringAssigned: number;
  gatheringRemoved: number;
};

// ─── Review / apply / run-now results (server/services/peopleSync/orchestrator.js) ──

// buildReview()'s and previewAuthoritySwitch()'s return shape. `authority`
// is present ONLY for previewAuthoritySwitch (POST
// /people-sync/people-authority/preview) -- buildReview (GET
// /elvanto/sync-batches/:id/plan) never includes it.
export interface PeopleSyncReview {
  runId: number;
  reviewToken: string;
  summary: PeopleSyncPlanSummary;
  plan: PeopleSyncPlan;
  snapshot: PeopleSyncSnapshotInfo;
  authority?: PeopleSyncAuthorityState;
}

// applyReviewed()'s return shape -- used by both POST
// /people-sync/people-authority/apply and POST
// /elvanto/sync-batches/:id/apply. Status is always 'applied': applyReviewed
// always calls finishAppliedRun with reviewRequiredWhenHeld: false, so it
// can never itself downgrade to 'review_required' the way runUnattended can.
export interface PeopleSyncApplyResult {
  runId: number;
  status: 'applied';
  applied: PeopleSyncApplyCounts;
  summary: PeopleSyncPlanSummary;
  // Present only when an authority-switch apply's commitAuthoritySwitch
  // step failed AFTER the plan itself was already successfully applied --
  // see orchestrator.js's applyReviewed for why this never rolls back or
  // fails the run.
  authorityCommitError?: string;
}

// runUnattended()'s return shape -- used by POST
// /elvanto/sync-batches/:id/run-now. Unlike applyReviewed, this run passes
// reviewRequiredWhenHeld: true, so status can legitimately downgrade to
// 'review_required' when any held-review bucket (ambiguousPeople/
// familyConflicts/renameFamily/unmatchedLocalRegulars) is non-empty.
export interface PeopleSyncRunNowResult {
  runId: number;
  status: 'applied' | 'review_required';
  counts: PeopleSyncApplyCounts;
  fetchMode: 'full' | 'incremental';
  complete: boolean;
  externalWatermark: string | null;
}

// ─── Reviewer selections (server/services/peopleSync/apply.js's validateSelections) ──

export interface SyncSelections {
  ambiguous: Record<string, number>;
  skipExternalPersonIds: string[];
  visitorChoices: Record<string, 'promote' | 'keep'>;
  acceptArchiveIndividualIds: number[];
  acceptFamilyRenameIds: number[];
}

// ─── Recent runs (server/services/peopleSync/runRepository.js's toRun()) ──

export type PeopleSyncTrigger =
  | 'onboarding' | 'manual' | 'run_now' | 'scheduled' | 'authority_switch' | 'full_reconciliation';

export type PeopleSyncRunStatus = 'running' | 'review_required' | 'applied' | 'failed' | 'cancelled';

export interface PeopleSyncRun {
  id: number;
  provider: SyncProvider;
  batchId: number | null;
  trigger: PeopleSyncTrigger;
  fetchMode: 'full' | 'incremental';
  status: PeopleSyncRunStatus;
  // A failed run always stores '{}' (see runRepository.js's failRun); a
  // finished run's counts can also legitimately be a subset of the full key
  // set if a caller ever passes a partial counts object, so this is a
  // Partial rather than a fully-required record.
  counts: Partial<PeopleSyncApplyCounts>;
  reviewNotificationFingerprint: string | null;
  errorCode: string | null;
  // Always re-derived server-side from errorCode by
  // routes/integrations/peopleSync.js's sanitizeRunForResponse() -- never
  // the raw stored value -- see that function's own comment on why.
  errorMessage: string | null;
  externalWatermark: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ─── Elvanto connection (server/services/peopleSync/connectionStore.js) ───

export interface ElvantoConnection {
  provider: SyncProvider;
  authType: string;
  connectionStatus: 'connected' | 'invalid' | 'validation_unavailable';
  connectedAt: string | null;
  lastValidatedAt: string | null;
  lastErrorCode: string | null;
  metadata: Record<string, unknown>;
  metadataCachedAt: string | null;
}

export interface ElvantoStatus {
  configured: boolean;
  connected: boolean;
  elvantoAccount: string | null;
  error?: string;
  reconnectRequired?: boolean;
}
