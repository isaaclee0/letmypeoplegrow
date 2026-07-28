'use strict';

const https = require('https');

// Elvanto's REST API (https://api.elvanto.com/v1) — a brand-new, injectable
// HTTP client for the provider-neutral Elvanto sync feature (Tasks 12-14).
// This is deliberately separate from the legacy one-shot Elvanto import in
// server/routes/integrations.js; it exists so the normalizer/metadata/adapter
// tasks have a fully-tested, dependency-injected transport instead of yet
// another bespoke https.request() call.
//
// Auth: Elvanto uses HTTP Basic auth with the API key as the username and a
// literal 'x' as the password. Confirmed against the existing one-shot
// import's createElvantoAuthHeader() in server/routes/integrations.js
// (`Buffer.from(`${apiKey}:x`).toString('base64')`) — this client's header
// construction matches that convention exactly, and also matches the Task 11
// spec's own test example.
//
// Wire-format assumptions NOT independently confirmed against Elvanto's own
// API docs (documented here rather than blocking Task 11 on them, per the
// task brief — the spec's test example is authoritative for these shapes):
//   - Response envelope is `{ status: 'ok' | 'error', error?: { message } }`,
//     with the resource nested under a key named for the collection (e.g.
//     "people"), itself holding `{ page, per_page, total, <itemKey>: [...] }`.
//   - A collection containing exactly one item may arrive as a bare object
//     instead of a one-element array — Elvanto is known to do this — so
//     getAll() normalizes it back into a one-element array.
//   - Request pagination params are named `page` / `page_size` (matching the
//     existing legacy import's query params, e.g. `?page=1&page_size=100`);
//     the response mirrors `page` but reports size as `per_page` and a
//     cumulative `total`, per the spec's test example.
//
// Return shape: getAll() resolves to a plain object
// `{ items, complete: true, pages, total }` — matching the surrounding prose
// in the Task 11 spec, and the same shape PCO's pcoAdapter.js fetchSnapshot()
// already returns (`complete` as an ordinary enumerable property). An earlier
// revision of this file returned the bare `items` array with `complete`/
// `pages`/`total` attached as non-enumerable properties, to also literally
// satisfy the spec's illustrative `assert.deepEqual(result, [{ id: 'p1' }])`
// test line. That was reviewed and rejected: anything that does
// `result.map()`/`.filter()`/`.slice()`/`[...result]`/`Array.from(result)`/
// `structuredClone(result)`/`JSON.stringify(result)` silently drops
// `complete`/`pages`/`total`, and Task 14's fetchFullSnapshot needs `complete`
// to gate archive-on-missing logic — too dangerous a footgun to keep. Callers
// read `result.items` for the array and `result.complete`/`.pages`/`.total`
// for pagination metadata.

const DEFAULT_BASE_URL = 'https://api.elvanto.com/v1';
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGES = 1000;

const ELVANTO_AUTH = 'ELVANTO_AUTH';
const ELVANTO_UNAVAILABLE = 'ELVANTO_UNAVAILABLE';
const ELVANTO_RESPONSE = 'ELVANTO_RESPONSE';
const ELVANTO_PAGINATION = 'ELVANTO_PAGINATION';

/**
 * Error raised by the Elvanto client. `.message` and `.details` are
 * guaranteed never to contain the API key, the Authorization header value,
 * or a full person/record payload — only safe scalar metadata (path, HTTP
 * status, page numbers, etc). See redact() below for enforcement.
 */
class ElvantoError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ElvantoError';
    this.code = code;
    this.details = details;
  }
}

function serializeQueryParams(params) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null) {
        searchParams.append(key, String(item));
      }
    }
  }

  return searchParams.toString();
}

