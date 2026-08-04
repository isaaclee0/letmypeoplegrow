'use strict';

const express = require('express');
const logger = require('../config/logger');
const { verifyToken, requireRole } = require('../middleware/auth');
const { ensureChurchIsolation } = require('../middleware/churchIsolation');
const connectionStore = require('../services/peopleSync/connectionStore');
const providerRegistry = require('../services/peopleSync/providerRegistry');
const peopleImport = require('../services/peopleImport/orchestrator');
const { withTimeout } = require('./integrations/routeTimeout');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const SOURCE_KINDS = Object.freeze({
  planning_center: new Set(['planning_center_list']),
  elvanto: new Set(['elvanto_category', 'elvanto_group']),
});
const ALL_OPTION = Object.freeze({ kind: 'all', name: 'Everyone' });
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_IMPORT_ROUTE_TIMEOUT_MS = 120000;
const REQUEST_BOUNDARY_PASSED = Symbol('peopleImportsRequestBoundaryPassed');

const SAFE_ERRORS = Object.freeze({
  SYNC_SOURCE_AUTH: [401, 'The provider rejected the stored connection credentials. Reconnect it to continue.'],
  SYNC_SOURCE_RATE_LIMIT: [429, 'The provider rate-limited this request. Please try again later.'],
  SYNC_SOURCE_UNAVAILABLE: [409, 'The selected provider source is no longer available.'],
  SYNC_SOURCE_INCOMPLETE: [502, 'The provider did not return a complete people list.'],
  SYNC_NOT_CONNECTED: [400, 'No connection is configured for this provider.'],
  SYNC_CONNECTION_INVALID: [400, 'The provider connection is invalid. Reconnect it to continue.'],
  SYNC_REVIEW_INVALID: [400, 'This review token is invalid.'],
  SYNC_REVIEW_EXPIRED: [409, 'This review has expired; fetch a fresh review before applying.'],
  SYNC_REVIEW_ALREADY_APPLIED: [409, 'This review has already been applied. Refresh before applying another import.'],
  SYNC_PLAN_STALE: [409, 'The reviewed plan is out of date; fetch a fresh review before applying.'],
  SYNC_SELECTIONS_INVALID: [400, 'The submitted import selections are invalid.'],
  SYNC_ROUTE_TIMEOUT: [503, 'The people import took too long to complete. Please try again.'],
  ELVANTO_UNAVAILABLE: [503, 'Elvanto is currently unavailable. Please try again shortly.'],
  ELVANTO_RESPONSE: [502, 'Elvanto returned an unexpected response. Please try again shortly.'],
  ELVANTO_PAGINATION: [502, 'Elvanto returned an unexpected response. Please try again shortly.'],
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeSource(source) {
  return {
    kind: source?.kind,
    externalId: source?.externalId,
    name: source?.name,
    memberCount: source?.memberCount ?? null,
    providerRefreshedAt: source?.providerRefreshedAt ?? null,
  };
}

function normalizeSelection(provider, selection) {
  if (!isPlainObject(selection)) return null;
  const keys = Object.keys(selection).sort();
  if (keys.length === 1 && keys[0] === 'kind' && selection.kind === 'all') {
    return { kind: 'all' };
  }
  if (keys.join(',') !== 'externalId,kind' || !SOURCE_KINDS[provider]?.has(selection.kind) ||
      typeof selection.externalId !== 'string' || !selection.externalId.trim()) {
    return null;
  }
  return { kind: selection.kind, externalId: selection.externalId.trim() };
}

function exactBodyKeys(body, wanted) {
  return isPlainObject(body) && Object.keys(body).sort().join(',') === [...wanted].sort().join(',');
}

function createPeopleImportsJsonParser() {
  const parser = express.json({ limit: MAX_BODY_BYTES, strict: true });
  return (req, res, next) => parser(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
      });
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
      });
    }
    return error ? next(error) : next();
  });
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function defaultListSources({ churchId, provider, signal }) {
  const connection = await connectionStore.getConnection(churchId, provider);
  if (!connection) throw routeError('SYNC_NOT_CONNECTED', 'Provider connection missing');
  if (connection.connectionStatus === 'invalid') {
    throw routeError('SYNC_CONNECTION_INVALID', 'Provider connection invalid');
  }
  const credentials = await connectionStore.getCredentials(churchId, provider);
  if (!credentials) throw routeError('SYNC_NOT_CONNECTED', 'Provider credentials missing');
  return providerRegistry.getProvider(provider).listSources({ churchId, credentials, signal });
}

const defaultDeps = {
  verifyToken,
  ensureChurchIsolation,
  requireAdmin: requireRole(['admin']),
  listSources: defaultListSources,
  previewImport: peopleImport.previewImport,
  applyImport: peopleImport.applyImport,
  routeTimeoutMs: DEFAULT_IMPORT_ROUTE_TIMEOUT_MS,
  withTimeout,
};

