function operationalError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function deriveBatchOperationalState(batch, authorityProvider) {
  if (batch?.enabled !== true) return 'disabled';
  if (batch?.needsSourceReview === true || !batch?.source) return 'source_review_required';
  if (batch.provider !== authorityProvider) return 'prepared';
  return 'active';
}

function isBatchRunnable(batch, authorityProvider) {
  return deriveBatchOperationalState(batch, authorityProvider) === 'active';
}

function isBatchReviewable(batch, authorityProvider) {
  return batch?.enabled === true &&
    batch.provider === authorityProvider &&
    Boolean(batch.source || batch.draftSource);
}

function assertBatchRunnable(batch, authorityProvider) {
  const state = deriveBatchOperationalState(batch, authorityProvider);
  if (state === 'active') return;
  if (state === 'disabled') {
    throw operationalError('SYNC_BATCH_DISABLED', 'The batch for this run was disabled.', 400);
  }
  if (state === 'prepared') {
    throw operationalError('SYNC_BATCH_PREPARED', 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.', 409);
  }
  if (batch?.needsSourceReview === true) {
    throw operationalError('SYNC_SOURCE_REVIEW_REQUIRED', 'A source selection draft must be reviewed before this run can continue.', 409);
  }
  throw operationalError('SYNC_SOURCE_SELECTION_REQUIRED', 'A sync source must be selected for every enabled batch.', 409);
}

function assertBatchReviewable(batch, authorityProvider) {
  if (isBatchReviewable(batch, authorityProvider)) return;
  if (batch?.enabled !== true) {
    throw operationalError('SYNC_BATCH_DISABLED', 'The batch for this run was disabled.', 400);
  }
  if (batch.provider !== authorityProvider) {
    throw operationalError('SYNC_BATCH_PREPARED', 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.', 409);
  }
  if (batch.needsSourceReview === true) {
    throw operationalError('SYNC_SOURCE_REVIEW_REQUIRED', 'A source selection draft must be reviewed before this run can continue.', 409);
  }
  throw operationalError('SYNC_SOURCE_SELECTION_REQUIRED', 'A sync source must be selected for every enabled batch.', 409);
}

module.exports = {
  deriveBatchOperationalState,
  isBatchRunnable,
  isBatchReviewable,
  assertBatchRunnable,
  assertBatchReviewable,
};
