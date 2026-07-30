'use strict';

const CODE = 'PCO_LEGACY_BATCH_RETIRED';
const MESSAGE = 'This legacy Planning Center batch is retired and can only be viewed or deleted.';

function isRetiredPlanningCenterBatch(batch) {
  return batch?.provider === 'planning_center' &&
    batch.legacyProviderBatchId !== null && batch.legacyProviderBatchId !== undefined;
}

function retiredPlanningCenterBatchError() {
  const error = new Error(MESSAGE);
  error.code = CODE;
  error.status = 409;
  return error;
}

function assertPlanningCenterBatchOperational(batch) {
  if (isRetiredPlanningCenterBatch(batch)) throw retiredPlanningCenterBatchError();
  return batch;
}

module.exports = {
  CODE, MESSAGE, isRetiredPlanningCenterBatch, retiredPlanningCenterBatchError, assertPlanningCenterBatchOperational,
};
