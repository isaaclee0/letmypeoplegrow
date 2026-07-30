const Database = require('../../config/database');
const linkRepository = require('./linkRepository');
const matchReviewRepository = require('./matchReviewRepository');
const authority = require('./authority');
const batchRepository = require('./batchRepository');
const { BUCKETS } = require('./plan');
const {
  validateDestructiveSelections,
  validateIdentityDecisions,
} = require('./identityDecisions');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);

// Buckets that mutate an EXISTING individual's own fields/lifecycle/family.
// Buckets that only create new records or establish an identity link
// (linkPeople, linkFamilies, addPeople, addFamilies, addToGathering) are not
// subject to the authority lock — see enforceAuthorityLock() below for why.
const INDIVIDUAL_MUTATION_BUCKETS = [
  'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily',
];
const SUGGESTION_DEPENDENT_BUCKETS = [
  ...INDIVIDUAL_MUTATION_BUCKETS, 'addToGathering', 'removeFromGathering',
];

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toPositiveInt(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a valid positive integer ID`);
  return id;
}

// The returned result object shares summarizePlan's bucket KEYS, but each
// count means "actions actually applied this call", not "plan bucket size" —
// the two can and do diverge. Review-only buckets (ambiguousPeople,
// familyConflicts, unmatchedLocalRegulars, skipped) always stay 0 here since
// apply never mutates anything directly off them; their resolutions surface
// through other counters instead (e.g. an accepted ambiguousPeople selection
// increments linkPeople, not ambiguousPeople). linkPeople itself can be
// LARGER than plan.linkPeople.length (accepted ambiguous/visitor selections
// add extra links not counted in that array) or SMALLER (a reviewRequired
// linkPeople suggestion nobody accepted this call contributes 0).
function emptyResult() {
  const result = {};
  for (const bucket of BUCKETS) result[bucket] = 0;
  result.familyNamesUpdated = 0;
  result.gatheringAssigned = 0;
  result.gatheringRemoved = 0;
  return result;
}

/**
 * Pure, DB-free validation of a reviewer's selections against a plan.
 *
 * The selection payload is intentionally narrow:
 *   {
 *     ambiguous: { [externalPersonId]: individualId },
 *     skipExternalPersonIds: [],
 *     visitorChoices: { [externalPersonId]: 'promote' | 'keep' },
 *     acceptArchiveIndividualIds: [],
 *     acceptFamilyRenameIds: [],
 *   }
 *
 * Every choice must resolve against something the plan itself already
 * offered (an ambiguousPeople candidate, a reviewRequired linkPeople
 * suggestion, an addPeople addition, an unmatchedLocalRegulars/ambiguous
 * candidate individual, or a renameFamily action id). Because the plan was
 * computed server-side against this church's own local people, restricting
 * every selection to values already present in the plan is what prevents a
 * selection from reaching into another church via an arbitrary local ID —
 * validateSelections never accepts a bare ID it hasn't first verified
 * appears somewhere in the plan's own review buckets.
 */
function validateLegacySelections(plan, selections = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('A plan is required to validate selections against');

  const ambiguousByExternal = new Map(asArray(plan.ambiguousPeople).map((a) => [a.externalPersonId, a]));
  const addByExternal = new Map(asArray(plan.addPeople).map((a) => [a.externalPersonId, a]));
  const reviewLinksByExternal = new Map(
    asArray(plan.linkPeople).filter((a) => a.reviewRequired).map((a) => [a.externalPersonId, a])
  );
  const establishedLinks = asArray(plan.linkPeople).filter((a) => !a.reviewRequired);
  const acceptedLinks = [];
  const claimedExternalIds = new Set(establishedLinks.map((a) => a.externalPersonId));
  const claimedIndividualIds = new Set(establishedLinks.map((a) => a.individualId));

  const claimLink = (externalPersonId, individualId, sourceLabel) => {
    if (claimedExternalIds.has(externalPersonId) || claimedIndividualIds.has(individualId)) {
      throw new Error(`${sourceLabel} selection for ${externalPersonId} collides with another accepted link or addition`);
    }
    claimedExternalIds.add(externalPersonId);
    claimedIndividualIds.add(individualId);
  };

  for (const [externalPersonId, rawIndividualId] of Object.entries(asRecord(selections.ambiguous))) {
    const entry = ambiguousByExternal.get(externalPersonId);
    if (!entry) throw new Error(`Ambiguous selection references a person not offered for review in this plan: ${externalPersonId}`);
    const individualId = toPositiveInt(rawIndividualId, 'Ambiguous selection individual ID');
    const candidateIds = entry.candidateIndividualIds || [];
    if (!candidateIds.includes(individualId)) {
      throw new Error(`Ambiguous selection for ${externalPersonId} must choose one of this plan's own candidate individuals`);
    }
    claimLink(externalPersonId, individualId, 'Ambiguous');
    acceptedLinks.push({ externalPersonId, individualId, linkSource: 'manual' });
  }

  for (const [externalPersonId, choice] of Object.entries(asRecord(selections.visitorChoices))) {
    const entry = reviewLinksByExternal.get(externalPersonId);
    if (!entry) throw new Error(`Visitor choice references a person not offered for review in this plan: ${externalPersonId}`);
    if (choice !== 'promote' && choice !== 'keep') {
      throw new Error(`Visitor choice for ${externalPersonId} must be "promote" or "keep"`);
    }
    if (choice === 'promote') {
      claimLink(externalPersonId, entry.individualId, 'Visitor');
      acceptedLinks.push({ externalPersonId, individualId: entry.individualId, linkSource: 'manual' });
    }
  }

  const skipExternalPersonIds = new Set();
  for (const externalPersonId of asArray(selections.skipExternalPersonIds)) {
    if (!addByExternal.has(externalPersonId)) {
      throw new Error(`Cannot skip an addition not offered in this plan: ${externalPersonId}`);
    }
    skipExternalPersonIds.add(externalPersonId);
  }

  const destructive = validateDestructiveSelections(plan, selections, claimedIndividualIds);
  return {
    contractVersion: 1,
    acceptedLinks,
    skipExternalPersonIds,
    ...destructive,
  };
}

