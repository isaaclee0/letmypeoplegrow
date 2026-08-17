'use strict';

const express = require('express');
const {
  buildEngagementOverview,
  listEngagementPeople,
  listEngagementSessions,
} = require('../../services/engagement/overview');
const { DrilldownTokenError } = require('../../services/engagement/drilldownTokens');

const router = express.Router();

function unsupportedQuery(res) {
  return res.status(400).json({
    error: 'Long-term engagement reports use a fixed completed-week window and do not accept date filters.',
    code: 'ENGAGEMENT_DATE_FILTER_UNSUPPORTED',
  });
}

function hasUnknownQuery(query, allowed) {
  return Object.keys(query).some((key) => !allowed.has(key));
}

function reportError(res, error) {
  if (error instanceof DrilldownTokenError || error?.code === 'INVALID_DRILLDOWN_TOKEN') {
    return res.status(400).json({ error: error.message, code: 'INVALID_DRILLDOWN_TOKEN' });
  }
  if (error?.code === 'INVALID_ENGAGEMENT_LIMIT') {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  console.error('Engagement report error:', error);
  return res.status(500).json({ error: 'Failed to load the engagement report.' });
}

router.get('/overview', async (req, res) => {
  if (Object.keys(req.query).length > 0) return unsupportedQuery(res);
  try {
    return res.json(await buildEngagementOverview(req.user.church_id));
  } catch (error) {
    return reportError(res, error);
  }
});

router.get('/people', async (req, res) => {
  if (hasUnknownQuery(req.query, new Set(['segment', 'cursor', 'limit']))) {
    return unsupportedQuery(res);
  }
  try {
    return res.json(await listEngagementPeople(req.user.church_id, {
      segment: req.query.segment,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }));
  } catch (error) {
    return reportError(res, error);
  }
});

router.get('/sessions', async (req, res) => {
  if (hasUnknownQuery(req.query, new Set(['series', 'cursor', 'limit']))) {
    return unsupportedQuery(res);
  }
  try {
    return res.json(await listEngagementSessions(req.user.church_id, {
      series: req.query.series,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }));
  } catch (error) {
    return reportError(res, error);
  }
});

module.exports = router;
