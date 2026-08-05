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

export type PeopleReviewOperationKind = 'people_sync' | 'authority_switch' | 'people_import';

declare const peopleReviewTokenOperation: unique symbol;

/**
 * Compile-time proof that an opaque review token came from the same review
 * workflow that is about to consume it. This is client-side contract
 * isolation only; the server remains responsible for authenticating tokens.
 */
export type PeopleReviewToken<Operation extends PeopleReviewOperationKind> = string & {
  readonly [peopleReviewTokenOperation]: Operation;
};

export type PlanningCenterConnectionErrorCode =
  | 'SYNC_SOURCE_AUTH'
  | 'SYNC_SOURCE_RATE_LIMIT'
  | 'SYNC_SOURCE_CHECK_FAILED';

/** Response returned by GET /integrations/planning-center/status. */
export interface PlanningCenterStatus {
  enabled: boolean;
  configured?: boolean;
  connected: boolean;
  planningCenterAccount: string | null;
  reconnectRequired?: boolean;
  connectionErrorCode?: PlanningCenterConnectionErrorCode | null;
}

export type SourceKind = 'planning_center_list' | 'elvanto_category' | 'elvanto_group';
export type SourceStatus = 'unknown' | 'available' | 'missing' | 'error';
export type BatchOperationalState = 'active' | 'prepared' | 'disabled' | 'source_review_required';

export interface ProviderSource {
  kind: SourceKind;
  externalId: string;
  name: string;
  memberCount: number | null;
  providerRefreshedAt: string | null;
}

/** Stable source identity accepted by create and source-draft requests. */
export interface SourceSelection {
  sourceKind: SourceKind;
  sourceExternalId: string;
}

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
// field (it identifies retained Planning Center compatibility rows -- see
// planningCenterSync.js), but it is still present (always null) on every
// Elvanto batch response, so it is included here for an exact shape match.
export interface PeopleSyncBatch {
  id: number;
  provider: SyncProvider;
  name: string;
  enabled: boolean;
  source: ProviderSource | null;
  sourceRevision: number;
  draftSource: ProviderSource | null;
  draftSourceBaseRevision: number | null;
  draftSourceUpdatedAt: string | null;
  needsSourceReview: boolean;
  initialSourceReviewPending: boolean;
  sourceStatus: SourceStatus;
  sourceStatusCheckedAt: string | null;
  sourceStatusErrorCode: string | null;
  operationalState: BatchOperationalState;
  reviewable: boolean;
  runnable: boolean;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
  gatheringAutoRemoveEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDay: number;
  priorScheduleEnabled?: boolean | null;
  priorScheduleFrequency?: 'daily' | 'weekly' | 'monthly' | null;
  priorScheduleDay?: number | null;
  legacyProviderBatchId: number | null;
  lastExternalWatermark: string | null;
  lastSyncAt: string | null;
  // Provider-neutral runs return a status string. The Planning Center
  // compatibility adapter also JSON-parses summaries stored by the retired
  // legacy path, so old PCO batches can return an object here.
  lastSyncResult: string | Record<string, unknown> | null;
}

export interface PeopleSyncSourceState {
  id: number;
  provider: SyncProvider;
  source: ProviderSource | null;
  sourceRevision: number;
  draftSource: ProviderSource | null;
  draftSourceBaseRevision: number | null;
  draftSourceUpdatedAt: string | null;
  needsSourceReview: boolean;
  initialSourceReviewPending: boolean;
  sourceStatus: SourceStatus;
  sourceStatusCheckedAt: string | null;
  sourceStatusErrorCode: string | null;
}

// Elvanto batches are only ever written through batchRepository's own
// recordBatchResult, so for an Elvanto batch specifically, lastSyncResult --
// once non-null -- is always one of these four strings.
export type ElvantoLastSyncResult = 'review_required' | 'applied' | 'failed' | 'cancelled';