function validateSelections(plan, selections = {}) {
  if (selections && Object.hasOwn(selections, 'decisionContractVersion')) {
    if (selections.decisionContractVersion !== 2) {
      throw new Error('Unsupported identity decision contract version');
    }
    return validateIdentityDecisions(plan, selections);
  }
  if (selections && Object.hasOwn(selections, 'identityDecisions')) {
    throw new Error('Identity decisions require decision contract version 2');
  }
  return validateLegacySelections(plan, selections);
}

function collectTouchedIndividualIds(plan, acceptedArchiveIndividualIds) {
  const ids = new Set();
  for (const bucket of INDIVIDUAL_MUTATION_BUCKETS) {
    for (const action of asArray(plan[bucket])) ids.add(action.individualId);
  }
  for (const individualId of acceptedArchiveIndividualIds) ids.add(individualId);
  return [...ids];
}

function collectTouchedFamilyIds(plan) {
  const ids = new Set();
  for (const action of asArray(plan.moveFamily)) if (action.familyId != null) ids.add(Number(action.familyId));
  for (const action of asArray(plan.renameFamily)) if (action.familyId != null) ids.add(Number(action.familyId));
  return [...ids];
}

function planWithSuppressedSuggestions(plan, accepted) {
  if (accepted.contractVersion !== 2) return plan;
  const externalPersonIds = new Set();
  const individualIds = new Set();
  for (const pair of accepted.suppressedSuggestedPairs) {
    externalPersonIds.add(pair.externalPersonId);
    individualIds.add(pair.suggestedIndividualId);
  }
  if (externalPersonIds.size === 0) return plan;

  const filtered = { ...plan };
  for (const bucket of SUGGESTION_DEPENDENT_BUCKETS) {
    filtered[bucket] = asArray(plan[bucket]).filter((action) =>
      !externalPersonIds.has(action.externalPersonId) && !individualIds.has(action.individualId)
    );
  }
  return filtered;
}

