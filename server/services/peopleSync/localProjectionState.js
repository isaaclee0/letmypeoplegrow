'use strict';

const Database = require('../../config/database');
const linkRepository = require('./linkRepository');
const matchReviewRepository = require('./matchReviewRepository');

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

async function listGatheringMemberships(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT gathering_type_id, individual_id, added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    gatheringTypeId: Number(row.gathering_type_id),
    individualId: Number(row.individual_id),
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
} = {}) {
  return async function loadLocalProjectionState(churchId, provider) {
    const [individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState] =
      await Promise.all([
        loadIndividuals(churchId),
        loadFamilies(churchId),
        listPersonLinks(churchId, provider),
        listFamilyLinks(churchId, provider),
        loadGatheringMemberships(churchId),
        listMatchReviewState(churchId, provider),
      ]);
    return { individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState };
  };
}

const loadLocalProjectionState = createLocalProjectionStateLoader();

module.exports = { createLocalProjectionStateLoader, loadLocalProjectionState };
