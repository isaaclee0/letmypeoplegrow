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
  applyReviewed: orchestrator.applyReviewed,
};

function parseBatchId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function respondWithError(res, error, label) {
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

  router.get('/sync-batches/:id/plan', async (req, res) => {
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
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

  router.post('/sync-batches/:id/apply', async (req, res) => {
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
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
