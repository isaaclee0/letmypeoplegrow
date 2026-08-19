'use strict';

const express = require('express');
const {
  PastoralInsightError,
  getPastoralInsights,
  applyPastoralInsightAction,
} = require('../../services/engagement/pastoral');

const router = express.Router();
const ACTION_KEYS = new Set(['action', 'snoozeUntil']);

function pastoralError(res, error, operation = 'update') {
  if (error instanceof PastoralInsightError || error?.code?.startsWith('PASTORAL_')
      || error?.code === 'INVALID_PASTORAL_ACTION') {
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  console.error('Pastoral report error:', error);
  return res.status(500).json({ error: `Failed to ${operation} the pastoral-care report.` });
}

function invalidBody(body) {
  return !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !ACTION_KEYS.has(key));
}

router.get('/', async (req, res) => {
  if (Object.keys(req.query).some((key) => key !== 'includeSnoozed')
      || (req.query.includeSnoozed !== undefined && req.query.includeSnoozed !== 'true')) {
    return res.status(400).json({
      error: 'Only includeSnoozed=true is supported.',
      code: 'INVALID_PASTORAL_QUERY',
    });
  }
  try {
    return res.json(await getPastoralInsights(req.user.church_id, {
      includeSnoozed: req.query.includeSnoozed === 'true',
    }));
  } catch (error) {
    return pastoralError(res, error, 'load');
  }
});

router.patch('/:insightId', async (req, res) => {
  if (invalidBody(req.body)) {
    return res.status(400).json({
      error: 'The request may contain only action and snoozeUntil.',
      code: 'INVALID_PASTORAL_ACTION',
    });
  }
  try {
    const insight = await applyPastoralInsightAction(
      req.user.church_id,
      req.user.id,
      req.params.insightId,
      req.body,
    );
    return res.json({ insight });
  } catch (error) {
    return pastoralError(res, error);
  }
});

module.exports = router;