// Default production transport, used when no `request` override is supplied.
// Kept minimal and consistent with the existing https.request() helpers already
// used elsewhere in this codebase (server/routes/integrations.js
// `makeHttpsRequest`, planningCenterSync.js).
function defaultRequest({ path, params, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(DEFAULT_BASE_URL + path);
    const query = serializeQueryParams(params);
    if (query) url.search = query;

    const payload = body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = Object.assign({ Accept: 'application/json' }, headers);
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (_e) {
            parsed = data;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('Elvanto request timed out'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Build an injectable Elvanto API client.
 *
 * @param {object} options
 * @param {string} options.apiKey - Elvanto API key (Basic auth username).
 * @param {Function} [options.request] - `({ path, params, method, headers, body, timeoutMs }) => Promise<{ status, data }>`.
 *   Defaults to a real HTTPS call against api.elvanto.com; tests inject a fake.
 * @param {number} [options.timeoutMs] - Timeout passed through to `request` (default 30000).
 */
function createElvantoClient({ apiKey, request = defaultRequest, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    throw new ElvantoError('An Elvanto API key is required.', ELVANTO_AUTH, {});
  }

  // Never included in any ElvantoError's .message or .details.
  const authValue = Buffer.from(`${apiKey}:x`).toString('base64');
  const authHeader = `Basic ${authValue}`;

  // Defense in depth: even though we never deliberately embed the API key or
  // the Authorization header in an error, an underlying transport error or an
  // Elvanto-supplied error message could in principle echo either back
  // (e.g. a proxy's "auth header was <value>" diagnostic). Strip the raw key,
  // the full "Basic <base64>" header, and a bare base64 blob lacking the
  // "Basic " prefix, before any external string is folded into an ElvantoError.
  function redact(text) {
    if (typeof text !== 'string' || !text) return 'Elvanto request error';
    return text
      .split(apiKey).join('[REDACTED]')
      .split(authHeader).join('[REDACTED]')
      .split(authValue).join('[REDACTED]')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
  }

  async function performRequest(method, path, { params, body } = {}) {
    const headers = { Authorization: authHeader, Accept: 'application/json' };

    let response;
    try {
      response = await request({ path, params, method, body, headers, timeoutMs });
    } catch (err) {
      const reason = err && typeof err.message === 'string' ? err.message : 'unknown error';
      throw new ElvantoError(
        `Elvanto request to ${path} failed: ${redact(reason)}`,
        ELVANTO_UNAVAILABLE,
        { path, method }
      );
    }

    const status = response && response.status;
    const data = response && response.data;

    if (status === 401 || status === 403) {
      throw new ElvantoError(
        `Elvanto rejected the request credentials for ${path} (status ${status}).`,
        ELVANTO_AUTH,
        { path, status }
      );
    }

    if (typeof status !== 'number' || status < 200 || status >= 300) {
      throw new ElvantoError(
        `Elvanto returned an unexpected status ${status} for ${path}.`,
        ELVANTO_UNAVAILABLE,
        { path, status }
      );
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ElvantoError(
        `Elvanto returned a malformed response body for ${path}.`,
        ELVANTO_RESPONSE,
        { path, status }
      );
    }

    if (data.status && data.status !== 'ok') {
      const reason = data.error && typeof data.error.message === 'string'
        ? redact(data.error.message)
        : 'Elvanto reported an error status.';
      throw new ElvantoError(reason, ELVANTO_RESPONSE, { path, status, elvantoStatus: data.status });
    }

    return data;
  }

  function get(path, params) {
    return performRequest('GET', path, { params });
  }

  function post(path, body) {
    return performRequest('POST', path, { body });
  }

  async function getAll(path, params = {}, collectionKey, itemKey) {
    if (!collectionKey || !itemKey) {
      throw new ElvantoError('getAll requires both collectionKey and itemKey.', ELVANTO_PAGINATION, { path });
    }

    const pageSize = params.page_size === undefined ? MAX_PAGE_SIZE : params.page_size;
    if (!Number.isInteger(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
      throw new ElvantoError(
        `Elvanto page_size must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}.`,
        ELVANTO_PAGINATION,
        { path, pageSize }
      );
    }

    const items = [];
    let page = 1;
    let total = null;

    for (;;) {
      if (page > MAX_PAGES) {
        throw new ElvantoError(
          `Elvanto pagination for ${path} did not complete within ${MAX_PAGES} pages.`,
          ELVANTO_PAGINATION,
          { path, pages: page - 1, total, fetched: items.length }
        );
      }

      // performRequest() already classifies transport failures and bad
      // status/body responses (ELVANTO_UNAVAILABLE/ELVANTO_AUTH/ELVANTO_RESPONSE)
      // and rejects — we deliberately do not catch here, so a failure on any
      // page after the first propagates and this function never resolves
      // with the partial `items` accumulated so far.
      const data = await performRequest('GET', path, { params: Object.assign({}, params, { page, page_size: pageSize }) });
      const collection = data[collectionKey];

      if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
        throw new ElvantoError(
          `Elvanto response for ${path} is missing the "${collectionKey}" collection.`,
          ELVANTO_RESPONSE,
          { path, collectionKey, page }
        );
      }

      if (typeof collection.total === 'number') {
        total = collection.total;
      }

      const rawItems = collection[itemKey];
      const normalized = rawItems === undefined || rawItems === null
        ? []
        : Array.isArray(rawItems) ? rawItems : [rawItems];

      items.push(...normalized);

      const done = total !== null ? items.length >= total : normalized.length === 0;
      if (done) {
        return {
          items,
          complete: true,
          pages: page,
          total: total === null ? items.length : total,
        };
      }

      page += 1;
    }
  }

  return { get, post, getAll };
}

module.exports = {
  createElvantoClient,
  serializeQueryParams,
  ElvantoError,
  ELVANTO_AUTH,
  ELVANTO_UNAVAILABLE,
  ELVANTO_RESPONSE,
  ELVANTO_PAGINATION,
};