// Defense in depth: Task 6's plan.js already refuses to generate managed
// mutations for a person/family locked by a DIFFERENT active authority (see
// plan.js's `canManage`/`activeAuthority` gating). This re-checks the same
// invariant directly against the database inside the transaction, so a
// stale, hand-built, or buggy plan can never mutate an authority-linked
// record just because it slipped past plan computation. Pure identity
// actions (linkPeople/linkFamilies/addPeople/addFamilies/addToGathering)
// are exempt: tracking which external IDs correspond to a person across
// multiple providers is authority-agnostic — only mutating that person's
// own fields/lifecycle/family is restricted to the current authority.
async function enforceAuthorityLock(churchId, provider, plan, acceptedArchiveIndividualIds) {
  const authorityState = await authority.getAuthority(churchId);
  if (authorityState.active === 'none' || authorityState.active === provider) return;

  const touchedIndividualIds = collectTouchedIndividualIds(plan, acceptedArchiveIndividualIds);
  if (touchedIndividualIds.length > 0) {
    const managedLinks = await authority.getManagedLinks(churchId, touchedIndividualIds);
    for (const individualId of touchedIndividualIds) {
      if (authority.isPersonLocked(authorityState.active, managedLinks.get(individualId))) {
        throw new Error(
          `Individual ${individualId} is managed by the active people-sync authority (${authorityState.active}); ` +
          `a non-authoritative ${provider} plan cannot modify it`
        );
      }
    }
  }

  const touchedFamilyIds = collectTouchedFamilyIds(plan);
  if (touchedFamilyIds.length > 0) {
    const managedFamilyIds = await authority.getManagedFamilyIds(churchId, touchedFamilyIds, authorityState.active);
    for (const familyId of touchedFamilyIds) {
      if (managedFamilyIds.has(familyId)) {
        throw new Error(
          `Family ${familyId} is managed by the active people-sync authority (${authorityState.active}); ` +
          `a non-authoritative ${provider} plan cannot modify it`
        );
      }
    }
  }
}

/**
 * Applies a provider-neutral sync plan (see plan.js's computePeopleSyncPlan)
 * inside ONE critical database transaction. Unlike the legacy PCO apply
 * service, this never catches-and-continues per item: any failure in a
 * person/family/link mutation throws and rolls back everything this call
 * did. Optional, non-critical provider extras (e.g. PCO background-check
 * projection) are NOT this function's concern — they belong outside/after
 * the critical transaction, in whichever caller wires up that provider.
 */
