const https = require('https');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // provider -> { models, fetchedAt }

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Model list request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * xAI's catalog includes non-chat models (image generation, embeddings) that
 * aren't valid choices for the weekly review / guidance distiller tasks. Pure.
 */
function isChatModel(id) {
  return !/image|embed/i.test(id);
}

/** Pure. */
function mapAnthropicModel(raw) {
  return { id: raw.id, displayName: raw.display_name || raw.id };
}

/** Pure. */
function mapXaiModel(raw) {
  return { id: raw.id, displayName: raw.id };
}

async function fetchAnthropicModels(apiKey) {
  const models = [];
  let afterId = null;
  do {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (afterId) url.searchParams.set('after_id', afterId);
    const { status, data } = await httpsGetJson(url.toString(), {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    if (status !== 200) {
      throw new Error(data?.error?.message || `Anthropic models request failed (${status})`);
    }
    for (const m of data.data || []) {
      models.push(mapAnthropicModel(m));
    }
    afterId = data.has_more ? data.last_id : null;
  } while (afterId);
  return models;
}

async function fetchXaiModels(apiKey) {
  const { status, data } = await httpsGetJson('https://api.x.ai/v1/models', {
    'Authorization': `Bearer ${apiKey}`,
  });
  if (status !== 200) {
    throw new Error(data?.error?.message || `xAI models request failed (${status})`);
  }
  return (data.data || [])
    .filter(m => isChatModel(m.id))
    .map(mapXaiModel);
}

const FETCHERS = { anthropic: fetchAnthropicModels, xai: fetchXaiModels };

/**
 * Live-fetches (with a 5-minute cache) the list of models available to the
 * given API key for a provider.
 */
async function listModels(provider, apiKey) {
  const cached = cache.get(provider);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.models;
  }
  const fetcher = FETCHERS[provider];
  if (!fetcher) throw new Error(`Unknown provider: ${provider}`);
  const models = await fetcher(apiKey);
  cache.set(provider, { models, fetchedAt: Date.now() });
  return models;
}

module.exports = { listModels, isChatModel, mapAnthropicModel, mapXaiModel };
