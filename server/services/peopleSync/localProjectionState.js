'use strict';

const Database = require('../../config/database');
const linkRepository = require('./linkRepository');
const matchReviewRepository = require('./matchReviewRepository');
const reconciliationKeepRepository = require('./reconciliationKeepRepository');
const householdChoiceRepository = require('./householdChoiceRepository');

async function listLocalIndividuals(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT id, first_name, last_name, people_type, family_id, is_child, is_active, planning_center_id
       FROM individuals WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    peopleType: row.people_type,
    familyId: row.family_id === null || row.family_id === undefined ? null : Number(row.family_id),
    isChild: !!row.is_child,
    isActive: !!row.is_active,
    planningCenterId: row.planning_center_id || null,
  }));
}

async function listLocalFamilies(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT id, family_name, family_identifier, planning_center_id FROM families WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    familyName: row.family_name,
    familyIdentifier: row.family_identifier,
    planningCenterId: row.planning_center_id || null,
  }));
}

async function listGatheringMemberships(churchId, provider) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT gl.gathering_type_id, gl.individual_id, gl.added_by_sync_batch_id, gl.added_by_pco_batch_id, g.name AS gathering_name,
            EXISTS(SELECT 1 FROM people_sync_batches b
                    WHERE b.church_id = gl.church_id AND b.gathering_type_id = gl.gathering_type_id
                      AND b.provider <> ?) AS has_other_provider_sources
       FROM gathering_lists gl
       JOIN gathering_types g ON g.id = gl.gathering_type_id AND g.church_id = gl.church_id
      WHERE gl.church_id = ?`,
    [provider, churchId]
  );
  return rows.map((row) => ({
    gatheringTypeId: Number(row.gathering_type_id),
    gatheringName: row.gathering_name,
    hasOtherProviderSources: !!row.has_other_provider_sources,
    individualId: Number(row.individual_id),
    addedByPcoBatchId: row.added_by_pco_batch_id == null ? null : Number(row.added_by_pco_batch_id),
    addedBySyncBatchId: row.added_by_sync_batch_id === null || row.added_by_sync_batch_id === undefined
      ? null : Number(row.added_by_sync_batch_id),
  }));
}

function createLocalProjectionStateLoader({
  listLocalIndividuals: loadIndividuals = listLocalIndividuals,
  listLocalFamilies: loadFamilies = listLocalFamilies,
  listPersonLinks = linkRepository.listPersonLinks,
  listFamilyLinks = linkRepository.listFamilyLinks,
  listGatheringMemberships: loadGatheringMemberships = listGatheringMemberships,
  listMatchReviewState = matchReviewRepository.listMatchReviewState,
  listReconciliationKeeps = reconciliationKeepRepository.listReconciliationKeeps,
  listHouseholdPreferences = householdChoiceRepository.listHouseholdPreferences,
} = {}) {
  return async function loadLocalProjectionState(churchId, provider) {
    const [individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState, reconciliationKeeps, householdPreferences] =
      await Promise.all([
        loadIndividuals(churchId),
        loadFamilies(churchId),
        listPersonLinks(churchId, provider),
        listFamilyLinks(churchId, provider),
        loadGatheringMemberships(churchId, provider),
        listMatchReviewState(churchId, provider),
        listReconciliationKeeps(churchId, provider),
        listHouseholdPreferences(churchId, provider),
      ]);
    return { individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState, reconciliationKeeps, householdPreferences };
  };
}

const loadLocalProjectionState = createLocalProjectionStateLoader();

module.exports = { createLocalProjectionStateLoader, loadLocalProjectionState };
