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

async function requestJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'LetMyPeopleGrow/1.0' },
  });
  if (!response.ok) throw new Error(`Location provider returned HTTP ${response.status}`);
  return response.json();
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

function createLocationSearchService({
  fetchImpl = globalThis.fetch,
  getGeoapifyApiKey = () => process.env.GEOAPIFY_API_KEY,
  logger = defaultLogger,
} = {}) {
  async function search(query) {
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    if (!normalizedQuery) return [];

    try {
      const body = await requestJson(fetchImpl, openMeteoUrl(normalizedQuery));
      return normalizeOpenMeteo(body);
    } catch (error) {
      logger.warn('Location search provider failed', {
        provider: 'open-meteo',
        error: error.message,
        fallbackAttempted: true,
      });
    }

    const apiKey = getGeoapifyApiKey()?.trim();
    if (!apiKey) throw new Error('Geoapify fallback is not configured');

    try {
      const body = await requestJson(fetchImpl, geoapifyUrl(normalizedQuery, apiKey));
      return normalizeGeoapify(body);
    } catch (error) {
      logger.warn('Location search provider failed', {
        provider: 'geoapify',
        error: error.message,
        fallbackAttempted: false,
      });
      throw new Error('Location search providers are unavailable');
    }
  }

  return { search };
}

const defaultService = createLocationSearchService();

module.exports = {
  createLocationSearchService,
  search: (query) => defaultService.search(query),
};
