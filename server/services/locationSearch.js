'use strict';

const defaultLogger = require('../config/logger');

const OPEN_METEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const GEOAPIFY_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinate(lat, lng) {
  return lat !== null && lng !== null
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180;
}

function createDisplayName(name, admin1, country) {
  return [name, admin1, country].filter(Boolean).join(', ');
}

function normalizeOpenMeteo(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body.results !== undefined && !Array.isArray(body.results))) {
    throw new Error('Open-Meteo returned an invalid response');
  }

  return (body.results || []).flatMap((item) => {
    const lat = toFiniteNumber(item.latitude);
    const lng = toFiniteNumber(item.longitude);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || !validCoordinate(lat, lng)) return [];

    const admin1 = item.admin1 || null;
    const country = item.country || null;
    return [{
      name,
      admin1,
      country,
      countryCode: item.country_code?.toUpperCase() || null,
      lat,
      lng,
      timezone: item.timezone || null,
      population: Number.isFinite(item.population) ? item.population : null,
      source: 'open-meteo',
      displayName: createDisplayName(name, admin1, country),
    }];
  });
}

function normalizeGeoapify(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
    throw new Error('Geoapify returned an invalid response');
  }

  return body.results.flatMap((item) => {
    const lat = toFiniteNumber(item.lat);
    const lng = toFiniteNumber(item.lon);
    const rawName = item.name || item.city || item.suburb || item.formatted;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || !validCoordinate(lat, lng)) return [];

    const admin1 = item.state || item.county || null;
    const country = item.country || null;
    return [{
      name,
      admin1,
      country,
      countryCode: item.country_code?.toUpperCase() || null,
      lat,
      lng,
      timezone: null,
      population: null,
      source: 'geoapify',
      displayName: createDisplayName(name, admin1, country),
    }];
  });
}

async function requestJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Location provider request timed out'));
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`Location provider returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function openMeteoUrl(query) {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set('name', query);
  url.searchParams.set('count', '8');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  return url;
}

function geoapifyUrl(query, apiKey) {
  const url = new URL(GEOAPIFY_URL);
  url.searchParams.set('text', query);
  url.searchParams.set('type', 'city');
  url.searchParams.set('limit', '8');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);
  return url;
}

function normalizedSearchQuery(query) {
  return typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
}

function cacheKey(query) {
  return query.toLocaleLowerCase('en');
}

function failureMetadata(error) {
  const code = error?.code || error?.cause?.code || null;
  return {
    category: error?.status ? 'http' : error?.name === 'AbortError' || /timed out/i.test(error?.message) ? 'timeout' : 'network',
    status: error?.status || null,
    code,
  };
}

function createLocationSearchService({
  fetchImpl = globalThis.fetch,
  getGeoapifyApiKey = () => process.env.GEOAPIFY_API_KEY,
  logger = defaultLogger,
  now = Date.now,
  primaryTimeoutMs = 3_000,
  fallbackTimeoutMs = 3_000,
  cooldownMs = 300_000,
  cacheTtlMs = 600_000,
  cacheMaxEntries = 250,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let primaryUnavailableUntil = 0;

  function logFailure(provider, error, startedAt, fallbackAttempted) {
    logger.warn('Location search provider failed', {
      provider,
      elapsedMs: Math.max(0, now() - startedAt),
      ...failureMetadata(error),
      fallbackAttempted,
    });
  }

  async function performSearch(query) {
    if (now() >= primaryUnavailableUntil) {
      const startedAt = now();
      try {
        const body = await requestJson(fetchImpl, openMeteoUrl(query), primaryTimeoutMs);
        const results = normalizeOpenMeteo(body);
        primaryUnavailableUntil = 0;
        return results;
      } catch (error) {
        primaryUnavailableUntil = now() + cooldownMs;
        logFailure('open-meteo', error, startedAt, true);
      }
    }

    const apiKey = getGeoapifyApiKey()?.trim();
    if (!apiKey) throw new Error('Geoapify fallback is not configured');

    const startedAt = now();
    try {
      const body = await requestJson(fetchImpl, geoapifyUrl(query, apiKey), fallbackTimeoutMs);
      return normalizeGeoapify(body);
    } catch (error) {
      logFailure('geoapify', error, startedAt, false);
      throw new Error('Location search providers are unavailable');
    }
  }

  async function search(query) {
    const normalizedQuery = normalizedSearchQuery(query);
    if (!normalizedQuery) return [];

    const key = cacheKey(normalizedQuery);
    const cached = cache.get(key);
    if (cached) {
      if (cached.expiresAt > now()) return cached.results;
      cache.delete(key);
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const operation = performSearch(normalizedQuery).then((results) => {
      if (cacheTtlMs > 0 && cacheMaxEntries > 0) {
        if (!cache.has(key) && cache.size >= cacheMaxEntries) {
          cache.delete(cache.keys().next().value);
        }
        cache.set(key, { results, expiresAt: now() + cacheTtlMs });
      }
      return results;
    });
    inFlight.set(key, operation);

    try {
      return await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  }

  return { search };
}

const defaultService = createLocationSearchService();

module.exports = {
  createLocationSearchService,
  search: (query) => defaultService.search(query),
};