const ELVANTO_LAST_SYNC_RESULTS = new Set<ElvantoLastSyncResult>([
  'review_required', 'applied', 'failed', 'cancelled',
]);

// Narrows PeopleSyncBatch['lastSyncResult'] down to ElvantoLastSyncResult for
// an Elvanto batch specifically. Returns false for `null`, unrecognised
// strings, and Planning Center legacy summary objects.
export function isElvantoLastSyncResult(value: PeopleSyncBatch['lastSyncResult']): value is ElvantoLastSyncResult {
  return typeof value === 'string' && ELVANTO_LAST_SYNC_RESULTS.has(value as ElvantoLastSyncResult);
}

// Request body accepted by POST /elvanto/sync-batches. The update request is
// a partial patch merged over the existing stored batch. Mirrors elvanto.js's
// BATCH_BODY_ALLOWED allow-list exactly.
export interface ElvantoSyncBatchInput {
  enabled?: boolean;
  sourceKind: 'elvanto_category' | 'elvanto_group';
  sourceExternalId: string;
  defaultPeopleType?: PeopleType;
  gatheringTypeId?: number | null;
  gatheringAutoRemoveEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleFrequency?: 'daily' | 'weekly' | 'monthly';
  scheduleDay?: number;
}

export type ElvantoSyncBatchPatch = Partial<Omit<ElvantoSyncBatchInput, 'sourceKind' | 'sourceExternalId'>>;

// ─── people-sync settings (server/routes/integrations/peopleSync.js) ──────

export interface PeopleSyncSettings {
  authorityProvider: AuthorityProvider;
  pendingAuthorityProvider: SyncProvider | null;
  syncEnabled: boolean;
  peopleEditingLocked: boolean;
  elvantoIncludeContacts: boolean;
  elvantoAlignPeopleType: boolean;
  fullReconciliationFrequency: 'daily' | 'weekly' | 'monthly';
  fullReconciliationDay: number;
}

