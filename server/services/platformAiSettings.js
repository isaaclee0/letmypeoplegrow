const Database = require('../config/database');

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  xai: 'grok-4-fast',
};

const SETTING_KEYS = {
  anthropic: 'platform_ai_model_anthropic',
  xai: 'platform_ai_model_xai',
};

function keyFor(provider) {
  const key = SETTING_KEYS[provider];
  if (!key) throw new Error(`Unknown provider: ${provider}`);
  return key;
}

/**
 * Returns the admin-configured model override for a provider, or null if
 * none is set (meaning: the caller should use its own hardcoded default).
 */
async function getModel(provider) {
  const rows = await Database.registryQuery(
    'SELECT setting_value FROM platform_settings WHERE setting_key = ?',
    [keyFor(provider)]
  );
  return rows[0]?.setting_value || null;
}

/**
 * Sets (or clears, when modelId is null) the model override for a provider.
 */
async function setModel(provider, modelId) {
  const key = keyFor(provider);
  if (modelId === null) {
    await Database.registryQuery('DELETE FROM platform_settings WHERE setting_key = ?', [key]);
    return;
  }
  await Database.registryQuery(
    `INSERT OR REPLACE INTO platform_settings (setting_key, setting_value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, modelId]
  );
}

module.exports = { getModel, setModel, DEFAULT_MODELS };
