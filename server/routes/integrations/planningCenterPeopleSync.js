'use strict';

const express = require('express');
const logger = require('../../config/logger');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const orchestrator = require('../../services/peopleSync/orchestrator');
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
  router.use(requireRole(['admin']));
  router.use(ensureChurchIsolation);

  router.get(['/sync/plan', '/sync-batches/:id/plan'], async (req, res) => {
    const integrationScope = req.params.id === undefined;
    const batchId = integrationScope ? null : parseBatchId(req.params.id);
    if (!integrationScope && batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      const review = await withTimeout(deps.buildReview({
        churchId: req.user.church_id,
        provider: PROVIDER,
        batchId,
        trigger: 'manual',
      }), deps.routeTimeoutMs);
      return res.json({ success: true, ...review });
    } catch (error) {
      return respondWithError(res, error, 'planning-center GET batch plan');
    }
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
    try {
      const result = await withTimeout(deps.previewLinkCorrections({
        churchId: req.user.church_id,
        provider: PROVIDER,
        batchId,
        baseReviewToken,
        linkCorrections: req.body.linkCorrections,
      }), deps.routeTimeoutMs);
      return res.json({ success: true, ...result });
    } catch (error) {
      return respondWithError(res, error, 'planning-center POST link correction preview');
    }
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
    try {
      const result = await withTimeout(deps.previewHouseholdChoices({
        churchId: req.user.church_id, provider: PROVIDER, batchId,
        baseReviewToken, householdChoices: req.body.householdChoices,
      }), deps.routeTimeoutMs);
      return res.json({ success: true, ...result });
    } catch (error) {
      return respondWithError(res, error, 'planning-center POST household choice preview');
    }
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
    try {
      const result = await withTimeout(deps.applyReviewed({
        churchId: req.user.church_id,
        provider: PROVIDER,
        batchId,
        ...(integrationScope ? { operationKind: 'people_sync' } : {}),
        reviewToken,
        selections: req.body?.selections || {},
        userId: req.user.id,
      }), deps.routeTimeoutMs);
      return res.json({ success: true, ...result });
    } catch (error) {
      return respondWithError(res, error, 'planning-center POST batch apply');
    }
  });

  return router;
}

module.exports = { createPlanningCenterPeopleSyncRouter, defaultDeps };