// Mirrors peopleSync.js's SETTINGS_ALLOWED_KEYS strict allow-list exactly.
export interface PeopleSyncSettingsPatch {
  syncEnabled?: boolean;
  peopleEditingLocked?: boolean;
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

// Different producers attach different optional fields; see plan.js's
// `plan.skipped.push(...)` call sites.
export interface SkippedAction {
  id: string;
  externalPersonId: string;
  individualId?: number;
  reason: string;
  activeAuthority?: AuthorityProvider;
}

export interface PeopleSyncSnapshotInfo {
  fetchedAt: string | null;
  mode: 'full' | 'incremental' | null;
}

export interface PeopleSyncPersonName {
  firstName: string;
  lastName: string;
}

export type PeopleSyncFamilyDisplay =
  | { state: 'unavailable' }
  | { state: 'none' }
  | {
    state: 'known';
    name: string;
    members: PeopleSyncPersonName[];
    totalOtherMembers: number;
  };

// Presentation-only data from reviewContext.js's buildReviewDirectory().
// `matchEligible` is only present for local people; selections are still
// constrained by the separately signed review context.
export interface PeopleSyncPersonDisplay extends PeopleSyncPersonName {
  // Older/mixed-version review responses may omit presentation-only family
  // context. Consumers must render that as unavailable rather than assuming
  // the optional display enrichment is present.
  family?: PeopleSyncFamilyDisplay;
  matchEligible?: boolean;
}

export interface PeopleSyncPeopleDirectory {
  external: Record<string, PeopleSyncPersonDisplay>;
  local: Record<string, PeopleSyncPersonDisplay>;
}

export interface IdentityCreatePerson {
  firstName: string;
  lastName: string;
  isChild: boolean | null;
  externalFamilyId: string | null;
  peopleType: PeopleType;
}

export interface IdentityReviewEntry {
  suggestedIndividualId: number | null;
  candidateIndividualIds: number[];
  excludedIndividualIds: number[];
  held: boolean;
  canCreate: boolean;
  createPerson: IdentityCreatePerson | null;
}

export type EstablishedLinkCorrection =
  | { outcome: 'relink'; fromIndividualId: number; individualId: number }
  | { outcome: 'unlink'; fromIndividualId: number };

export interface PeopleSyncEstablishedLink {
  individualId: number;
}

// Signed identity choices and create payloads. Unlike `people`, this is an
// authorization boundary, not just a display model.
export interface PeopleSyncReviewContext {
  version: 2;
  correctionContractVersion?: 1;
  establishedLinks?: Record<string, PeopleSyncEstablishedLink>;
  projectedEstablishedLinks?: Record<string, PeopleSyncEstablishedLink>;
  linkCorrections?: Array<{ externalPersonId: string } & EstablishedLinkCorrection>;
  manualCandidateIndividualIds: number[];
  identities: Record<string, IdentityReviewEntry>;
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
  // Safe display-only names. IDs remain the action keys used during apply.
  people?: PeopleSyncPeopleDirectory;
  reviewContext?: PeopleSyncReviewContext;
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
export type PeopleSyncBucketName = Exclude<
  keyof PeopleSyncPlan,
  'provider' | 'authoritative' | 'snapshot' | 'people' | 'reviewContext'
>;

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

// ─── Review / apply results (server/services/peopleSync/orchestrator.js) ──

export interface PeopleSyncCoverage {
  unlinkedActiveLocalRegulars: number;
}

// buildReview()'s and previewAuthoritySwitch()'s return shape. `authority`
// is present ONLY for previewAuthoritySwitch (POST
// /people-sync/people-authority/preview) -- buildReview (GET
// /elvanto/sync-batches/:id/plan) never includes it.
export interface PeopleSyncReview {
  runId: number;
  reviewToken: string;
  // Present on authority-switch previews. Cancellation uses this opaque
  // intent ID so an older UI cannot clear a newer pending switch.
  authorityPreviewId?: string | null;
  decisionContractVersion?: 2;
  summary: PeopleSyncPlanSummary;
  plan: PeopleSyncPlan;
  snapshot: PeopleSyncSnapshotInfo;
  authority?: PeopleSyncAuthorityState;
  coverage?: PeopleSyncCoverage;
}

export type PeopleSyncCorrectionPreview = Omit<PeopleSyncReview, 'runId'>;

export type OperationTaggedPeopleReview<
  Review extends PeopleSyncReview | PeopleSyncCorrectionPreview,
  Operation extends PeopleReviewOperationKind,
> = Omit<Review, 'operationKind' | 'reviewToken' | 'plan'> & {
  operationKind: Operation;
  reviewToken: PeopleReviewToken<Operation>;
  plan: Review['plan'] & { operationKind: Operation };
};

export type PeopleSyncOperationReview = OperationTaggedPeopleReview<PeopleSyncReview, 'people_sync'>;
export type AuthoritySwitchReview = OperationTaggedPeopleReview<PeopleSyncReview, 'authority_switch'>;
export type PeopleSyncOperationCorrectionPreview = OperationTaggedPeopleReview<
  PeopleSyncCorrectionPreview,
  'people_sync'
>;

/**
 * Tags one legacy sync/authority response at its endpoint-aware owner
 * boundary. Missing legacy markers are filled in, while a marker belonging
 * to another workflow is rejected before the review can enter component
 * state. Do not use this as a substitute for server token verification.
 */
export function tagLegacyPeopleReview<
  Review extends PeopleSyncReview | PeopleSyncCorrectionPreview,
  Operation extends 'people_sync' | 'authority_switch',
>(review: Review, operationKind: Operation): OperationTaggedPeopleReview<Review, Operation> {
  const reviewMarker = (review as Review & { operationKind?: unknown }).operationKind;
  const planMarker = (review.plan as Review['plan'] & { operationKind?: unknown }).operationKind;
  if ((reviewMarker !== undefined && reviewMarker !== operationKind)
    || (planMarker !== undefined && planMarker !== operationKind)) {
    throw new Error('The received people review belongs to a different operation.');
  }
  return {
    ...review,
    operationKind,
    reviewToken: review.reviewToken as PeopleReviewToken<Operation>,
    plan: { ...review.plan, operationKind },
  } as OperationTaggedPeopleReview<Review, Operation>;
}

// applyReviewed()'s return shape -- used by both POST
// /people-sync/people-authority/apply and POST
// /elvanto/sync-batches/:id/apply. Status is always 'applied': applyReviewed
// always calls finishAppliedRun with reviewRequiredWhenHeld: false, so it
// can never itself downgrade to 'review_required' the way runUnattended can.
export interface PeopleSyncApplyResult {
  runId: number;
  status: 'applied';
  // Never partial: applyResult only ever reaches this response after
  // applyPeopleSyncPlan has already returned successfully (a throw there is
  // caught earlier and fails the whole request instead), so this is always
  // the full emptyResult()-shaped count set.
  applied: PeopleSyncApplyCounts;
  // Partial, unlike `applied` above: safeSummarizePlan() wraps this specific
  // computation in its own try/catch and returns `{}` on an (unexpected,
  // belt-and-braces) failure -- AFTER the apply itself already succeeded --
  // logging server-side rather than failing an apply that already committed
  // real mutations. See orchestrator.js's safeSummarizePlan.
  summary: Partial<PeopleSyncPlanSummary>;
}

// ─── Reviewer selections (server/services/peopleSync/apply.js's validateSelections) ──
//
// Provider-neutral selections shared by Planning Center and Elvanto. V2
// identity decisions are keyed by external person ID; a manual link carries
// the chosen local individual ID. The pre-v2 fields remain only for stale PWA
// clients using the immediately previous review contract.
export type IdentityDecision =
  | { outcome: 'accept'; excludeIndividualId?: never }
  | { outcome: 'link'; individualId: number; excludeIndividualId?: number }
  | { outcome: 'create'; excludeIndividualId?: number }
  | { outcome: 'defer'; excludeIndividualId?: number };

export interface PeopleSyncSelections {
  // V2 selections replace legacy identity fields with one decision for each
  // signed external identity. Omit both fields for pre-v2 review responses.
  decisionContractVersion?: 2;
  identityDecisions?: Record<string, IdentityDecision>;
  linkCorrections?: Record<string, EstablishedLinkCorrection>;
  // Compatibility-only legacy fields. Do not use them when submitting v2.
  // externalPersonId -> chosen individualId, for entries in
  // plan.ambiguousPeople the reviewer resolved manually.
  ambiguous?: Record<string, number>;
  // addPeople externalPersonIds the reviewer chose to skip.
  skipExternalPersonIds?: string[];
  // externalPersonId -> 'promote' (link + convert to regular) or 'keep' (no
  // change), for reviewRequired linkPeople suggestions from visitor/archived
  // matches.
  visitorChoices?: Record<string, 'promote' | 'keep'>;
  // individualIds (drawn from unmatchedLocalRegulars or an ambiguousPeople
  // candidate list) the reviewer chose to archive outright.
  acceptArchiveIndividualIds?: number[];
  // renameFamily plan-ACTION ids (e.g. 'renameFamily:9', built by plan.js's
  // actionId() helper) the reviewer accepted -- NOT family IDs. See
  // apply.js's validateSelections, which builds
  // `renameById = new Map(plan.renameFamily.map(a => [a.id, a]))` and looks
  // up each submitted value against that map of string action ids (confirmed
  // against apply.test.js/apply.dbintegration.test.js's own string-id
  // fixtures, e.g. 'renameFamily:x'). Unreachable today only because
  // plan.renameFamily has no producer yet (always []) -- getting this type
  // wrong would surface the moment a producer lands: the review UI would
  // submit a numeric family id, renameById.has(...) would be false, and
  // validateSelections would throw, rejecting the ENTIRE apply (every
  // person-level action the reviewer approved included).
  acceptFamilyRenameIds?: string[];
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