function installRequestBoundary(router, deps) {
  const unlessAlreadyPassed = (middleware) => (req, res, next) => (
    req[REQUEST_BOUNDARY_PASSED] ? next() : middleware(req, res, next)
  );
  router.use(unlessAlreadyPassed(deps.verifyToken));
  router.use(unlessAlreadyPassed(deps.ensureChurchIsolation));
  router.use(unlessAlreadyPassed(deps.requireAdmin));

  const parseJson = createPeopleImportsJsonParser();
  router.use((req, res, next) => {
    if (req[REQUEST_BOUNDARY_PASSED]) return next();
    return parseJson(req, res, (error) => {
      if (error) return next(error);
      req[REQUEST_BOUNDARY_PASSED] = true;
      return next();
    });
  });
}

function createPeopleImportsRequestBoundary(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const boundary = express.Router();
  installRequestBoundary(boundary, deps);
  return boundary;
}

async function runWithDeadline(req, res, deps, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  try {
    return await deps.withTimeout(
      Promise.resolve().then(() => operation(controller.signal)),
      deps.routeTimeoutMs
    );
  } catch (error) {
    if (error?.code === 'SYNC_ROUTE_TIMEOUT') abort();
    throw error;
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', abortOnClose);
  }
}

function respondWithError(res, error, label) {
  const safe = SAFE_ERRORS[error?.code];
  if (safe) return res.status(safe[0]).json({ error: safe[1], code: error.code });
  logger.error(`${label} failed`, {
    errorName: typeof error?.name === 'string' ? error.name : 'UnknownError',
    errorCode: typeof error?.code === 'string' ? error.code : null,
  });
  return res.status(500).json({ error: 'Unable to complete the people import.' });
}

function invalidRequest(res) {
  return res.status(400).json({
    error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
  });
}

function createPeopleImportsRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // In production this boundary first runs ahead of the global JSON parser
  // so unauthenticated requests cannot terminate at body parsing. The same
  // boundary remains installed here for standalone/test mounting; an
  // unforgeable request-local marker prevents duplicate auth execution.
  installRequestBoundary(router, deps);

  router.param('provider', (req, res, next, provider) => {
    if (!PROVIDERS.has(provider)) {
      return res.status(404).json({ error: 'People import provider not found.' });
    }
    return next();
  });

  router.get('/:provider/sources', async (req, res) => {
    try {
      const sources = await runWithDeadline(req, res, deps, (signal) => deps.listSources({
        churchId: req.user.church_id,
        provider: req.params.provider,
        signal,
      }));
      return res.json({
        success: true,
        sources: (Array.isArray(sources) ? sources : []).map(safeSource),
        allOption: ALL_OPTION,
      });
    } catch (error) {
      if (req.aborted || res.destroyed) return undefined;
      return respondWithError(res, error, 'people imports GET /sources');
    }
  });

  router.post('/:provider/preview', async (req, res) => {
    if (!exactBodyKeys(req.body, ['selection'])) return invalidRequest(res);
    const selection = normalizeSelection(req.params.provider, req.body.selection);
    if (!selection) return invalidRequest(res);
    try {
      const review = await runWithDeadline(req, res, deps, (signal) => deps.previewImport({
        churchId: req.user.church_id,
        provider: req.params.provider,
        selection,
        signal,
      }));
      return res.json(review);
    } catch (error) {
      if (req.aborted || res.destroyed) return undefined;
      return respondWithError(res, error, 'people imports POST /preview');
    }
  });

  router.post('/:provider/apply', async (req, res) => {
    if (!exactBodyKeys(req.body, ['selection', 'reviewToken', 'selections'])) {
      return invalidRequest(res);
    }
    const selection = normalizeSelection(req.params.provider, req.body.selection);
    if (!selection || typeof req.body.reviewToken !== 'string' || !req.body.reviewToken.trim() ||
        !isPlainObject(req.body.selections)) {
      return invalidRequest(res);
    }
    try {
      const result = await runWithDeadline(req, res, deps, (signal) => deps.applyImport({
        churchId: req.user.church_id,
        provider: req.params.provider,
        selection,
        reviewToken: req.body.reviewToken,
        selections: req.body.selections,
        userId: req.user.id,
        signal,
      }));
      return res.json(result);
    } catch (error) {
      if (req.aborted || res.destroyed) return undefined;
      return respondWithError(res, error, 'people imports POST /apply');
    }
  });

  return router;
}

const productionRouter = createPeopleImportsRouter();

module.exports = productionRouter;
module.exports.createPeopleImportsRouter = createPeopleImportsRouter;
module.exports.createPeopleImportsJsonParser = createPeopleImportsJsonParser;
module.exports.createPeopleImportsRequestBoundary = createPeopleImportsRequestBoundary;
module.exports.defaultDeps = defaultDeps;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.DEFAULT_IMPORT_ROUTE_TIMEOUT_MS = DEFAULT_IMPORT_ROUTE_TIMEOUT_MS;