async function applyPeopleSyncPlan({ churchId, provider, plan, selections = {}, userId, activateAuthority = false, sourcePromotion = null }) {
  assertProvider(provider);
  if (!churchId) throw new Error('A churchId is required to apply a people-sync plan');
  if (!plan || typeof plan !== 'object') throw new Error('A plan is required to apply');
  if (plan.provider && plan.provider !== provider) {
    throw new Error(`Plan was computed for provider "${plan.provider}", not "${provider}"`);
  }

  const accepted = validateSelections(plan, selections);

  return Database.transactionForChurch(churchId, async (conn) => {
    const applicablePlan = planWithSuppressedSuggestions(plan, accepted);
    await enforceAuthorityLock(churchId, provider, applicablePlan, accepted.acceptedArchiveIndividualIds);

    const result = emptyResult();

    // 1. Person links: auto-approved matches plus reviewer-accepted
    // ambiguous/visitor choices. Must run before addPeople/archive/etc so an
    // auto-linked-then-archived person (see plan.js's carried-forward note)
    // ends up linked, then archived — not archived against a link that
    // doesn't exist yet.
    const linkActions = accepted.contractVersion === 2
      ? accepted.linkActions
      : [...asArray(plan.linkPeople).filter((a) => !a.reviewRequired), ...accepted.acceptedLinks];
    for (const action of linkActions) {
      await linkRepository.upsertPersonLinkWithConnection(conn, {
        churchId, provider, externalPersonId: action.externalPersonId,
        individualId: action.individualId, linkSource: action.linkSource || 'matched',
      });
      if (provider === 'planning_center') {
        await conn.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [action.externalPersonId, action.individualId, churchId]
        );
      }
      result.linkPeople++;
    }

    // 2. Family links (symmetric to person links). plan.js does not populate
    // this bucket yet (family matching is future work) — handled here
    // defensively/forward-compatibly so a later plan.js change can populate
    // it without a matching apply.js change.
    for (const action of asArray(plan.linkFamilies)) {
      await linkRepository.upsertFamilyLinkWithConnection(conn, {
        churchId, provider, externalFamilyId: action.externalFamilyId,
        familyId: action.familyId, linkSource: action.linkSource || 'matched',
      });
      if (provider === 'planning_center') {
        await conn.query(
          `UPDATE families SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [action.externalFamilyId, action.familyId, churchId]
        );
      }
      result.linkFamilies++;
    }

    // 3. New families. The reviewed name must already be on the action —
    // apply never derives/rebuilds a family name from member data.
    for (const action of asArray(plan.addFamilies)) {
      const familyName = typeof action.familyName === 'string' ? action.familyName.trim() : '';
      if (!familyName) throw new Error(`addFamilies action ${action.id} is missing a reviewed family name`);
      const insertResult = await conn.query(
        `INSERT INTO families (church_id, family_name, created_by, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [churchId, familyName, userId || null]
      );
      const familyId = insertResult.insertId;
      if (action.externalFamilyId) {
        await linkRepository.upsertFamilyLinkWithConnection(conn, {
          churchId, provider, externalFamilyId: action.externalFamilyId, familyId, linkSource: 'created',
        });
        if (provider === 'planning_center') {
          await conn.query(
            `UPDATE families SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
            [action.externalFamilyId, familyId, churchId]
          );
        }
      }
      result.addFamilies++;
    }

    // 4. New people. IMPORTANT: action.familyId here is the EXTERNAL
    // provider's household/family id (see plan.js's
    // `familyId: externalPerson.familyId ?? null` — the same raw value
    // matcher.js treats as an external-side key throughout), NOT a local
    // families.id. Resolve it through external_family_links, scoped to this
    // church and provider; if that household hasn't been linked to a local
    // family, leave the new person family-less. Apply never invents a
    // family (or a name for one) on this path — that stays reserved for an
    // explicit addFamilies action carrying a reviewed name.
    const newIndividualIdByExternal = new Map();
    let addPeopleActions;
    if (accepted.contractVersion === 2) {
      const byExternalPersonId = new Map();
      const createPersonFor = (externalPersonId) => {
        const createPerson = plan.reviewContext.identities[externalPersonId].createPerson;
        return {
          id: `addPeople:${externalPersonId}`,
          externalPersonId,
          firstName: createPerson.firstName,
          lastName: createPerson.lastName,
          isChild: createPerson.isChild,
          familyId: createPerson.externalFamilyId,
          peopleType: createPerson.peopleType,
        };
      };
      for (const action of asArray(plan.addPeople)) {
        if (accepted.skippedAddExternalIds.has(action.externalPersonId)) continue;
        if (accepted.createExternalIds.has(action.externalPersonId)) {
          byExternalPersonId.set(action.externalPersonId, createPersonFor(action.externalPersonId));
        }
      }
      for (const externalPersonId of accepted.createExternalIds) {
        if (!byExternalPersonId.has(externalPersonId)) {
          byExternalPersonId.set(externalPersonId, createPersonFor(externalPersonId));
        }
      }
      addPeopleActions = [...byExternalPersonId.values()];
    } else {
      addPeopleActions = asArray(plan.addPeople)
        .filter((action) => !accepted.skipExternalPersonIds.has(action.externalPersonId));
    }
    for (const action of addPeopleActions) {
      const peopleType = action.peopleType;
      if (!PEOPLE_TYPES.has(peopleType)) throw new Error(`addPeople action ${action.id} has an invalid people type`);
      let familyId = null;
      if (action.familyId !== null && action.familyId !== undefined) {
        familyId = await linkRepository.findFamilyIdByExternalId(conn, churchId, provider, action.familyId);
      }
      const insertResult = await conn.query(
        `INSERT INTO individuals
           (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
        [churchId, familyId, action.firstName, action.lastName, peopleType, action.isChild === true ? 1 : 0, userId || null]
      );
      const individualId = insertResult.insertId;
      newIndividualIdByExternal.set(action.externalPersonId, individualId);
      await linkRepository.upsertPersonLinkWithConnection(conn, {
        churchId, provider, externalPersonId: action.externalPersonId, individualId, linkSource: 'created',
      });
      if (provider === 'planning_center') {
        await conn.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [action.externalPersonId, individualId, churchId]
        );
      }
      result.addPeople++;
    }

    // 5. Managed field updates. Defensively ignore an isChild change whose
    // externalValue is null/undefined — never write an unknown child state
    // into is_child, even if a plan somehow carried one (plan.js itself
    // never emits such a change; this is belt-and-braces).
    for (const action of asArray(applicablePlan.updateManagedFields)) {
      const setClauses = [];
      const params = [];
      for (const change of asArray(action.changes)) {
        if (change.field === 'firstName') { setClauses.push('first_name = ?'); params.push(change.externalValue); }
        else if (change.field === 'lastName') { setClauses.push('last_name = ?'); params.push(change.externalValue); }
        else if (change.field === 'isChild') {
          if (change.externalValue === null || change.externalValue === undefined) continue;
          setClauses.push('is_child = ?'); params.push(change.externalValue ? 1 : 0);
        }
      }
      if (setClauses.length === 0) continue;
      params.push(action.individualId, churchId);
      await conn.query(
        `UPDATE individuals SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        params
      );
      result.updateManagedFields++;
    }

    // 6. People-type alignment.
    for (const action of asArray(applicablePlan.promoteToRegular)) {
      await conn.query(
        `UPDATE individuals SET people_type = 'regular', updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [action.individualId, churchId]
      );
      result.promoteToRegular++;
    }
    for (const action of asArray(applicablePlan.demoteToLocalVisitor)) {
      await conn.query(
        `UPDATE individuals SET people_type = 'local_visitor', updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [action.individualId, churchId]
      );
      result.demoteToLocalVisitor++;
    }

    // 7. Archive: plan-driven (lifecycle/presence based) plus any extra
    // individuals the reviewer explicitly chose to archive instead of
    // linking/leaving unmatched.
    for (const action of asArray(applicablePlan.archive)) {
      await conn.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [action.individualId, churchId]
      );
      result.archive++;
    }
    for (const individualId of accepted.acceptedArchiveIndividualIds) {
      await conn.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [individualId, churchId]
      );
      result.archive++;
    }

    // 8. Reactivate.
    for (const action of asArray(applicablePlan.reactivate)) {
      await conn.query(
        `UPDATE individuals SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [action.individualId, churchId]
      );
      result.reactivate++;
    }

    // 9. Move family. SPECULATIVE / UNVALIDATED: unlike linkFamilies,
    // addFamilies, and renameFamily (which read reasonably off the plan.js
    // spec even though plan.js doesn't populate them yet either), moveFamily
    // has no anchor in plan.js or in any spec text at all — there is no
    // producer for this bucket and no shape documented anywhere. The handling
    // below (and its dbintegration test) is only this author's guess at what
    // a future "move an individual to a different existing family" action
    // might look like; do not treat the synthetic test as proof the real
    // contract matches once a producer for this bucket actually exists.
    for (const action of asArray(applicablePlan.moveFamily)) {
      const familyId = toPositiveInt(action.familyId, 'moveFamily familyId');
      await linkRepository.assertLocalRecord(conn, 'families', familyId, churchId);
      await conn.query(
        `UPDATE individuals SET family_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [familyId, action.individualId, churchId]
      );
      result.moveFamily++;
    }

    // 10. Rename family: only ever the ones the reviewer explicitly
    // accepted, using the reviewed name already on the action — apply never
    // invents or recomputes a family name.
    for (const action of asArray(plan.renameFamily)) {
      if (!accepted.acceptedFamilyRenameIds.has(action.id)) continue;
      const familyName = typeof action.familyName === 'string' ? action.familyName.trim() : '';
      if (!familyName) throw new Error(`renameFamily action ${action.id} is missing a reviewed family name`);
      const familyId = toPositiveInt(action.familyId, 'renameFamily familyId');
      await linkRepository.assertLocalRecord(conn, 'families', familyId, churchId);
      await conn.query(
        `UPDATE families SET family_name = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [familyName, familyId, churchId]
      );
      result.renameFamily++;
      result.familyNamesUpdated++;
    }

    // 11. Gathering roster additions. individualId is null on an
    // addToGathering action exactly when it targets a brand-new addPeople
    // person — resolve it via the externalPersonId -> new individual map
    // built in step 4 (which must therefore run before this step).
    for (const action of asArray(applicablePlan.addToGathering)) {
      const individualId = action.individualId ?? newIndividualIdByExternal.get(action.externalPersonId);
      if (!individualId) continue; // the person this targeted was never created (e.g. skipped) — nothing to add.
      const insertResult = await conn.query(
        `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id, added_by_sync_batch_id)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
        [action.gatheringTypeId, individualId, userId || null, churchId, action.batchId]
      );
      result.addToGathering++;
      if (insertResult.affectedRows > 0) result.gatheringAssigned++;
    }

    // 12. Gathering roster removals. A sync batch may only ever remove a
    // roster row that carries its OWN provenance (added_by_sync_batch_id =
    // this action's batchId) — manual rows (NULL) and other batches' rows
    // never match that WHERE clause.
    //
    // The actual correctness guarantee that "another enabled batch still
    // qualifying this person keeps them on the roster" comes from plan.js's
    // addGatheringActions/remainsEligible, which already checks eligibility
    // across ALL enabled batches targeting this gathering before it ever
    // proposes a removal (see plan.js) — apply itself has no independent way
    // to re-derive batch eligibility (that requires live provider data plan
    // computation already folded in). The `staying` check below is only
    // belt-and-braces on top of that: it catches this SAME plan proposing a
    // contradictory addToGathering for the same pair, not a scenario apply
    // could detect on its own. If a future orchestrator ever computes a
    // single-batch (not combined) plan, this check alone would NOT be
    // sufficient to protect a row another batch's plan still wants kept.
    const staying = new Set(asArray(applicablePlan.addToGathering).map((a) => {
      const individualId = a.individualId ?? newIndividualIdByExternal.get(a.externalPersonId);
      return `${a.gatheringTypeId}:${individualId}`;
    }));
    for (const action of asArray(applicablePlan.removeFromGathering)) {
      if (staying.has(`${action.gatheringTypeId}:${action.individualId}`)) continue;
      const deleteResult = await conn.query(
        `DELETE FROM gathering_lists
          WHERE gathering_type_id = ? AND individual_id = ? AND added_by_sync_batch_id = ? AND church_id = ?`,
        [action.gatheringTypeId, action.individualId, action.batchId, churchId]
      );
      result.removeFromGathering++;
      if (deleteResult.affectedRows > 0) result.gatheringRemoved++;
    }

    if (accepted.contractVersion === 2) {
      for (const [externalPersonId, reason] of accepted.deferredReasons) {
        await matchReviewRepository.upsertHoldWithConnection(conn, {
          churchId, provider, externalPersonId, reason, userId,
        });
      }
      for (const action of linkActions) {
        await matchReviewRepository.deleteHoldWithConnection(conn, {
          churchId, provider, externalPersonId: action.externalPersonId,
        });
      }
      for (const externalPersonId of newIndividualIdByExternal.keys()) {
        await matchReviewRepository.deleteHoldWithConnection(conn, {
          churchId, provider, externalPersonId,
        });
      }
      for (const exclusion of accepted.exclusionsToAdd) {
        await matchReviewRepository.upsertExclusionWithConnection(conn, {
          churchId, provider, ...exclusion, userId,
        });
      }
      for (const exclusion of accepted.exclusionsToRemove) {
        await matchReviewRepository.deleteExclusionWithConnection(conn, {
          churchId, provider, ...exclusion,
        });
      }
    }

    if (sourcePromotion) {
      await batchRepository.promoteSourceDraftWithConnection(conn, {
        churchId, provider,
        batchId: sourcePromotion.batchId,
        expectedBaseRevision: sourcePromotion.expectedBaseRevision,
        expectedDraftDigest: sourcePromotion.expectedDraftDigest,
      });
    }

    // Authority activation is part of this same critical transaction. If
    // the pending provider changed after review, the switch fails and every
    // person/link/family/gathering mutation above rolls back with it.
    if (activateAuthority) {
      // A source can be previewed, then disconnected before reviewed apply.
      // Validate PCO credential existence inside this same reconciliation /
      // authority transaction so that stale review can never leave active
      // Planning Center authority with no usable connection row.
      if (provider === 'planning_center') {
        const connections = await conn.query(
          `SELECT 1 AS present
             FROM integration_connections
            WHERE church_id = ? AND provider = 'planning_center'
            LIMIT 1`,
          [churchId]
        );
        if (!connections.length) {
          const error = new Error('A Planning Center connection is required before it can become the people authority');
          error.code = 'SYNC_NOT_CONNECTED';
          throw error;
        }
      }
      await authority.commitAuthoritySwitchWithConnection(conn, churchId, provider);
    }

    return result;
  });
}

module.exports = {
  applyPeopleSyncPlan,
  validateIdentityDecisions,
  validateLegacySelections,
  validateSelections,
};
