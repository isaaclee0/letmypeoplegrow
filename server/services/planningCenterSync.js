const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../utils/logger');

let cronJob = null;

// ─── HTTP helper ────────────────────────────────────────────────────────────

function httpsGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = new URLSearchParams(body).toString();
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Token helpers ───────────────────────────────────────────────────────────

async function getTokensForChurch(churchId) {
  // Find any user in this church who has PCO tokens stored
  const rows = await Database.query(
    `SELECT up.user_id, up.preference_value
     FROM user_preferences up
     WHERE up.church_id = ? AND up.preference_key = 'planning_center_tokens'
     LIMIT 1`,
    [churchId]
  );
  if (!rows.length) return null;
  const pref = rows[0].preference_value;
  return {
    userId: rows[0].user_id,
    tokens: typeof pref === 'string' ? JSON.parse(pref) : pref,
  };
}

async function refreshToken(refreshTokenValue) {
  const response = await httpsPost('https://api.planningcenteronline.com/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: process.env.PLANNING_CENTER_CLIENT_ID,
    client_secret: process.env.PLANNING_CENTER_CLIENT_SECRET,
  });
  return response.status === 200 ? response.data : null;
}

async function getValidAccessToken(churchId, userId, tokens) {
  let accessToken = tokens.access_token;
  if (tokens.expires_at && Date.now() >= tokens.expires_at) {
    const newTokens = await refreshToken(tokens.refresh_token);
    if (!newTokens) return null;
    accessToken = newTokens.access_token;
    newTokens.expires_at = Date.now() + newTokens.expires_in * 1000;
    newTokens.refresh_token = tokens.refresh_token;
    await Database.query(
      `UPDATE user_preferences SET preference_value = ?
       WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?`,
      [JSON.stringify(newTokens), userId, churchId]
    );
  }
  return accessToken;
}

// ─── PCO status check ────────────────────────────────────────────────────────

async function getPcoPersonStatus(pcoPersonId, accessToken) {
  const url = `https://api.planningcenteronline.com/people/v2/people/${pcoPersonId}?fields[Person]=status`;
  const response = await httpsGet(url, accessToken);
  if (response.status !== 200) return null;
  return response.data?.data?.attributes?.status ?? null;
}

// Run up to `concurrency` promises at a time
async function batchRun(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const batch = await Promise.all(slice.map(fn));
    results.push(...batch);
  }
  return results;
}

// ─── Per-church sync ─────────────────────────────────────────────────────────

async function syncChurch(church) {
  const churchId = church.church_id;

  await Database.setChurchContext(churchId, async () => {
    try {
      // Only run if auto-archive is enabled
      const settings = await Database.query(
        `SELECT planning_center_auto_archive FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId]
      );
      if (!settings.length || !settings[0].planning_center_auto_archive) return;

      // Get PCO tokens
      const tokenData = await getTokensForChurch(churchId);
      if (!tokenData) return;
      const { userId, tokens } = tokenData;

      const accessToken = await getValidAccessToken(churchId, userId, tokens);
      if (!accessToken) {
        logger.warn(`PCO sync: could not get valid token for church ${churchId}`);
        return;
      }

      // Get all active LMPG individuals linked to PCO
      const linked = await Database.query(
        `SELECT id, first_name, last_name, planning_center_id
         FROM individuals
         WHERE church_id = ? AND is_active = 1 AND planning_center_id IS NOT NULL`,
        [churchId]
      );

      if (!linked.length) return;

      logger.info(`PCO sync: checking ${linked.length} linked people for church ${churchId}`);

      // Check each person's status in PCO (5 concurrent)
      let archivedCount = 0;
      await batchRun(linked, 5, async (person) => {
        try {
          const status = await getPcoPersonStatus(person.planning_center_id, accessToken);
          if (status === 'inactive') {
            await Database.query(
              `UPDATE individuals SET is_active = 0, updated_at = datetime('now')
               WHERE id = ? AND church_id = ?`,
              [person.id, churchId]
            );
            archivedCount++;
            logger.info(`PCO sync: archived ${person.first_name} ${person.last_name} (PCO id ${person.planning_center_id})`);
          }
        } catch (err) {
          logger.warn(`PCO sync: error checking person ${person.planning_center_id}: ${err.message}`);
        }
      });

      // Record sync result
      await Database.query(
        `UPDATE church_settings
         SET planning_center_last_sync = datetime('now'),
             planning_center_last_sync_archived = ?
         WHERE church_id = ?`,
        [archivedCount, churchId]
      );

      logger.info(`PCO sync: church ${churchId} done — ${archivedCount} archived`);
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

function start() {
  if (cronJob) cronJob.stop();

  // Run daily at 2 AM server time
  cronJob = cron.schedule('0 2 * * *', async () => {
    try {
      const churches = Database.listChurches();
      for (const church of churches) {
        await syncChurch(church);
      }
    } catch (err) {
      logger.error(`PCO sync scheduler error: ${err.message}`);
    }
  });

  logger.info('PCO sync scheduler started (daily at 2 AM)');
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

// Allow manual trigger for testing
async function runNow() {
  const churches = Database.listChurches();
  for (const church of churches) {
    await syncChurch(church);
  }
}

module.exports = { start, stop, runNow };
