'use strict';

const express = require('express');
const logger = require('../../config/logger');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const orchestrator = require('../../services/peopleSync/orchestrator');
const { createReviewJobs } = require('../../services/planningCenter/reviewJobs');
const { DEFAULT_ROUTE_TIMEOUT_MS, RouteTimeoutError, withTimeout } = require('./routeTimeout');

const PROVIDER = 'planning_center';

const defaultDeps = {
  routeTimeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
  buildReview: orchestrator.buildReview,
  previewLinkCorrections: orchestrator.previewLinkCorrections,
  previewHouseholdChoices: orchestrator.previewHouseholdChoices,
  applyReviewed: orchestrator.applyReviewed,
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBatchId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function respondWithError(res, error, label) {
  if (error?.code === 'SYNC_BATCH_PREPARED') {
    return res.status(409).json({
      error: 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
      code: error.code,
    });
  }
  if (error instanceof RouteTimeoutError) {
    return res.status(503).json({ error: 'Planning Center sync timed out. Please try again.', code: error.code });
  }
  if (error instanceof orchestrator.OrchestratorError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logger.error(`${label}: ${error.message}`);
  return res.status(500).json({ error: 'Planning Center sync failed.' });
}

function createPlanningCenterPeopleSyncRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();
  const jobs = createReviewJobs();
  router.use(requireRole(['admin']));
  router.use(ensureChurchIsolation);

  function pending(res, jobId) {
    return res.status(202).set('Retry-After', '4').json({ jobId });
  }

  async function runOperation(req, res, operation, input) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.query.background === '1') {
        const jobId = jobs.start({ churchId: req.user.church_id, userId: req.user.id,
          operation, input, run: deps[operation] });
        if (!jobId) return res.status(503).json({ error: 'Several reviews are running. Try again shortly.' });
        return pending(res, jobId);
      }
      const result = await withTimeout(deps[operation](input), deps.routeTimeoutMs);
      return res.json({ success: true, ...result });
    } catch (error) {
      return respondWithError(res, error, 'planning-center ' + operation);
    }
  }

  router.get('/sync/jobs/:jobId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = jobs.get(req.params.jobId, req.user.church_id, req.user.id);
    if (!job) return res.status(404).json({ code: 'SYNC_JOB_UNAVAILABLE', error: 'This sync result is no longer available. Refresh the review to check its current state.' });
    if (job.state === 'running') return pending(res, job.id);
    if (job.state === 'timedOut') {
      const error = job.operation === 'applyReviewed'
        ? 'Planning Center sync exceeded its time limit. Check sync history before applying another review.'
        : 'Planning Center took too long to prepare this review. Please try again.';
      return res.status(503).json({ error, code: 'SYNC_ROUTE_TIMEOUT' });
    }
    if (job.state === 'failed') return respondWithError(res, job.error, 'planning-center ' + job.operation);
    return res.json({ success: true, ...job.result });
  });

  router.get(['/sync/plan', '/sync-batches/:id/plan'], async (req, res) => {
    const integrationScope = req.params.id === undefined;
    const batchId = integrationScope ? null : parseBatchId(req.params.id);
    if (!integrationScope && batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    return runOperation(req, res, 'buildReview', {
      churchId: req.user.church_id,
      provider: PROVIDER,
      batchId,
      trigger: 'manual',
    });
  });

  router.post(['/sync/preview-link-corrections', '/sync-batches/:id/preview-link-corrections'], async (req, res) => {
    const integrationScope = req.params.id === undefined;
    const batchId = integrationScope ? null : parseBatchId(req.params.id);
    const baseReviewToken = typeof req.body?.baseReviewToken === 'string'
      ? req.body.baseReviewToken.trim()
      : '';
    if (!integrationScope && batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    if (!baseReviewToken) {
      return res.status(400).json({
        error: 'A base review token is required.',
        code: 'SYNC_REVIEW_TOKEN_REQUIRED',
      });
    }
    if (!isPlainObject(req.body?.linkCorrections)) {
      return res.status(400).json({
        error: 'Link corrections must be an object.',
        code: 'SYNC_SELECTIONS_INVALID',
      });
    }
    return runOperation(req, res, 'previewLinkCorrections', {
      churchId: req.user.church_id,
      provider: PROVIDER,
      batchId,
      baseReviewToken,
      linkCorrections: req.body.linkCorrections,
    });
  });

  router.post(['/sync/preview-household-choices', '/sync-batches/:id/preview-household-choices'], async (req, res) => {
    const integrationScope = req.params.id === undefined;
    const batchId = integrationScope ? null : parseBatchId(req.params.id);
    const baseReviewToken = typeof req.body?.baseReviewToken === 'string' ? req.body.baseReviewToken.trim() : '';
    if (!integrationScope && batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    if (!baseReviewToken) return res.status(400).json({ error: 'A base review token is required.', code: 'SYNC_REVIEW_TOKEN_REQUIRED' });
    if (!isPlainObject(req.body?.householdChoices)) {
      return res.status(400).json({ error: 'Household choices must be an object.', code: 'SYNC_SELECTIONS_INVALID' });
    }
    return runOperation(req, res, 'previewHouseholdChoices', {
      churchId: req.user.church_id, provider: PROVIDER, batchId,
      baseReviewToken, householdChoices: req.body.householdChoices,
    });
  });

  router.post(['/sync/apply', '/sync-batches/:id/apply'], async (req, res) => {
    const integrationScope = req.params.id === undefined;
    const batchId = integrationScope ? null : parseBatchId(req.params.id);
    if (!integrationScope && batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    const reviewToken = typeof req.body?.reviewToken === 'string' ? req.body.reviewToken.trim() : '';
    if (!reviewToken) {
      return res.status(400).json({
        error: 'A review token is required before this sync can be applied.',
        code: 'SYNC_REVIEW_TOKEN_REQUIRED',
      });
    }
    return runOperation(req, res, 'applyReviewed', {
      churchId: req.user.church_id,
      provider: PROVIDER,
      batchId,
      ...(integrationScope ? { operationKind: 'people_sync' } : {}),
      reviewToken,
      selections: req.body?.selections || {},
      userId: req.user.id,
    });
  });

  return router;
}

module.exports = { createPlanningCenterPeopleSyncRouter, defaultDeps };
