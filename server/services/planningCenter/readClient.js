'use strict';

const https = require('https');

const MAX_RETRIES = 3;
const MAX_PAGES = 1000;
const PCO_API_ORIGIN = 'https://api.planningcenteronline.com';

class PcoSourceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PcoSourceError';
    this.code = code;
    this.details = details;
  }
}

function normalizedHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    result[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function defaultRequest({ url, method, headers }) {
  if (method !== 'GET') return Promise.reject(new Error('Planning Center source transport only accepts GET'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch (_) { data = body; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function withPerPage(url) {
  const parsed = new URL(url, PCO_API_ORIGIN);
  if (!parsed.searchParams.has('per_page')) parsed.searchParams.set('per_page', '100');
  return parsed.toString();
}

function retryAfterMilliseconds(value) {
  if (typeof value !== 'string' || !value.trim()) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1000 : Math.max(0, date - Date.now());
}

function isEnvelope(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'data') &&
    (Array.isArray(data.data) || (data.data && typeof data.data === 'object'));
}

function createPcoReadClient({ accessToken, request = defaultRequest, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), maxRetries = MAX_RETRIES, connectionValidated = false } = {}) {
  const token = typeof accessToken === 'string' ? accessToken : '';
  const authHeader = `Bearer ${token}`;
  const boundedRetries = Math.max(0, Math.min(MAX_RETRIES, Number.isInteger(maxRetries) ? maxRetries : MAX_RETRIES));

  function redact(value) {
    if (typeof value !== 'string') return 'Planning Center source request failed';
    return value
      .split(token).join('[REDACTED]')
      .split(authHeader).join('[REDACTED]')
      .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  }

  async function waitForDynamicQuota(headers) {
    const limit = Number(headers['x-pco-api-request-rate-limit']);
    const period = Number(headers['x-pco-api-request-rate-period']);
    const count = Number(headers['x-pco-api-request-rate-count']);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(period) && period >= 0 && Number.isFinite(count) && count >= limit - 1) {
      await sleep(Math.round(period * 1000));
    }
  }

  async function getJson(url) {
    const safeUrl = String(url);
    for (let retry = 0; ; retry += 1) {
      let response;
      try {
        response = await request({ url: safeUrl, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
      } catch (err) {
        throw new PcoSourceError(`Planning Center source request failed: ${redact(err && err.message)}`, 'SYNC_SOURCE_UNAVAILABLE', {});
      }

      const status = response && response.status;
      const headers = normalizedHeaders(response && response.headers);
      if (status === 429) {
        if (retry >= boundedRetries) {
          throw new PcoSourceError('Planning Center source rate limit retry budget exhausted', 'SYNC_SOURCE_RATE_LIMIT', { status });
        }
        await sleep(retryAfterMilliseconds(headers['retry-after']));
        continue;
      }
      if (status === 401 || (status === 403 && !connectionValidated)) {
        throw new PcoSourceError(`Planning Center source credentials were rejected (status ${status})`, 'SYNC_SOURCE_AUTH', { status });
      }
      if (status === 404 || (status === 403 && connectionValidated)) {
        throw new PcoSourceError(`Planning Center source is unavailable (status ${status})`, 'SYNC_SOURCE_UNAVAILABLE', { status });
      }
      if (typeof status !== 'number' || status < 200 || status >= 300) {
        throw new PcoSourceError(`Planning Center source request returned status ${status}`, 'SYNC_SOURCE_UNAVAILABLE', { status });
      }
      if (!isEnvelope(response && response.data)) {
        throw new PcoSourceError('Planning Center source returned a malformed response envelope', 'SYNC_SOURCE_INCOMPLETE', { status });
      }
      await waitForDynamicQuota(headers);
      return response.data;
    }
  }

  async function getAll(url, onPage) {
    let next = withPerPage(url);
    const seen = new Set();
    const items = [];
    let pages = 0;
    while (next) {
      if (pages >= MAX_PAGES || seen.has(next)) {
        throw new PcoSourceError('Planning Center source pagination did not complete safely', 'SYNC_SOURCE_INCOMPLETE', { pages });
      }
      seen.add(next);
      const envelope = await getJson(next);
      if (!Array.isArray(envelope.data)) {
        throw new PcoSourceError('Planning Center source collection response is malformed', 'SYNC_SOURCE_INCOMPLETE', { pages });
      }
      pages += 1;
      if (onPage) await onPage(envelope, pages);
      else items.push(...envelope.data);
      const candidate = envelope.links && envelope.links.next;
      if (candidate !== null && candidate !== undefined && typeof candidate !== 'string') {
        throw new PcoSourceError('Planning Center source pagination link is malformed', 'SYNC_SOURCE_INCOMPLETE', { pages });
      }
      next = candidate || null;
    }
    return { items, pages, complete: true };
  }

  return Object.freeze({ getJson, getAll });
}

module.exports = { createPcoReadClient, PcoSourceError };
