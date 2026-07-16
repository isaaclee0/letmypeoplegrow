const express = require('express');
const https = require('https');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { ensureChurchIsolation } = require('../middleware/churchIsolation');
const logger = require('../config/logger');
const pcoSync = require('../services/planningCenterSync');
const { tallyField } = require('../services/planningCenter/summary');
const { searchPcoPeople } = require('../services/planningCenter/peopleSearch');
const { resolveManualLinks } = require('../services/planningCenter/selectionValidation');
const metadataCache = require('../services/planningCenter/metadataCache');
const { isEligible } = require('../services/planningCenter/eligibility');
const { hasLinkedPeople, notLinkedResponse } = require('../services/planningCenter/checkinGate');
const webSocketService = require('../services/websocket');

const router = express.Router();

// Log all requests to integrations routes for debugging (BEFORE auth)
router.use((req, res, next) => {
  console.log(`🔌 [BEFORE AUTH] Integrations route hit: ${req.method} ${req.path}`, {
    hasUser: !!req.user,
    userId: req.user?.id,
    churchId: req.user?.church_id,
    headers: {
      cookie: req.headers.cookie ? 'present' : 'missing',
      authorization: req.headers.authorization ? 'present' : 'missing'
    }
  });
  next();
});

// All routes require authentication
router.use(verifyToken);
router.use(ensureChurchIsolation);
// Elvanto/PCO connect, sync, and import all mutate church-wide data with no
// per-item review on some paths (e.g. batch "Run now") — admin-only, matching
// every other data-mutating router in this app.
router.use(requireRole(['admin']));

// Log after auth passes
router.use((req, res, next) => {
  console.log(`🔌 [AFTER AUTH] Integrations route authenticated: ${req.method} ${req.path}`, {
    userId: req.user?.id,
    churchId: req.user?.church_id
  });
  next();
});

// Helper function to make HTTPS requests
function makeHttpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsedData, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    // Guard against a stalled connection hanging the whole pagination loop.
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy(new Error('Planning Center request timed out'));
    });

    if (options.method === 'POST' && options.data) {
      if (options.headers && options.headers['Content-Type'] === 'application/x-www-form-urlencoded') {
        const formData = new URLSearchParams(options.data).toString();
        req.write(formData);
      } else {
        req.write(JSON.stringify(options.data));
      }
    }

    req.end();
  });
}

// Read a Planning Center env var, tolerating the British "CENTRE" spelling.
// This app is Australian, so PLANNING_CENTRE_* creeps into some .env files;
// accept either spelling so a typo can't silently break the OAuth flow.
function pcoEnv(suffix) {
  return process.env[`PLANNING_CENTER_${suffix}`] || process.env[`PLANNING_CENTRE_${suffix}`];
}

// Helper function to get Elvanto API key from user preferences
async function getElvantoApiKey(userId, churchId) {
  try {
    const preferences = await Database.query(`
      SELECT preference_value
      FROM user_preferences
      WHERE user_id = ? AND preference_key = 'elvanto_api_key' AND church_id = ?
      LIMIT 1
    `, [userId, churchId]);

    if (preferences.length === 0) {
      return null;
    }

    const prefValue = preferences[0].preference_value;
    const data = typeof prefValue === 'string' ? JSON.parse(prefValue) : prefValue;
    return data.api_key || null;
  } catch (error) {
    console.error('Error getting Elvanto API key:', error);
    return null;
  }
}

// Helper function to create Basic auth header from API key
function createElvantoAuthHeader(apiKey) {
  // Elvanto uses Basic auth with API key as username and 'x' as password
  const credentials = Buffer.from(`${apiKey}:x`).toString('base64');
  return `Basic ${credentials}`;
}

// Helper function to normalize names for fuzzy matching
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')           // Remove apostrophes
    .replace(/[-–—]/g, ' ')          // Replace hyphens with spaces
    .replace(/[.,;:!?()]/g, '')      // Remove punctuation
    .replace(/\s+/g, ' ')            // Normalize whitespace
    .trim();
}

// Helper function to convert surname to UPPERCASE
function toUpperCaseSurname(name) {
  if (!name) return '';
  return name.toUpperCase();
}

// Helper function to convert first name to sentence case
function toSentenceCaseName(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Helper function to check if two names match (fuzzy)
function namesMatch(name1, name2) {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  // Exact match after normalization
  if (n1 === n2) return true;
  
  // Extract surname (first part before comma) and compare
  const getSurname = (n) => n.split(',')[0].trim();
  const surname1 = getSurname(n1);
  const surname2 = getSurname(n2);
  
  // If surnames match exactly, likely the same family
  if (surname1 && surname2 && surname1 === surname2) {
    // Also check if there's some first name overlap
    const rest1 = n1.replace(surname1, '').replace(',', '').trim();
    const rest2 = n2.replace(surname2, '').replace(',', '').trim();
    const words1 = rest1.split(' ').filter(w => w.length > 1);
    const words2 = rest2.split(' ').filter(w => w.length > 1);
    
    // If any first names overlap, it's a match
    for (const w1 of words1) {
      for (const w2 of words2) {
        if (w1 === w2 || w1.startsWith(w2) || w2.startsWith(w1)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

// Check if Elvanto is configured/connected
router.get('/elvanto/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    
    // Debug: Check all records for this user
    const allRecords = await Database.query(`
      SELECT id, user_id, preference_key, church_id
      FROM user_preferences
      WHERE user_id = ? AND preference_key = 'elvanto_api_key'
    `, [userId]);
    
    logger.info('Elvanto status check', {
      userId,
      churchId,
      recordsFound: allRecords.length,
      recordChurchIds: allRecords.map(r => r.church_id)
    });
    
    const apiKey = await getElvantoApiKey(userId, churchId);
    
    console.log('🔌 Status check - API key result:', {
      userId,
      churchId,
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'null'
    });
    
    if (!apiKey) {
      console.log('🔌 Status check - No API key, returning disconnected');
      return res.json({
        configured: false,
        connected: false,
        elvantoAccount: null
      });
    }
    
    console.log('🔌 Status check - API key found, testing with Elvanto API...');

    // Test the API key by making a simple request
    try {
      const response = await makeHttpsRequest('https://api.elvanto.com/v1/people/getAll.json?page=1&page_size=10', {
        method: 'GET',
        headers: {
          'Authorization': createElvantoAuthHeader(apiKey)
        }
      });

      if (response.status === 200 && response.data?.status === 'ok') {
        console.log('🔌 Status check - Elvanto API test successful, returning connected');
        return res.json({
          configured: true,
          connected: true,
          elvantoAccount: 'Connected via API Key'
        });
      } else {
        console.log('🔌 Status check - Elvanto API test failed, returning disconnected');
        return res.json({
          configured: true,
          connected: false,
          elvantoAccount: null,
          error: 'API key is invalid or expired'
        });
      }
    } catch (error) {
      return res.json({
        configured: true,
        connected: false,
        elvantoAccount: null,
        error: 'Failed to verify API key'
      });
    }
  } catch (error) {
    console.error('Get Elvanto status error:', error);
    res.status(500).json({ error: 'Failed to get Elvanto integration status.' });
  }
});

// Save Elvanto API key
router.post('/elvanto/connect', async (req, res) => {
  try {
    const { apiKey } = req.body;

    console.log('Elvanto connect request:', {
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length || 0,
      body: req.body
    });

    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key is required.' });
    }

    // Test the API key first - use page_size=10 (Elvanto rejects page_size=1)
    const authHeader = createElvantoAuthHeader(apiKey.trim());
    console.log('Testing Elvanto API key:', {
      apiKeyPrefix: apiKey.trim().substring(0, 10) + '...',
      authHeaderPrefix: authHeader.substring(0, 20) + '...'
    });

    const testResponse = await makeHttpsRequest('https://api.elvanto.com/v1/people/getAll.json?page=1&page_size=10', {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    console.log('Elvanto API test response:', {
      status: testResponse.status,
      dataStatus: testResponse.data?.status,
      error: testResponse.data?.error,
      message: testResponse.data?.message
    });

    // Check for authentication errors (401) or explicit auth failure
    // Error code 102 = Invalid API key, 250 = invalid page size (not auth error)
    const isAuthError = testResponse.status === 401 || 
                        testResponse.data?.error?.code === 102 ||
                        (testResponse.data?.status === 'fail' && testResponse.data?.error?.code !== 250);
    
    if (isAuthError) {
      return res.status(400).json({ 
        error: 'Invalid API key. Please check your Elvanto API key and try again.',
        details: testResponse.data?.error?.message || 'Authentication failed'
      });
    }

    // Store the API key
    const integrationData = {
      api_key: apiKey.trim(),
      connected_at: new Date().toISOString()
    };

    await Database.query(`
      INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
      VALUES (?, 'elvanto_api_key', ?, ?)
      ON CONFLICT(user_id, preference_key) DO UPDATE SET
        preference_value = excluded.preference_value,
        updated_at = CURRENT_TIMESTAMP
    `, [req.user.id, JSON.stringify(integrationData), req.user.church_id]);

    res.json({ 
      success: true, 
      message: 'Elvanto connected successfully.' 
    });
  } catch (error) {
    console.error('Elvanto connect error:', error);
    res.status(500).json({ error: 'Failed to connect Elvanto.' });
  }
});

// Disconnect Elvanto integration
router.post('/elvanto/disconnect', async (req, res) => {
  console.log('🔌 Elvanto disconnect endpoint called');
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;

    console.log('🔌 Elvanto disconnect - User info:', { userId, churchId });

    // Check what records exist before deletion (for debugging)
    const recordsBefore = await Database.query(`
      SELECT id, user_id, preference_key, church_id
      FROM user_preferences
      WHERE user_id = ? AND preference_key = 'elvanto_api_key'
    `, [userId]);

    console.log('🔌 Elvanto disconnect - Before deletion:', {
      userId,
      churchId,
      recordsFound: recordsBefore.length,
      recordChurchIds: recordsBefore.map(r => r.church_id),
      records: recordsBefore
    });

    logger.info('Elvanto disconnect - Before deletion', {
      userId,
      churchId,
      recordsFound: recordsBefore.length,
      recordChurchIds: recordsBefore.map(r => r.church_id)
    });

    // Delete ALL Elvanto-related preferences for this user to ensure complete disconnection
    // This includes: elvanto_api_key, elvanto_integration, and any other elvanto-prefixed keys
    let result;
    try {
      result = await Database.transaction(async (conn) => {
        console.log('🔌 Transaction started - deleting all Elvanto preferences');
        
        // Delete elvanto_api_key
        const deleteApiKey = await conn.query(`
          DELETE FROM user_preferences
          WHERE user_id = ? AND preference_key = 'elvanto_api_key'
        `, [userId]);
        console.log('🔌 Deleted elvanto_api_key:', { affectedRows: deleteApiKey.affectedRows });
        
        // Delete elvanto_integration (OAuth tokens)
        const deleteIntegration = await conn.query(`
          DELETE FROM user_preferences
          WHERE user_id = ? AND preference_key = 'elvanto_integration'
        `, [userId]);
        console.log('🔌 Deleted elvanto_integration:', { affectedRows: deleteIntegration.affectedRows });
        
        // Delete any other elvanto-prefixed preferences
        const deleteOther = await conn.query(`
          DELETE FROM user_preferences
          WHERE user_id = ? AND preference_key LIKE 'elvanto%'
        `, [userId]);
        console.log('🔌 Deleted other elvanto preferences:', { affectedRows: deleteOther.affectedRows });
        
        // Verify deletion immediately within the same transaction
        const verifyResult = await conn.query(`
          SELECT COUNT(*) as count FROM user_preferences
          WHERE user_id = ? AND preference_key LIKE '%elvanto%'
        `, [userId]);
        
        console.log('🔌 Verification within transaction:', { count: verifyResult[0]?.count });
        
        return {
          affectedRows: deleteApiKey.affectedRows + deleteIntegration.affectedRows + deleteOther.affectedRows,
          remainingCount: verifyResult[0]?.count || 0
        };
      });
      console.log('🔌 Transaction committed successfully');
    } catch (transactionError) {
      console.error('🔌 Transaction error:', transactionError);
      throw transactionError;
    }

    console.log('🔌 Elvanto disconnect - Delete result:', {
      userId,
      churchId,
      deletedRows: result.affectedRows,
      remainingCount: result.remainingCount
    });

    logger.info('Elvanto disconnect - Delete result', {
      userId,
      churchId,
      deletedRows: result.affectedRows,
      remainingCount: result.remainingCount
    });

    // Verify the deletion was successful
    if (result.affectedRows === 0 || result.remainingCount > 0) {
      if (recordsBefore.length === 0) {
        // Already disconnected
        logger.info('Elvanto disconnect: Already disconnected', { userId, churchId });
        return res.json({ 
          message: 'Elvanto integration is already disconnected.',
          disconnected: true
        });
      } else {
        // Something went wrong - records exist but weren't deleted
        logger.error('Elvanto disconnect: Failed to delete records', {
          userId,
          churchId,
          recordsBefore: recordsBefore.length,
          deletedRows: result.affectedRows,
          remainingCount: result.remainingCount
        });
        return res.status(500).json({ 
          error: `Failed to disconnect Elvanto integration. ${result.remainingCount} record(s) still exist after deletion attempt.` 
        });
      }
    }

    // Verify deletion by checking if any records remain
    await new Promise(resolve => setTimeout(resolve, 100));
    const recordsAfter = await Database.query(`
      SELECT id, church_id FROM user_preferences
      WHERE user_id = ? AND preference_key = 'elvanto_api_key'
    `, [userId]);
    
    if (recordsAfter.length > 0) {
      logger.error('Elvanto disconnect verification failed - records still exist', {
        userId,
        churchId,
        remainingRecords: recordsAfter.length,
        remainingChurchIds: recordsAfter.map(r => r.church_id)
      });
      return res.status(500).json({ 
        error: 'Failed to disconnect Elvanto integration. The API key may still be stored.' 
      });
    }

    console.log('🔌 Elvanto disconnect: Successfully disconnected', {
      userId,
      churchId,
      deletedRows: result.affectedRows
    });

    logger.info('Elvanto disconnect: Successfully disconnected', {
      userId,
      churchId,
      deletedRows: result.affectedRows
    });

    res.json({ 
      message: 'Elvanto integration disconnected successfully.',
      disconnected: true
    });
  } catch (error) {
    console.error('🔌 Elvanto disconnect ERROR:', error);
    logger.error('Disconnect Elvanto error:', error);
    res.status(500).json({ error: 'Failed to disconnect Elvanto integration.' });
  }
});

// Debug endpoint - dump all available Elvanto data
router.get('/elvanto/debug-dump', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const authHeader = createElvantoAuthHeader(apiKey);
    const results = {
      timestamp: new Date().toISOString(),
      endpoints: {}
    };

    const endpointsToTry = [
      { name: 'people', url: 'https://api.elvanto.com/v1/people/getAll.json?page=1&page_size=100&fields=family,demographics' },
      { name: 'families', url: 'https://api.elvanto.com/v1/families/getAll.json?page=1&page_size=100&fields=people' },
      { name: 'groups', url: 'https://api.elvanto.com/v1/groups/getAll.json?page=1&page_size=100' },
      { name: 'services', url: 'https://api.elvanto.com/v1/services/getAll.json?page=1&page_size=100' },
      { name: 'service_types', url: 'https://api.elvanto.com/v1/services/types/getAll.json' },
      { name: 'locations', url: 'https://api.elvanto.com/v1/locations/getAll.json' },
      { name: 'departments', url: 'https://api.elvanto.com/v1/departments/getAll.json' },
      { name: 'categories', url: 'https://api.elvanto.com/v1/people/categories/getAll.json' },
    ];

    for (const endpoint of endpointsToTry) {
      try {
        const response = await makeHttpsRequest(endpoint.url, {
          method: 'GET',
          headers: { 'Authorization': authHeader }
        });
        results.endpoints[endpoint.name] = {
          status: response.status,
          data: response.data
        };
      } catch (err) {
        results.endpoints[endpoint.name] = {
          error: err.message
        };
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Debug dump error:', error);
    res.status(500).json({ error: 'Failed to dump Elvanto data.', details: error.message });
  }
});

// Get people from Elvanto
router.get('/elvanto/people', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const { page = 1, per_page = 50, search, include_family = 'true' } = req.query;
    
    let url = `https://api.elvanto.com/v1/people/getAll.json?page=${page}&page_size=${per_page}`;
    if (include_family === 'true') {
      url += '&fields=family';
    }
    if (search) {
      url += `&search=${encodeURIComponent(search)}`;
    }

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': createElvantoAuthHeader(apiKey)
      }
    });

    if (response.status !== 200) {
      console.error('Elvanto API returned non-200 status:', response.status, response.data);
      throw new Error(`Elvanto API error: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    res.json(response.data);
  } catch (error) {
    console.error('Get Elvanto people error:', error);
    res.status(500).json({ error: 'Failed to fetch people from Elvanto.', details: error.message });
  }
});

// Get groups from Elvanto
router.get('/elvanto/groups', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const { page = 1, per_page = 50, search } = req.query;
    
    let url = `https://api.elvanto.com/v1/groups/getAll.json?page=${page}&page_size=${per_page}`;
    if (search) {
      url += `&search=${encodeURIComponent(search)}`;
    }

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': createElvantoAuthHeader(apiKey)
      }
    });

    if (response.status !== 200) {
      console.error('Elvanto API returned non-200 status:', response.status, response.data);
      throw new Error(`Elvanto API error: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    res.json(response.data);
  } catch (error) {
    console.error('Get Elvanto groups error:', error);
    res.status(500).json({ error: 'Failed to fetch groups from Elvanto.', details: error.message });
  }
});

// Get details of a specific group including members
router.get('/elvanto/groups/:groupId', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const { groupId } = req.params;
    const url = `https://api.elvanto.com/v1/groups/getInfo.json?id=${groupId}&fields=people`;

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': createElvantoAuthHeader(apiKey)
      }
    });

    if (response.status !== 200) {
      console.error('Elvanto API returned non-200 status:', response.status, response.data);
      throw new Error(`Elvanto API error: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    res.json(response.data);
  } catch (error) {
    console.error('Get Elvanto group info error:', error);
    res.status(500).json({ error: 'Failed to fetch group info from Elvanto.', details: error.message });
  }
});

// Get services from Elvanto
router.get('/elvanto/services', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const { page = 1, per_page = 100 } = req.query;
    
    const url = `https://api.elvanto.com/v1/services/getAll.json?page=${page}&page_size=${per_page}`;

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': createElvantoAuthHeader(apiKey)
      }
    });

    if (response.status !== 200) {
      console.error('Elvanto API returned non-200 status:', response.status, response.data);
      throw new Error(`Elvanto API error: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    res.json(response.data);
  } catch (error) {
    console.error('Get Elvanto services error:', error);
    res.status(500).json({ error: 'Failed to fetch services from Elvanto.', details: error.message });
  }
});

// Check for duplicate gathering names before import
router.post('/elvanto/check-gathering-duplicates', async (req, res) => {
  try {
    const { groupIds, serviceTypeIds } = req.body;

    if (!groupIds && !serviceTypeIds) {
      return res.status(400).json({ error: 'Please provide groupIds or serviceTypeIds to check.' });
    }

    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const authHeader = createElvantoAuthHeader(apiKey);
    const duplicates = [];

    // Check groups
    if (groupIds && groupIds.length > 0) {
      const groupsResponse = await makeHttpsRequest(
        'https://api.elvanto.com/v1/groups/getAll.json?page_size=1000',
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );

      if (groupsResponse.status === 200 && groupsResponse.data?.groups?.group) {
        const allGroups = Array.isArray(groupsResponse.data.groups.group) 
          ? groupsResponse.data.groups.group 
          : [groupsResponse.data.groups.group];

        for (const groupId of groupIds) {
          const group = allGroups.find(g => g.id === groupId);
          if (!group) continue;

          const existing = await Database.query(
            'SELECT id FROM gathering_types WHERE name = ? AND church_id = ?',
            [group.name, req.user.church_id]
          );

          if (existing.length > 0) {
            duplicates.push({
              id: groupId,
              name: group.name,
              type: 'group',
              existingId: Number(existing[0].id)
            });
          }
        }
      }
    }

    // Check service types
    if (serviceTypeIds && serviceTypeIds.length > 0) {
      const servicesResponse = await makeHttpsRequest(
        'https://api.elvanto.com/v1/services/getAll.json?page_size=1000',
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );

      if (servicesResponse.status === 200 && servicesResponse.data?.services?.service) {
        const allServices = Array.isArray(servicesResponse.data.services.service)
          ? servicesResponse.data.services.service
          : [servicesResponse.data.services.service];

        const serviceTypesMap = new Map();
        allServices.forEach(service => {
          if (service.service_type?.id && serviceTypeIds.includes(service.service_type.id)) {
            serviceTypesMap.set(service.service_type.id, service.service_type);
          }
        });

        for (const [typeId, serviceType] of serviceTypesMap) {
          const existing = await Database.query(
            'SELECT id FROM gathering_types WHERE name = ? AND church_id = ?',
            [serviceType.name, req.user.church_id]
          );

          if (existing.length > 0) {
            duplicates.push({
              id: typeId,
              name: serviceType.name,
              type: 'service',
              existingId: Number(existing[0].id)
            });
          }
        }
      }
    }

    res.json({ duplicates });
  } catch (error) {
    console.error('Check gathering duplicates error:', error);
    res.status(500).json({ error: 'Failed to check for duplicate gatherings.', details: error.message });
  }
});

// Import gatherings from Elvanto (groups or service types)
router.post('/elvanto/import-gatherings', async (req, res) => {
  try {
    const { groupIds, serviceTypeIds, gatheringInfo, nameOverrides } = req.body;

    if (!groupIds && !serviceTypeIds) {
      return res.status(400).json({ error: 'Please provide groupIds or serviceTypeIds to import.' });
    }

    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const authHeader = createElvantoAuthHeader(apiKey);
    const importedGatherings = [];
    const duplicates = [];

    // Import groups as gatherings
    if (groupIds && groupIds.length > 0) {
      // Fetch group details
      const groupsResponse = await makeHttpsRequest(
        'https://api.elvanto.com/v1/groups/getAll.json?page_size=1000',
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );

      const allGroups = groupsResponse.data?.groups?.group || [];

      for (const groupId of groupIds) {
        const group = allGroups.find(g => g.id === groupId);
        if (!group) continue;

        // Check if user provided gathering info for this group
        const userProvidedInfo = gatheringInfo && gatheringInfo[groupId];
        
        // Determine name - use user provided, name override, or Elvanto name
        let gatheringName = group.name;
        if (userProvidedInfo?.name) {
          gatheringName = userProvidedInfo.name;
        } else if (nameOverrides && nameOverrides[groupId]) {
          gatheringName = nameOverrides[groupId];
        }
        
        // Determine description - use user provided or parse from Elvanto
        let description = null;
        if (userProvidedInfo?.description !== undefined) {
          description = userProvidedInfo.description || null;
        } else if (group.description) {
          description = group.description.replace(/<[^>]*>/g, ''); // Strip HTML
        }
        
        // Determine day of week - use user provided or parse from Elvanto
        let dayOfWeek = null;
        if (userProvidedInfo?.dayOfWeek) {
          dayOfWeek = userProvidedInfo.dayOfWeek;
        } else if (group.meeting_day) {
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          if (days.includes(group.meeting_day)) {
            dayOfWeek = group.meeting_day;
          }
        }

        // Determine frequency - use user provided or parse from Elvanto
        let frequency = 'weekly';
        if (userProvidedInfo?.frequency) {
          frequency = userProvidedInfo.frequency;
        } else if (group.meeting_frequency) {
          const freq = group.meeting_frequency.toLowerCase();
          if (freq.includes('2 week') || freq.includes('fortnightly') || freq.includes('biweekly')) {
            frequency = 'biweekly';
          } else if (freq.includes('month')) {
            frequency = 'monthly';
          }
        }

        // Parse meeting time - use user provided or parse from Elvanto
        let startTime = null;
        if (userProvidedInfo?.startTime) {
          // Convert "HH:MM" to "HH:MM:SS"
          const timeParts = userProvidedInfo.startTime.split(':');
          startTime = `${timeParts[0]}:${timeParts[1] || '00'}:00`;
        } else if (group.meeting_time) {
          // Convert "6:00 PM" to "18:00:00"
          const timeMatch = group.meeting_time.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] || '00';
            const period = timeMatch[3]?.toUpperCase();
            
            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;
            
            startTime = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
          }
        }

        // Create the gathering
        const gatheringData = {
          name: gatheringName,
          description: description,
          day_of_week: dayOfWeek,
          start_time: startTime,
          frequency: frequency,
          attendance_type: 'standard',
          group_by_family: true,
          is_active: group.status === 'Active',
          created_by: req.user.id,
          church_id: req.user.church_id
        };

        // Check if gathering with same name already exists
        const existing = await Database.query(
          'SELECT id, name FROM gathering_types WHERE name = ? AND church_id = ?',
          [gatheringData.name, req.user.church_id]
        );

        if (existing.length > 0) {
          // If this was a renamed gathering, the new name also exists - add to duplicates
          duplicates.push({
            name: gatheringData.name,
            elvantoId: groupId,
            source: 'group',
            existingId: Number(existing[0].id)
          });
          console.log(`Gathering "${gatheringData.name}" already exists, skipping...`);
          continue;
        }

        const result = await Database.query(
          `INSERT INTO gathering_types (name, description, day_of_week, start_time, frequency, attendance_type, group_by_family, is_active, created_by, church_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gatheringData.name,
            gatheringData.description,
            gatheringData.day_of_week,
            gatheringData.start_time,
            gatheringData.frequency,
            gatheringData.attendance_type,
            gatheringData.group_by_family,
            gatheringData.is_active,
            gatheringData.created_by,
            gatheringData.church_id
          ]
        );

        const gatheringInsertId = result?.insertId;
        importedGatherings.push({
          id: gatheringInsertId ? Number(gatheringInsertId) : null,
          name: gatheringData.name,
          source: 'group',
          elvantoId: groupId
        });
      }
    }

    // Import service types as gatherings
    if (serviceTypeIds && serviceTypeIds.length > 0) {
      // Fetch all services to get service type details
      const servicesResponse = await makeHttpsRequest(
        'https://api.elvanto.com/v1/services/getAll.json?page_size=1000',
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );

      const allServices = servicesResponse.data?.services?.service || [];
      
      // Build unique service types
      const serviceTypesMap = new Map();
      allServices.forEach(service => {
        if (service.service_type?.id && serviceTypeIds.includes(service.service_type.id)) {
          serviceTypesMap.set(service.service_type.id, service.service_type);
        }
      });

      for (const [typeId, serviceType] of serviceTypesMap) {
        // Check if user provided gathering info for this service type
        const userProvidedInfo = gatheringInfo && gatheringInfo[typeId];
        
        // Determine name - use user provided, name override, or Elvanto name
        let gatheringName = serviceType.name;
        if (userProvidedInfo?.name) {
          gatheringName = userProvidedInfo.name;
        } else if (nameOverrides && nameOverrides[typeId]) {
          gatheringName = nameOverrides[typeId];
        }
        
        // Determine description - use user provided or null
        let description = null;
        if (userProvidedInfo?.description !== undefined) {
          description = userProvidedInfo.description || null;
        }
        
        // Determine day of week - use user provided or default
        let dayOfWeek = 'Sunday';
        if (userProvidedInfo?.dayOfWeek) {
          dayOfWeek = userProvidedInfo.dayOfWeek;
        }
        
        // Determine frequency - use user provided or default
        let frequency = 'weekly';
        if (userProvidedInfo?.frequency) {
          frequency = userProvidedInfo.frequency;
        }
        
        // Determine start time - use user provided or default
        let startTime = '10:00:00';
        if (userProvidedInfo?.startTime) {
          const timeParts = userProvidedInfo.startTime.split(':');
          startTime = `${timeParts[0]}:${timeParts[1] || '00'}:00`;
        }
        
        // Create the gathering
        const gatheringData = {
          name: gatheringName,
          description: description,
          day_of_week: dayOfWeek,
          start_time: startTime,
          frequency: frequency,
          attendance_type: 'standard',
          group_by_family: true,
          is_active: true,
          created_by: req.user.id,
          church_id: req.user.church_id
        };

        // Check if gathering with same name already exists
        const existing = await Database.query(
          'SELECT id, name FROM gathering_types WHERE name = ? AND church_id = ?',
          [gatheringData.name, req.user.church_id]
        );

        if (existing.length > 0) {
          // If this was a renamed gathering, the new name also exists - add to duplicates
          duplicates.push({
            name: gatheringData.name,
            elvantoId: typeId,
            source: 'service_type',
            existingId: Number(existing[0].id)
          });
          console.log(`Gathering "${gatheringData.name}" already exists, skipping...`);
          continue;
        }

        const result = await Database.query(
          `INSERT INTO gathering_types (name, description, day_of_week, start_time, frequency, attendance_type, group_by_family, is_active, created_by, church_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gatheringData.name,
            gatheringData.description,
            gatheringData.day_of_week,
            gatheringData.start_time,
            gatheringData.frequency,
            gatheringData.attendance_type,
            gatheringData.group_by_family,
            gatheringData.is_active,
            gatheringData.created_by,
            gatheringData.church_id
          ]
        );

        const gatheringInsertId = result?.insertId;
        importedGatherings.push({
          id: gatheringInsertId ? Number(gatheringInsertId) : null,
          name: gatheringData.name,
          source: 'service_type',
          elvantoId: typeId
        });
      }
    }

    // Sanitize imported gatherings to ensure all IDs are numbers
    const sanitizedGatherings = importedGatherings.map(g => ({
      ...g,
      id: g.id ? Number(g.id) : g.id
    }));

    try {
      const message = duplicates.length > 0
        ? `Successfully imported ${importedGatherings.length} gathering(s). ${duplicates.length} gathering(s) already exist and were skipped.`
        : `Successfully imported ${importedGatherings.length} gathering(s).`;

      res.json({
        success: true,
        message,
        imported: {
          gatherings: sanitizedGatherings
        },
        duplicates: duplicates.length > 0 ? duplicates : undefined
      });
    } catch (jsonError) {
      console.error('JSON serialization error in gatherings import:', jsonError);
      console.error('Data that failed to serialize:', {
        importedGatherings,
        sanitizedGatherings
      });
      res.status(500).json({
        success: false,
        error: 'Failed to serialize response data.',
        details: jsonError.message
      });
    }
  } catch (error) {
    console.error('Import gatherings from Elvanto error:', error);
    res.status(500).json({ error: 'Failed to import gatherings from Elvanto.', details: error.message });
  }
});

// Get families from Elvanto (grouped from people endpoint)
router.get('/elvanto/families', async (req, res) => {
  try {
    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const { search, include_archived = 'false' } = req.query;
    const showArchived = include_archived === 'true';
    
    let url = `https://api.elvanto.com/v1/people/getAll.json?page_size=1000`;
    if (search) {
      url += `&search=${encodeURIComponent(search)}`;
    }

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': createElvantoAuthHeader(apiKey)
      }
    });

    if (response.status !== 200) {
      console.error('Elvanto API returned non-200 status:', response.status, response.data);
      throw new Error(`Elvanto API error: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    let people = response.data?.people?.person || [];
    
    // Filter out archived people unless explicitly requested
    const archivedCount = people.filter(p => p.archived === 1 || p.archived === '1').length;
    if (!showArchived) {
      people = people.filter(p => p.archived !== 1 && p.archived !== '1');
    }
    
    // Group people by family_id
    const familiesMap = {};
    const noFamily = [];
    
    for (const person of people) {
      if (person.family_id && person.family_id !== '') {
        if (!familiesMap[person.family_id]) {
          familiesMap[person.family_id] = {
            id: person.family_id,
            name: '',
            primaryContact: null,
            otherAdults: [],
            children: [],
            people: { person: [] }
          };
        }
        familiesMap[person.family_id].people.person.push(person);
        
        if (person.family_relationship === 'Primary Contact') {
          familiesMap[person.family_id].primaryContact = person;
        } else if (person.family_relationship === 'Spouse') {
          familiesMap[person.family_id].otherAdults.push(person);
        } else if (person.family_relationship === 'Child') {
          familiesMap[person.family_id].children.push(person);
        } else {
          familiesMap[person.family_id].otherAdults.push(person);
        }
      } else {
        noFamily.push(person);
      }
    }
    
    // Generate family names in format: "LASTNAME, FirstName and OtherName"
    for (const familyId of Object.keys(familiesMap)) {
      const family = familiesMap[familyId];
      const members = family.people.person;
      
      const primary = family.primaryContact || members[0];
      const surname = toUpperCaseSurname(primary?.lastname || 'Unknown');
      
      const firstNames = [];
      if (family.primaryContact) {
        firstNames.push(toSentenceCaseName(family.primaryContact.preferred_name || family.primaryContact.firstname));
      }
      
      for (const adult of family.otherAdults) {
        if (firstNames.length < 2) {
          firstNames.push(toSentenceCaseName(adult.preferred_name || adult.firstname));
        }
      }
      
      if (firstNames.length === 0 && members.length > 0) {
        firstNames.push(toSentenceCaseName(members[0].preferred_name || members[0].firstname));
      }
      
      if (firstNames.length === 2) {
        family.name = `${surname}, ${firstNames[0]} and ${firstNames[1]}`;
      } else if (firstNames.length === 1) {
        family.name = `${surname}, ${firstNames[0]}`;
      } else {
        family.name = `${surname} Family`;
      }
      
      delete family.primaryContact;
      delete family.otherAdults;
      delete family.children;
    }
    
    const families = Object.values(familiesMap).sort((a, b) => a.name.localeCompare(b.name));
    
    for (const person of noFamily) {
      families.push({
        id: `individual_${person.id}`,
        name: `${toUpperCaseSurname(person.lastname)}, ${toSentenceCaseName(person.preferred_name || person.firstname)}`,
        isIndividual: true,
        people: { person: [person] }
      });
    }

    // Fetch local families to check for already imported
    const localFamilies = await Database.query(`
      SELECT f.id, f.family_name
      FROM families f
      WHERE f.church_id = ?
    `, [req.user.church_id]);

    const localFamilyNames = localFamilies.map(f => f.family_name);
    
    // Mark families that are already imported
    let alreadyImportedCount = 0;
    for (const family of families) {
      family.alreadyImported = localFamilyNames.some(localName => namesMatch(family.name, localName));
      if (family.alreadyImported) {
        alreadyImportedCount++;
      }
    }

    console.log('Elvanto families (grouped from people):', {
      totalPeople: people.length,
      familiesCount: Object.keys(familiesMap).length,
      individualsCount: noFamily.length,
      archivedHidden: !showArchived ? archivedCount : 0,
      alreadyImportedCount
    });

    res.json({
      families: {
        family: families,
        total: families.length
      },
      meta: {
        archivedCount: archivedCount,
        showingArchived: showArchived,
        alreadyImportedCount
      }
    });
  } catch (error) {
    console.error('Get Elvanto families error:', error);
    res.status(500).json({ error: 'Failed to fetch families from Elvanto.', details: error.message });
  }
});

// Import people/families from Elvanto
router.post('/elvanto/import', async (req, res) => {
  try {
    const { peopleIds, familyIds, gatheringIds } = req.body;

    if (!peopleIds && !familyIds) {
      return res.status(400).json({ error: 'Please provide peopleIds or familyIds to import.' });
    }

    const apiKey = await getElvantoApiKey(req.user.id, req.user.church_id);
    if (!apiKey) {
      return res.status(401).json({ error: 'Elvanto not connected. Please connect your account first.' });
    }

    const authHeader = createElvantoAuthHeader(apiKey);
    const imported = { people: [], families: [] };
    const errors = [];

    // Import families first
    if (familyIds && familyIds.length > 0) {
      for (const familyId of familyIds) {
        try {
          // For families grouped from people, we need to fetch the people with that family_id
          if (familyId.startsWith('individual_')) {
            // This is an individual, handle separately
            const personId = familyId.replace('individual_', '');
            try {
              const personResponse = await makeHttpsRequest(
                `https://api.elvanto.com/v1/people/getInfo.json?id=${personId}`,
                { method: 'GET', headers: { 'Authorization': authHeader } }
              );

              if (personResponse.status !== 200) {
                errors.push(`Failed to fetch person ${personId} from Elvanto: HTTP ${personResponse.status} - ${JSON.stringify(personResponse.data)}`);
                continue;
              }

              if (!personResponse.data?.person) {
                errors.push(`Person ${personId} not found in Elvanto response`);
                continue;
              }

              const person = Array.isArray(personResponse.data.person) 
                ? personResponse.data.person[0] 
                : personResponse.data.person;

              if (!person.firstname || !person.lastname) {
                errors.push(`Person ${personId} missing required name fields (firstname: ${person.firstname}, lastname: ${person.lastname})`);
                continue;
              }
              
              const familyName = `${person.lastname}, ${person.preferred_name || person.firstname}`;
              
              const familyResult = await Database.query(`
                INSERT INTO families (family_name, church_id, created_at, updated_at)
                VALUES (?, ?, datetime('now'), datetime('now'))
              `, [familyName, req.user.church_id]);

              const familyInsertId = familyResult?.insertId;
              if (!familyInsertId) {
                errors.push(`Failed to create family for person ${personId}: no insertId returned`);
                console.error(`Family insert result:`, familyResult);
                continue;
              }

              const individualResult = await Database.query(`
                INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id, created_at, updated_at)
                VALUES (?, ?, ?, 'regular', ?, datetime('now'), datetime('now'))
              `, [person.firstname, person.lastname, familyInsertId, req.user.church_id]);

              const individualInsertId = individualResult?.insertId;
              if (individualInsertId) {
                imported.people.push({ elvantoId: personId, localId: individualInsertId, name: `${person.firstname} ${person.lastname}` });
              }

              imported.families.push({ elvantoId: familyId, localId: familyInsertId, name: familyName });
            } catch (err) {
              errors.push(`Failed to import individual ${personId}: ${err.message}`);
              console.error(`Error importing individual ${personId}:`, err);
            }
          } else {
            // Regular family - fetch all people with this family_id
            try {
              const peopleResponse = await makeHttpsRequest(
                `https://api.elvanto.com/v1/people/getAll.json?page_size=1000`,
                { method: 'GET', headers: { 'Authorization': authHeader } }
              );

              if (peopleResponse.status !== 200) {
                errors.push(`Failed to fetch people for family ${familyId} from Elvanto: HTTP ${peopleResponse.status} - ${JSON.stringify(peopleResponse.data)}`);
                console.error(`Elvanto API error for family ${familyId}:`, peopleResponse.status, peopleResponse.data);
                continue;
              }

              if (!peopleResponse.data?.people?.person) {
                errors.push(`Family ${familyId} not found in Elvanto response`);
                console.error(`Family ${familyId} missing from Elvanto response:`, peopleResponse.data);
                continue;
              }

              // Normalize person to always be an array (Elvanto API sometimes returns single object)
              const personData = peopleResponse.data.people.person;
              if (!personData) {
                errors.push(`Family ${familyId}: No person data in Elvanto response`);
                console.error(`Family ${familyId}: personData is`, personData);
                continue;
              }

              const allPeople = Array.isArray(personData) ? personData : (personData ? [personData] : []);
              
              if (!Array.isArray(allPeople)) {
                errors.push(`Family ${familyId}: Failed to normalize people data to array`);
                console.error(`Family ${familyId}: allPeople is not an array:`, typeof allPeople, allPeople);
                continue;
              }

              const familyMembers = allPeople.filter(p => p && p.family_id && String(p.family_id) === String(familyId));
              
              if (!Array.isArray(familyMembers) || familyMembers.length === 0) {
                errors.push(`No members found for family ${familyId}`);
                console.error(`No members found for family ${familyId}. All people: ${allPeople.length}, Filtered: ${familyMembers.length}`);
                console.error(`Sample family_ids in allPeople:`, allPeople.slice(0, 5).map(p => p?.family_id));
                continue;
              }

              // Generate family name
              const primary = familyMembers.find(p => p.family_relationship === 'Primary Contact') || familyMembers[0];
              const spouse = familyMembers.find(p => p.family_relationship === 'Spouse');
              
              if (!primary || !primary.firstname || !primary.lastname) {
                errors.push(`Family ${familyId} primary member missing required name fields`);
                console.error(`Family ${familyId} primary member missing name fields:`, primary);
                continue;
              }
              
              let familyName;
              if (spouse) {
                familyName = `${primary.lastname}, ${primary.preferred_name || primary.firstname} and ${spouse.preferred_name || spouse.firstname}`;
              } else {
                familyName = `${primary.lastname}, ${primary.preferred_name || primary.firstname}`;
              }

              const familyResult = await Database.query(`
                INSERT INTO families (family_name, church_id, created_at, updated_at)
                VALUES (?, ?, datetime('now'), datetime('now'))
              `, [familyName, req.user.church_id]);

              const localFamilyId = familyResult?.insertId;
              
              if (!localFamilyId) {
                errors.push(`Family ${familyId}: Database insert failed - no insertId returned`);
                console.error(`Family ${familyId}: Database result:`, familyResult);
                continue;
              }

              for (const person of familyMembers) {
                try {
                  if (!person.firstname || !person.lastname) {
                    errors.push(`Skipping family member in ${familyId} - missing name fields (firstname: ${person.firstname}, lastname: ${person.lastname})`);
                    console.error(`Family member missing name fields:`, person);
                    continue;
                  }

                  await Database.query(`
                    INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id, created_at, updated_at)
                    VALUES (?, ?, ?, 'regular', ?, datetime('now'), datetime('now'))
                  `, [person.firstname, person.lastname, localFamilyId, req.user.church_id]);
                } catch (err) {
                  errors.push(`Failed to import ${person.firstname} ${person.lastname}: ${err.message}`);
                  console.error(`Error importing family member:`, err);
                }
              }

              imported.families.push({ elvantoId: familyId, localId: localFamilyId, name: familyName });
              console.log(`Successfully imported family ${familyId}: ${familyName} with ${familyMembers.length} members`);
            } catch (err) {
              errors.push(`Failed to import family ${familyId}: ${err.message}`);
              console.error(`Error importing family ${familyId}:`, err);
            }
          }
        } catch (err) {
          errors.push(`Unexpected error importing family ${familyId}: ${err.message}`);
          console.error(`Unexpected error importing family ${familyId}:`, err);
        }
      }
    }

    // Import individual people (not in families)
    if (peopleIds && peopleIds.length > 0) {
      for (const personId of peopleIds) {
        try {
          const personResponse = await makeHttpsRequest(
            `https://api.elvanto.com/v1/people/getInfo.json?id=${personId}`,
            { method: 'GET', headers: { 'Authorization': authHeader } }
          );

          if (personResponse.status !== 200) {
            errors.push(`Failed to fetch person ${personId} from Elvanto: HTTP ${personResponse.status} - ${JSON.stringify(personResponse.data)}`);
            console.error(`Elvanto API error for person ${personId}:`, personResponse.status, personResponse.data);
            continue;
          }

          if (!personResponse.data?.person) {
            errors.push(`Person ${personId} not found in Elvanto response`);
            console.error(`Person ${personId} missing from Elvanto response:`, personResponse.data);
            continue;
          }

          const person = Array.isArray(personResponse.data.person) 
            ? personResponse.data.person[0] 
            : personResponse.data.person;

          if (!person.firstname || !person.lastname) {
            errors.push(`Person ${personId} missing required name fields (firstname: ${person.firstname}, lastname: ${person.lastname})`);
            console.error(`Person ${personId} missing name fields:`, person);
            continue;
          }

          // Create a single-person family
          const familyName = `${person.lastname}, ${person.preferred_name || person.firstname}`;
          
          let familyResult;
          try {
            familyResult = await Database.query(`
              INSERT INTO families (family_name, church_id, created_at, updated_at)
              VALUES (?, ?, datetime('now'), datetime('now'))
            `, [familyName, req.user.church_id]);
          } catch (dbErr) {
            errors.push(`Failed to create family for person ${personId} (${person.firstname} ${person.lastname}): ${dbErr.message}`);
            console.error(`Database error creating family for person ${personId}:`, dbErr);
            continue;
          }

          const familyInsertId = familyResult?.insertId;
          if (!familyInsertId) {
            errors.push(`Failed to create family for person ${personId}: no insertId returned`);
            console.error(`Family insert result:`, familyResult);
            continue;
          }

          let individualResult;
          try {
            individualResult = await Database.query(`
              INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id, created_at, updated_at)
              VALUES (?, ?, ?, 'regular', ?, datetime('now'), datetime('now'))
            `, [person.firstname, person.lastname, familyInsertId, req.user.church_id]);
          } catch (dbErr) {
            errors.push(`Failed to create individual for person ${personId} (${person.firstname} ${person.lastname}): ${dbErr.message}`);
            console.error(`Database error creating individual for person ${personId}:`, dbErr);
            // Try to clean up the family if individual creation fails
            try {
              await Database.query(`DELETE FROM families WHERE id = ? AND church_id = ?`, [familyInsertId, req.user.church_id]);
            } catch (cleanupErr) {
              console.error(`Failed to cleanup family ${familyInsertId}:`, cleanupErr);
            }
            continue;
          }

          const individualInsertId = individualResult?.insertId;
          if (individualInsertId) {
            imported.people.push({ elvantoId: personId, localId: individualInsertId, name: `${person.firstname} ${person.lastname}` });
          }
          console.log(`Successfully imported person ${personId}: ${person.firstname} ${person.lastname}`);
        } catch (err) {
          errors.push(`Failed to import person ${personId}: ${err.message}`);
          console.error(`Error importing person ${personId}:`, err);
        }
      }
    }

    // Assign imported individuals to gatherings if gatheringIds provided
    if (gatheringIds && Array.isArray(gatheringIds) && gatheringIds.length > 0 && imported.people.length > 0) {
      try {
        const allIndividualIds = imported.people
          .filter(p => p.localId)
          .map(p => Number(p.localId));

        if (allIndividualIds.length > 0) {
          for (const gatheringId of gatheringIds) {
            for (const individualId of allIndividualIds) {
              try {
                // Check if assignment already exists
                const existingAssignment = await Database.query(
                  'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
                  [gatheringId, individualId, req.user.church_id]
                );

                if (existingAssignment.length === 0) {
                  // Create new assignment
                  await Database.query(`
                    INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
                    VALUES (?, ?, ?, ?)
                  `, [gatheringId, individualId, req.user.id, req.user.church_id]);
                }
              } catch (assignErr) {
                // Log but don't fail the import if assignment fails
                console.error(`Failed to assign individual ${individualId} to gathering ${gatheringId}:`, assignErr);
              }
            }
          }
          console.log(`Assigned ${allIndividualIds.length} individuals to ${gatheringIds.length} gathering(s)`);
        }
      } catch (assignError) {
        // Log but don't fail the import if assignment fails
        console.error('Error assigning individuals to gatherings:', assignError);
        errors.push(`Warning: Some individuals were imported but could not be assigned to gatherings: ${assignError.message}`);
      }
    }

    // Log summary
    console.log('Import summary:', {
      importedPeople: imported.people.length,
      importedFamilies: imported.families.length,
      errors: errors.length
    });

    // Convert BigInt values to numbers to avoid JSON serialization issues
    const sanitizedImported = {
      people: imported.people.map(p => ({
        elvantoId: p.elvantoId,
        name: p.name,
        localId: p.localId ? Number(p.localId) : p.localId
      })),
      families: imported.families.map(f => ({
        elvantoId: f.elvantoId,
        name: f.name,
        localId: f.localId ? Number(f.localId) : f.localId
      }))
    };

    try {
      res.json({
        success: errors.length === 0 || (imported.people.length > 0 || imported.families.length > 0),
        imported: sanitizedImported,
        errors: errors.length > 0 ? errors : undefined,
        summary: {
          peopleImported: imported.people.length,
          familiesImported: imported.families.length,
          errorCount: errors.length
        }
      });
    } catch (jsonError) {
      console.error('JSON serialization error:', jsonError);
      console.error('Data that failed to serialize:', {
        imported,
        errors,
        sanitizedImported
      });
      res.status(500).json({
        success: false,
        error: 'Failed to serialize response data.',
        details: jsonError.message,
        summary: {
          peopleImported: imported.people.length,
          familiesImported: imported.families.length,
          errorCount: errors.length
        }
      });
    }
  } catch (error) {
    console.error('Import Elvanto data error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false,
      error: 'Failed to import data from Elvanto.',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ===== PLANNING CENTER INTEGRATION =====

// Helper function to get Planning Center OAuth tokens
// Token persistence, refresh, and single-flight coalescing all live in
// planningCenterSync.js — the canonical implementation, shared by these routes
// and the cron/service layer. PCO rotates the refresh token on every use, so
// having more than one independent refresh path risks a race where one caller
// overwrites a freshly rotated token with a stale one; keeping a single
// implementation (with one in-flight guard) avoids that.
const savePlanningCenterTokens = pcoSync.savePlanningCenterTokens;
const ensureValidPlanningCenterTokens = pcoSync.ensureValidPlanningCenterTokens;

// The PCO connection is church-wide, not per-admin — any admin should see (and
// be able to use) the same connection regardless of which admin completed the
// OAuth flow. Tokens are stored keyed by that connecting admin's user_id purely
// as a storage detail (see planningCenterSync.js), so routes representing "is
// this church connected" must look up by church, not by the current viewer —
// getPlanningCenterTokens(req.user.id, ...) only finds a row for the admin who
// originally connected, making every other admin see "Not Connected".
async function getChurchPlanningCenterTokens(churchId) {
  const owned = await pcoSync.getTokensForChurch(churchId);
  return owned ? { ownerUserId: owned.userId, tokens: owned.tokens } : null;
}

// Helper function to make authenticated Planning Center API requests
async function makePlanningCenterRequest(url, tokens, userId, churchId) {
  try {
    const validTokens = await ensureValidPlanningCenterTokens(userId, churchId, tokens);
    const accessToken = (validTokens || tokens).access_token;

    // Retry on PCO rate limiting (429), honouring Retry-After. Matters when we
    // fan out paginated requests concurrently.
    for (let attempt = 0; ; attempt++) {
      const response = await makeHttpsRequest(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (response.status !== 429 || attempt >= 4) return response;
      const retryAfter = parseInt(response.headers?.['retry-after'], 10);
      const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  } catch (error) {
    console.error('Error making Planning Center request:', error);
    throw error;
  }
}

// Check Planning Center connection status
router.get('/planning-center/status', async (req, res) => {
  try {
    // Check if Planning Center is enabled
    const isEnabled = pcoEnv('ENABLED') === 'true';

    if (!isEnabled) {
      return res.json({
        enabled: false,
        configured: false,
        connected: false,
        planningCenterAccount: null
      });
    }

    const churchId = req.user.church_id;

    const owned = await getChurchPlanningCenterTokens(churchId);
    const tokens = owned && owned.tokens;

    if (!tokens || !tokens.access_token) {
      return res.json({
        enabled: true,
        configured: false,
        connected: false,
        planningCenterAccount: null
      });
    }

    // Test the connection
    try {
      const response = await makePlanningCenterRequest(
        'https://api.planningcenteronline.com/people/v2/me',
        tokens,
        owned.ownerUserId,
        churchId
      );

      if (response.status === 200) {
        const accountName = response.data?.data?.attributes?.name || 'Connected';
        let lastSyncResult = null;
        try {
          const rows = await Database.query(
            `SELECT planning_center_last_sync_result AS r FROM church_settings WHERE church_id = ? LIMIT 1`,
            [req.user.church_id]
          );
          if (rows.length && rows[0].r) lastSyncResult = JSON.parse(rows[0].r);
        } catch (_) { lastSyncResult = null; }
        return res.json({
          enabled: true,
          configured: true,
          connected: true,
          planningCenterAccount: accountName,
          lastSyncResult
        });
      } else {
        return res.json({
          enabled: true,
          configured: true,
          connected: false,
          planningCenterAccount: null,
          error: 'Token is invalid or expired'
        });
      }
    } catch (error) {
      return res.json({
        enabled: true,
        configured: true,
        connected: false,
        planningCenterAccount: null,
        error: 'Failed to verify connection'
      });
    }
  } catch (error) {
    console.error('Get Planning Center status error:', error);
    res.status(500).json({ error: 'Failed to get Planning Center integration status.' });
  }
});

// Derive the OAuth redirect URI from the incoming request so the same app can
// serve multiple production domains (e.g. app.letmypeoplegrow.com.au and
// letmypeoplegrow.app). Each domain must still be registered as a valid callback
// in the Planning Center OAuth app. The value must be identical between the
// /authorize and /callback steps; because PCO redirects back to the same host,
// deriving it from the request on both sides keeps them in sync.
// An explicit PLANNING_CENTER_REDIRECT_URI env var overrides this (used only as a
// fallback when the request host cannot be determined).
function computePcoRedirectUri(req) {
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '')
    .toString().split(',')[0].trim();
  if (!host) {
    return pcoEnv('REDIRECT_URI') || null;
  }
  // Force https for real domains; only localhost is served over http. The proxy
  // chain does not reliably set X-Forwarded-Proto, so we don't trust it here —
  // all registered PCO callback URIs for real domains are https.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = isLocal ? 'http' : 'https';
  return `${proto}://${host}/api/integrations/planning-center/callback`;
}

// Initiate OAuth flow
router.get('/planning-center/authorize', (req, res) => {
  const clientId = pcoEnv('CLIENT_ID');
  const redirectUri = computePcoRedirectUri(req);
  const scope = 'people check_ins'; // Request access to People and Check-ins

  if (!clientId || !redirectUri) {
    console.error('🔐 Planning Center OAuth misconfigured:', {
      hasClientId: !!clientId,
      redirectUri,
    });
    return res.status(500).json({
      error: 'Planning Center is not configured on this server. Set PLANNING_CENTER_CLIENT_ID and PLANNING_CENTER_CLIENT_SECRET.',
    });
  }

  console.log('🔐 Planning Center OAuth - redirect_uri:', redirectUri);

  // Optional post-OAuth redirect target. Only app-relative '/app/...' paths are
  // allowed (prevents open redirect). Falls back to Settings when absent/invalid.
  const rawReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const returnTo = /^\/app\//.test(rawReturnTo) ? rawReturnTo : '';

  // Generate state parameter for security (optional but recommended).
  // Carry the exact redirect_uri so the callback's token exchange uses an
  // identical value (PCO requires the authorize and token redirect_uri to match).
  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    churchId: req.user.church_id,
    timestamp: Date.now(),
    returnTo,
    redirectUri,
  })).toString('base64');

  const authUrl = `https://api.planningcenteronline.com/oauth/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scope)}&` +
    `state=${encodeURIComponent(state)}`;

  console.log('🔐 Planning Center OAuth - Full auth URL:', authUrl);

  res.json({ authUrl });
});

// OAuth callback
router.get('/planning-center/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send('Authorization code missing');
    }

    // Decode state to get user info
    let userId, churchId, returnTo, stateRedirectUri;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
      churchId = stateData.churchId;
      returnTo = stateData.returnTo; // may be undefined for older flows
      stateRedirectUri = stateData.redirectUri; // may be undefined for older flows
    } catch (e) {
      return res.status(400).send('Invalid state parameter');
    }

    // Must match the redirect_uri sent during /authorize. Prefer the value
    // carried in state; fall back to deriving it from this request's host.
    const redirectUri = stateRedirectUri || computePcoRedirectUri(req);

    const clientId = pcoEnv('CLIENT_ID');
    const clientSecret = pcoEnv('CLIENT_SECRET');

    // Exchange authorization code for access token
    const response = await makeHttpsRequest('https://api.planningcenteronline.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: {
        grant_type: 'authorization_code',
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      }
    });

    if (response.status !== 200) {
      // Log credential *shape* only (never the secret) to diagnose invalid_client
      // without leaking anything. A length/whitespace mismatch here usually means
      // the secret was corrupted (e.g. Docker Compose '$' interpolation) or unset.
      console.error('Planning Center OAuth error:', response.data);
      console.error('Planning Center OAuth credential check:', {
        clientIdLength: clientId ? clientId.length : 0,
        clientSecretPresent: !!clientSecret,
        clientSecretLength: clientSecret ? clientSecret.length : 0,
        clientSecretHasWhitespace: clientSecret ? /\s/.test(clientSecret) : false,
        redirectUri,
      });
      return res.status(500).send('Failed to obtain access token');
    }

    const tokens = response.data;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000); // Calculate expiration time

    // Save tokens to database
    await savePlanningCenterTokens(userId, churchId, tokens);

    // Warm the membership/field-definitions cache as soon as PCO is connected, so the
    // batch editor has something to show immediately the first time someone opens it,
    // instead of blocking on a live fetch. Fire-and-forget — errors are logged, not
    // surfaced, and must not delay the redirect below.
    metadataCache.refreshMetadataForChurch(churchId, tokens.access_token)
      .catch((e) => logger.error('PCO connect-time metadata refresh error:', e));

    // Re-validate returnTo on the way out (defense in depth).
    if (returnTo && /^\/app\//.test(returnTo)) {
      const sep = returnTo.includes('?') ? '&' : '?';
      res.redirect(`${returnTo}${sep}pco=connected`);
    } else {
      res.redirect('/app/settings?tab=integrations&pco_success=true');
    }
  } catch (error) {
    console.error('Planning Center OAuth callback error:', error);
    res.status(500).send('OAuth callback failed');
  }
});

// Disconnect Planning Center
router.post('/planning-center/disconnect', async (req, res) => {
  try {
    const churchId = req.user.church_id;

    // Church-wide, not scoped to the clicking admin — the connection isn't
    // "theirs" any more than any other admin's, and status/connect are already
    // church-wide (see getChurchPlanningCenterTokens), so disconnect must be too
    // or a non-connecting admin's click would silently no-op.
    await Database.query(`
      DELETE FROM user_preferences
      WHERE church_id = ? AND preference_key = 'planning_center_tokens'
    `, [churchId]);

    res.json({ success: true, message: 'Planning Center disconnected successfully.' });
  } catch (error) {
    console.error('Disconnect Planning Center error:', error);
    res.status(500).json({ error: 'Failed to disconnect Planning Center.' });
  }
});

const checkinsImport = require('../services/planningCenter/checkinsImport');

// Fetches ALL check-ins for a range (paginated) and returns the merged
// { data, included } payload plus the church timezone.
// PCO check-ins can only be queried by created_at — but created_at is when the
// record was *entered*, which can lag the actual service by days/weeks (Kingston
// enters the week after). So we widen the created_at fetch window by this buffer on
// each side and then filter precisely by the EventPeriod's starts_at (the true
// service date) in normalizeCheckIns.
const CHECKIN_CREATED_BUFFER_DAYS = 21;

function shiftDate(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Concurrency for paginated PCO fetches. PCO's limit is ~100 requests / 20s; at
// ~1s/request this keeps us comfortably under it while cutting a long sequential
// crawl (a year of check-ins is ~160 pages) down by roughly this factor.
const PCO_PAGE_CONCURRENCY = 4;

// Fetching a wide range of check-ins is many PCO pages (a year ≈ 160). The data is
// stable over short windows, so we cache the raw fetch per church + date range and
// reuse it for repeat loads (events list, preview, browse). Importing writes to LMPG,
// not PCO, so an import never invalidates this. Callers pass { force: true } to refresh.
const CHECKINS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CHECKINS_CACHE_MAX_ENTRIES = 20;
const checkinsCache = new Map(); // `${churchId}|${startDate}|${endDate}` -> { payload, timezone, fetchedAt }

// Builds an onProgress callback that emits fetch/write progress to the church's
// sockets. The client filters by jobId. Emission is best-effort: failures are
// swallowed so progress reporting never breaks an import. Returns undefined when no
// jobId is supplied (e.g. server-internal calls), so callers can pass it through
// unconditionally.
function makeImportProgressEmitter(churchId, jobId, phase) {
  if (!jobId) return undefined;
  const safeJobId = String(jobId).slice(0, 64);
  return ({ fetched, total }) => {
    const percent = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
    try {
      webSocketService.broadcastToChurch(churchId, 'pco:import_progress', {
        jobId: safeJobId, phase, percent, fetched, total,
      });
    } catch (e) {
      logger.warn('Failed to emit pco:import_progress', { error: e.message });
    }
  };
}

function fetchAllCheckins(args) {
  const { churchId, startDate, endDate, force = false, onProgress } = args;
  const key = `${churchId}|${startDate}|${endDate}`;
  const cached = checkinsCache.get(key);
  if (!force && cached && (Date.now() - cached.fetchedAt) < CHECKINS_CACHE_TTL_MS) {
    if (onProgress) {
      const n = (cached.payload.data || []).length;
      onProgress({ fetched: n, total: n });
    }
    return Promise.resolve({ payload: cached.payload, timezone: cached.timezone, fetchedAt: cached.fetchedAt });
  }
  return fetchAllCheckinsUncached(args).then((result) => {
    const fetchedAt = Date.now();
    checkinsCache.set(key, { ...result, fetchedAt });
    // Bound memory: drop the oldest entry once over the cap.
    if (checkinsCache.size > CHECKINS_CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of checkinsCache) if (v.fetchedAt < oldest) { oldest = v.fetchedAt; oldestKey = k; }
      if (oldestKey) checkinsCache.delete(oldestKey);
    }
    return { ...result, fetchedAt };
  });
}

async function fetchAllCheckinsUncached({ tokens, userId, churchId, startDate, endDate, onProgress }) {
  // Refresh up-front (single-flight) so the parallel page fetches below all use a
  // fresh, long-lived token and never race on refreshing a token that expires
  // mid-fetch — the cause of the intermittent 401 -> 500 on large ranges.
  tokens = await ensureValidPlanningCenterTokens(userId, churchId, tokens);
  const createdGte = shiftDate(startDate, -CHECKIN_CREATED_BUFFER_DAYS);
  const createdLte = shiftDate(endDate, CHECKIN_CREATED_BUFFER_DAYS);
  // include event_period (real service date) and event_times (service time of day,
  // to split a single event into AM/PM gatherings).
  const base = `https://api.planningcenteronline.com/check-ins/v2/check_ins?` +
    `where[created_at][gte]=${createdGte}T00:00:00Z&where[created_at][lte]=${createdLte}T23:59:59Z&` +
    `per_page=100&include=event,person,event_period,event_times`;

  const fetchPage = async (offset) => {
    const url = offset ? `${base}&offset=${offset}` : base;
    const response = await makePlanningCenterRequest(url, tokens, userId, churchId);
    if (response.status !== 200) {
      throw new Error('Failed to fetch check-ins from Planning Center');
    }
    return response.data;
  };

  // First page gives us the total; PCO pagination is offset-based, so the rest can
  // be fetched in parallel batches instead of one slow sequential crawl.
  const firstPage = await fetchPage(0);
  let data = firstPage.data || [];
  let included = firstPage.included || [];
  const total = firstPage.meta?.total_count ?? data.length;
  if (onProgress) onProgress({ fetched: data.length, total });

  const offsets = [];
  for (let o = 100; o < total; o += 100) offsets.push(o);
  if (offsets.length > 1000) {
    throw new Error('PCO check-ins fetch exceeded 1000 pages — aborting to avoid an unbounded loop');
  }

  for (let i = 0; i < offsets.length; i += PCO_PAGE_CONCURRENCY) {
    const batch = offsets.slice(i, i + PCO_PAGE_CONCURRENCY);
    const pages = await Promise.all(batch.map(fetchPage));
    for (const p of pages) {
      data = data.concat(p.data || []);
      included = included.concat(p.included || []);
    }
    if (onProgress) onProgress({ fetched: data.length, total });
  }

  const settings = await Database.query(
    `SELECT timezone FROM church_settings WHERE church_id = ? LIMIT 1`, [churchId]
  );
  const timezone = (settings[0] && settings[0].timezone) || 'Australia/Sydney';
  return { payload: { data, included }, timezone };
}

// Resolves the effective date range. If either bound is missing, default to
// all available history: earliest check-in (PCO has data from ~2010) to today.
// Earliest date we will request check-in history from PCO when no start date is given.
const PCO_HISTORY_FLOOR = '2010-01-01';
// Arbitrary non-null sentinel id used only when counting records in the preview
// path. Its numeric value is irrelevant — it must simply be non-null so that
// buildRecordWrites includes the row in its output.
const PREVIEW_PLACEHOLDER_ID = -1;

// Reads and parses the persisted check-in import state for a church, or null.
async function loadCheckinImportState(churchId) {
  const rows = await Database.query(
    `SELECT planning_center_checkin_import_state AS s FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  if (!rows[0] || !rows[0].s) return null;
  try { return JSON.parse(rows[0].s); } catch { return null; }
}

function resolveRange(startDate, endDate) {
  const range = {
    startDate: startDate || PCO_HISTORY_FLOOR,
    endDate: endDate || new Date().toISOString().slice(0, 10),
  };
  // Both dates flow into the PCO request URL — validate format (FIX 4).
  const dateFormat = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateFormat.test(range.startDate) || !dateFormat.test(range.endDate)) {
    const err = new Error('Start and end dates must be in YYYY-MM-DD format.');
    err.statusCode = 400;
    throw err;
  }
  return range;
}

// List distinct PCO events that have check-ins in range (for the mapping screen).
router.get('/planning-center/checkins/events', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    if (!(await hasLinkedPeople(churchId))) {
      return res.status(403).json(notLinkedResponse());
    }
    const { startDate, endDate } = resolveRange(req.query.startDate, req.query.endDate);

    const owned = await getChurchPlanningCenterTokens(churchId);
    if (!owned || !owned.tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    const force = req.query.refresh === '1';
    const onProgress = makeImportProgressEmitter(churchId, req.query.jobId, 'fetching');
    const { payload, timezone } = await fetchAllCheckins({ tokens: owned.tokens, userId: owned.ownerUserId, churchId, startDate, endDate, force, onProgress });
    const normalized = checkinsImport.normalizeCheckIns(payload, timezone, { startDate, endDate });
    const events = checkinsImport.summarizeEvents(normalized);

    // Pre-fill the mapping screen by matching each PCO event name to a gathering.
    const gatherings = await Database.query(
      `SELECT id, name FROM gathering_types WHERE church_id = ?`, [churchId]
    );
    const state = await loadCheckinImportState(churchId);
    const savedMappings = (state && state.mappings) || {};
    const importedMarkers = (state && state.imported) || {};
    const withSuggestions = events.map((e) => ({
      ...e,
      suggestedGatheringTypeId: checkinsImport.suggestGatheringId(e.eventName, gatherings, e.serviceTime),
      savedMapping: savedMappings[e.pcoEventId] || null,
      alreadyImportedThrough: (importedMarkers[e.pcoEventId] && importedMarkers[e.pcoEventId].lastImportedDate) || null,
    }));

    res.json({ success: true, startDate, endDate, events: withSuggestions });
  } catch (error) {
    logger.error('PCO check-in events error:', error);
    res.status(500).json({ success: false, error: 'Failed to list Planning Center check-in events.', details: error.message });
  }
});

// Returns persisted import settings so the client can pre-fill the date range.
router.get('/planning-center/checkin-import-state', async (req, res) => {
  try {
    const state = await loadCheckinImportState(req.user.church_id);
    res.json({ success: true, lastRange: (state && state.lastRange) || null });
  } catch (error) {
    logger.error('PCO checkin import-state error:', error);
    res.status(500).json({ success: false, error: 'Failed to load import state.' });
  }
});

// Lightweight probe: is there any check-in data worth importing, and has this
// church already imported check-ins before? Used to decide whether to nudge the
// user. Costs at most a single PCO request (per_page=1, for the total count) and
// short-circuits without any PCO call once an import has been done. Any error is
// treated as "not available" so the UI simply doesn't prompt.
router.get('/planning-center/checkins/availability', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const peopleLinked = await hasLinkedPeople(churchId);

    // Once a check-in import has happened, never nudge again.
    const state = await loadCheckinImportState(churchId);
    const hasImported = !!(state && state.imported && Object.keys(state.imported).length > 0);
    if (hasImported) {
      return res.json({ success: true, hasImported: true, available: false, peopleLinked });
    }

    const owned = await getChurchPlanningCenterTokens(churchId);
    if (!owned || !owned.tokens.access_token) {
      return res.json({ success: true, hasImported: false, available: false, peopleLinked });
    }

    const response = await makePlanningCenterRequest(
      'https://api.planningcenteronline.com/check-ins/v2/check_ins?per_page=1',
      owned.tokens, owned.ownerUserId, churchId
    );
    const total = (response && response.status === 200)
      ? (response.data?.meta?.total_count ?? (response.data?.data?.length || 0))
      : 0;
    res.json({ success: true, hasImported: false, available: total > 0, total, peopleLinked });
  } catch (error) {
    logger.error('PCO checkin availability error:', error);
    // Non-fatal: the UI just won't prompt.
    res.json({ success: true, hasImported: false, available: false, peopleLinked: false });
  }
});

const PCO_PEOPLE_TYPES = ['regular', 'local_visitor', 'traveller_visitor'];
const PCO_BATCH_FREQUENCIES = ['daily', 'weekly', 'monthly'];

function validateBatchBody(body) {
  const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
          defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = body;
  if (typeof name !== 'string' || !name.trim()) return 'name is required.';
  if (typeof membershipFilterEnabled !== 'boolean') return 'membershipFilterEnabled must be a boolean.';
  if (typeof fieldFilterEnabled !== 'boolean') return 'fieldFilterEnabled must be a boolean.';
  if (!Array.isArray(membershipAllowlist) || !membershipAllowlist.every((v) => typeof v === 'string')) {
    return 'membershipAllowlist must be an array of strings.';
  }
  if (!Array.isArray(fieldFilters)) return 'fieldFilters must be an array.';
  for (const rule of fieldFilters) {
    if (!rule || typeof rule.fieldDefinitionId !== 'string' || !Array.isArray(rule.values) || !rule.values.every((v) => typeof v === 'string')) {
      return 'Each field filter rule needs a fieldDefinitionId and an array of string values.';
    }
  }
  if (!PCO_PEOPLE_TYPES.includes(defaultPeopleType)) {
    return 'defaultPeopleType must be one of regular, local_visitor, traveller_visitor.';
  }
  if (gatheringTypeId !== null && gatheringTypeId !== undefined && !Number.isInteger(gatheringTypeId)) {
    return 'gatheringTypeId must be an integer or null.';
  }
  if (typeof scheduleEnabled !== 'boolean') return 'scheduleEnabled must be a boolean.';
  if (!PCO_BATCH_FREQUENCIES.includes(scheduleFrequency)) return 'scheduleFrequency must be one of daily, weekly, monthly.';
  if (!Number.isInteger(scheduleDay)) return 'scheduleDay must be an integer.';
  if (scheduleFrequency === 'weekly' && (scheduleDay < 0 || scheduleDay > 6)) {
    return 'scheduleDay must be an integer between 0 and 6 for weekly schedules.';
  }
  if (scheduleFrequency === 'monthly' && (scheduleDay < 1 || scheduleDay > 31)) {
    return 'scheduleDay must be an integer between 1 and 31 for monthly schedules.';
  }
  return null;
}

// Search PCO people by name for manual linking (ambiguous / unmatched-extra review).
// Excludes anyone already linked to an existing individual in this church.
router.get('/planning-center/people-search', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const { people } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const linkedRows = await Database.query(
      `SELECT planning_center_id FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
      [churchId]
    );
    const alreadyLinked = new Set(linkedRows.map((r) => r.planning_center_id));
    const results = searchPcoPeople(people, q, alreadyLinked);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('PCO people search error:', error);
    res.status(500).json({ error: 'Failed to search Planning Center people.' });
  }
});

// List all saved sync batches for this church.
router.get('/planning-center/sync-batches', async (req, res) => {
  try {
    const batches = await pcoSync.listBatches(req.user.church_id);
    res.json({ success: true, batches });
  } catch (error) {
    logger.error('List PCO sync batches error:', error);
    res.status(500).json({ error: 'Failed to load sync batches.' });
  }
});

// Create a new saved sync batch.
router.post('/planning-center/sync-batches', async (req, res) => {
  try {
    const err = validateBatchBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const churchId = req.user.church_id;
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    // Old/stale clients (dismissible PWA update banner) may omit this field entirely;
    // default to false rather than rejecting the whole request.
    const gatheringAutoRemoveEnabled = typeof req.body.gatheringAutoRemoveEnabled === 'boolean'
      ? req.body.gatheringAutoRemoveEnabled : false;
    const insRes = await Database.query(
      `INSERT INTO planning_center_sync_batches
         (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
          default_people_type, gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [churchId, name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       gatheringAutoRemoveEnabled ? 1 : 0, scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay]
    );
    const batch = await pcoSync.getBatch(churchId, insRes.insertId);
    res.json({ success: true, batch });
  } catch (error) {
    logger.error('Create PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to create sync batch.' });
  }
});

// Update a saved sync batch.
router.put('/planning-center/sync-batches/:id', async (req, res) => {
  try {
    const err = validateBatchBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const churchId = req.user.church_id;
    const batchId = Number(req.params.id);
    const existing = await pcoSync.getBatch(churchId, batchId);
    if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    // Old/stale clients (dismissible PWA update banner) may omit this field entirely;
    // default to false rather than rejecting the whole request.
    const gatheringAutoRemoveEnabled = typeof req.body.gatheringAutoRemoveEnabled === 'boolean'
      ? req.body.gatheringAutoRemoveEnabled : false;
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET name = ?, membership_filter_enabled = ?, membership_allowlist = ?,
              field_filter_enabled = ?, field_filters = ?, default_people_type = ?,
              gathering_type_id = ?, gathering_auto_remove_enabled = ?, schedule_enabled = ?, schedule_frequency = ?, schedule_day = ?,
              updated_at = datetime('now')
        WHERE id = ? AND church_id = ?`,
      [name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       gatheringAutoRemoveEnabled ? 1 : 0, scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay, batchId, churchId]
    );
    const batch = await pcoSync.getBatch(churchId, batchId);

    // Backfill: the moment this toggle flips off -> on for a batch with a
    // gathering assigned, claim ownership of existing gathering_lists rows this
    // batch would itself currently add — so stale members already on the roster
    // before this feature (or before this toggle) existed get caught on the very
    // next sync, not just future drift. Rows that don't qualify (unlinked,
    // inactive, or linked-but-non-matching) are left permanently unowned — never
    // a candidate for auto-removal, same protection manual additions get.
    if (!existing.gatheringAutoRemoveEnabled && batch.gatheringAutoRemoveEnabled && batch.gatheringTypeId) {
      try {
        const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
        if (accessToken) {
          const { people: pcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
          const pcoById = new Map(pcoPeople.map((p) => [p.id, p]));
          const filterConfig = pcoSync.batchFilterConfig(batch);
          const candidates = await Database.query(
            `SELECT gl.id, i.planning_center_id AS pcoId
               FROM gathering_lists gl
               JOIN individuals i ON i.id = gl.individual_id AND i.church_id = gl.church_id
              WHERE gl.gathering_type_id = ? AND gl.added_by_pco_batch_id IS NULL
                AND gl.church_id = ? AND i.planning_center_id IS NOT NULL AND i.is_active = 1`,
            [batch.gatheringTypeId, churchId]
          );
          let claimed = 0;
          const backfillErrors = [];
          for (const row of candidates) {
            const person = pcoById.get(row.pcoId);
            if (person && person.status === 'active' && isEligible(person, filterConfig)) {
              try {
                await Database.query(
                  `UPDATE gathering_lists SET added_by_pco_batch_id = ? WHERE id = ? AND church_id = ?`,
                  [batch.id, row.id, churchId]
                );
                claimed++;
              } catch (e) {
                backfillErrors.push({ id: row.id, error: e.message });
              }
            }
          }
          if (backfillErrors.length > 0) {
            logger.warn('PCO gathering-ownership backfill had per-row failures', {
              churchId, batchId: batch.id, candidateCount: candidates.length, claimed, errors: backfillErrors,
            });
          }
        }
      } catch (e) {
        // Best-effort: a PCO token/fetch failure here must never block saving the
        // batch's own settings (the UPDATE above already committed). Surface it in
        // logs only — the backfill will simply be incomplete until the next attempt.
        logger.warn('PCO gathering-ownership backfill failed to run', {
          churchId, batchId: batch.id, error: e.message,
        });
      }
    }

    res.json({ success: true, batch });
  } catch (error) {
    logger.error('Update PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to update sync batch.' });
  }
});

// Delete a saved sync batch. Does not unlink or archive anyone already imported
// through it — it only stops future runs of that filter.
router.delete('/planning-center/sync-batches/:id', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const batchId = Number(req.params.id);
    const existing = await pcoSync.getBatch(churchId, batchId);
    if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
    await Database.query(`DELETE FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`, [batchId, churchId]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to delete sync batch.' });
  }
});

// Dry-run: compute one batch's plan without writing anything.
router.get('/planning-center/sync-batches/:id/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const batch = await pcoSync.getBatch(churchId, Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const force = req.query.refresh === '1' || req.query.force === '1';
    const fullPlan = await pcoSync.computePlanForBatch(churchId, accessToken, batch, { force });
    // Batch plans omit the whole-roster buckets (archiveExtras/unmatchedVisitors) —
    // no endpoint surfaces those on their own anymore; computePlan still returns
    // them because diffEngine.js is shared with every batch's own plan. pcoPeople
    // (the full unfiltered PCO roster, attached by computePlanForChurch for the
    // background-check sync in apply.js) is stripped for the same reason — it's
    // server-side-only input, never meant for the client.
    const { archiveExtras, unmatchedVisitors, pcoPeople, ...plan } = fullPlan;
    res.json({
      success: true,
      summary: {
        link: plan.link.length,
        restore: (plan.restore || []).length,
        ambiguous: plan.ambiguous.length,
        visitorMatches: (plan.visitorMatches || []).length,
        add: plan.add.length,
        update: plan.update.length,
        archive: plan.archive.length,
        reactivate: plan.reactivate.length,
        familyNameUpdates: (plan.familyNameUpdates || []).length,
      },
      plan,
    });
  } catch (error) {
    logger.error('PCO batch sync plan error:', error);
    res.status(500).json({ error: 'Failed to compute sync plan.' });
  }
});

// Apply: recompute this batch's plan and apply it. Body may include { selections }.
router.post('/planning-center/sync-batches/:id/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;
    const batch = await pcoSync.getBatch(churchId, Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computePlanForBatch(churchId, accessToken, batch);

    const rawSel = (req.body && req.body.selections) || {};
    const { people: cachedPcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const validPcoIds = new Set(cachedPcoPeople.map((p) => p.id));

    const addPcoIds = new Set(plan.add.map((a) => a.pcoId));
    const skipAddPcoIds = (Array.isArray(rawSel.skipAddPcoIds) ? rawSel.skipAddPcoIds : [])
      .filter((id) => addPcoIds.has(id));

    // Seed claimed pcoIds with everything the plan itself already assigns, so a
    // reviewer's manual ambiguous pick can't collide with an auto-link/restore/
    // visitor-match/non-skipped-add from the same run.
    const claimedPcoIds = new Set([
      ...plan.link.map((l) => l.pcoId),
      ...(plan.restore || []).map((r) => r.pcoId),
      ...(plan.visitorMatches || []).map((v) => v.candidate.pcoId),
      ...plan.add.filter((a) => !skipAddPcoIds.includes(a.pcoId)).map((a) => a.pcoId),
    ]);

    const ambiguousIndividualIds = new Set(plan.ambiguous.map((a) => a.individualId));
    const ambiguousCandidates = Object.entries(rawSel.ambiguous || {}).map(([individualId, pcoId]) => ({
      individualId: Number(individualId), pcoId,
    }));
    const acceptedAmbiguous = resolveManualLinks(ambiguousCandidates, {
      validPcoIds, claimedPcoIds, allowedIndividualIds: ambiguousIndividualIds,
    });
    const ambiguous = {};
    for (const a of acceptedAmbiguous) ambiguous[a.individualId] = a.pcoId;

    const linkedAmbiguousIds = new Set(Object.keys(ambiguous).map(Number));
    const archiveAmbiguousIds = (Array.isArray(rawSel.archiveAmbiguousIds) ? rawSel.archiveAmbiguousIds : [])
      .map(Number)
      .filter((id) => ambiguousIndividualIds.has(id) && !linkedAmbiguousIds.has(id));

    const visitorOfferIds = new Set((plan.visitorMatches || []).map((v) => Number(v.individualId)));
    const visitorChoices = {};
    for (const [rawId, choice] of Object.entries(rawSel.visitorChoices || {})) {
      const id = Number(rawId);
      if (visitorOfferIds.has(id) && (choice === 'promote' || choice === 'keep')) {
        visitorChoices[id] = choice;
      }
    }
    const familyNameUpdateIds = new Set((plan.familyNameUpdates || []).map((f) => f.familyId));
    const skipFamilyNameUpdateIds = (Array.isArray(rawSel.skipFamilyNameUpdateIds) ? rawSel.skipFamilyNameUpdateIds : [])
      .map(Number)
      .filter((id) => familyNameUpdateIds.has(id));

    const selections = { ambiguous, skipAddPcoIds, visitorChoices, archiveAmbiguousIds, skipFamilyNameUpdateIds };

    const result = await pcoSync.applyForChurch(churchId, plan, userId, selections, {
      batchId: batch.id,
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
      gatheringAutoRemoveEnabled: batch.gatheringAutoRemoveEnabled,
    });

    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      gatheringRemoved: result.gatheringRemoved,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [JSON.stringify(summary), batch.id, churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO batch sync apply error:', error);
    res.status(500).json({ error: 'Failed to apply sync.' });
  }
});

// Membership distribution for the allow-list editor (person counts only, no check-ins).
// Serves the persisted cache immediately; if it's missing, blocks on a live fetch (and
// populates the cache as a side effect); if it's present but stale, serves it as-is and
// kicks off a background refresh, flagged via `refreshing` so the client can show it's
// checking Planning Center for updates.
router.get('/planning-center/membership-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const result = await metadataCache.readMembershipSummary(churchId, accessToken);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('PCO membership summary error:', error);
    res.status(500).json({ error: 'Failed to load membership summary.' });
  }
});

// Custom field definitions (select/checkbox only) for the field-filter editor. Same
// cache-first/background-refresh treatment as membership-summary above.
router.get('/planning-center/field-definitions', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const result = await metadataCache.readFieldDefinitionsSummary(churchId, accessToken);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('PCO field definitions error:', error);
    res.status(500).json({ error: 'Failed to load custom field definitions.' });
  }
});

// Value distribution for one custom field (person counts only, no check-ins). Reuses
// the same persisted field-definitions cache as the field-definitions route above
// instead of re-fetching definitions from PCO on every call — this endpoint is only
// reached after the field-filter dropdown (which already warms that cache) has loaded.
router.get('/planning-center/field-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const fieldDefinitionId = req.query.fieldDefinitionId;
    if (!fieldDefinitionId || typeof fieldDefinitionId !== 'string') {
      return res.status(400).json({ error: 'fieldDefinitionId is required.' });
    }
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const [{ people }, fieldDefinitionsResult] = await Promise.all([
      pcoSync.getCachedPcoPeople(churchId, accessToken),
      metadataCache.readFieldDefinitionsSummary(churchId, accessToken),
    ]);
    const definition = fieldDefinitionsResult.definitions.find((d) => d.id === fieldDefinitionId);
    res.json({ success: true, ...tallyField(people, fieldDefinitionId, definition?.options || []) });
  } catch (error) {
    logger.error('PCO field summary error:', error);
    res.status(500).json({ error: 'Failed to load field summary.' });
  }
});

// Import check-ins from Planning Center
// Shared core: fetch, normalize, resolve people, and (optionally) write.
async function runCheckinImport({ req, commit }) {
  const userId = req.user.id;
  const churchId = req.user.church_id;
  if (!(await hasLinkedPeople(churchId))) {
    const body = notLinkedResponse();
    const err = new Error(body.error);
    err.statusCode = 403;
    err.code = body.code;
    throw err;
  }
  const { startDate, endDate } = resolveRange(req.body.startDate, req.body.endDate);
  const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];

  const jobId = req.body.jobId;
  // Captured inside the transaction, read afterwards to persist import state.
  let committedEventToGathering = new Map();
  const newGatheringIds = new Set();
  let userAssignmentsCreated = 0;

  // Onboarding-only: also populate gathering_lists for active, recent attendees.
  let recencyWeeks = parseInt(req.body.recencyWeeks, 10);
  if (!Number.isInteger(recencyWeeks) || recencyWeeks < 1) recencyWeeks = 8; // default 8-week recency window for treating an attendee as a current regular

  // Validate every mapping up front (applies to both preview and execute).
  // The frontend only ever sends entries with target 'existing' or 'new', so
  // this is a safety net against malformed input.
  for (const m of mappings) {
    if (m.target === 'new') {
      if (!m.newGatheringName || !String(m.newGatheringName).trim()) {
        const err = new Error(`Mapping for event ${m.pcoEventId} is set to 'new' but has no gathering name.`);
        err.statusCode = 400;
        throw err;
      }
    } else if (m.target === 'existing') {
      if (!m.gatheringTypeId) {
        const err = new Error(`Mapping for event ${m.pcoEventId} is set to 'existing' but has no gatheringTypeId.`);
        err.statusCode = 400;
        throw err;
      }
    } else {
      const err = new Error(`Mapping for event ${m.pcoEventId} has an invalid target '${m.target}'.`);
      err.statusCode = 400;
      throw err;
    }
  }

  // Note: userId above is the *acting* admin (used below for attribution and
  // "assign to me"); the PCO connection itself is church-wide, so the token
  // lookup uses whichever admin actually owns the stored tokens.
  const owned = await getChurchPlanningCenterTokens(churchId);
  if (!owned || !owned.tokens.access_token) {
    const err = new Error('Planning Center not connected.');
    err.statusCode = 400;
    throw err;
  }

  const onProgress = makeImportProgressEmitter(churchId, jobId, 'fetching');
  const { payload, timezone } = await fetchAllCheckins({ tokens: owned.tokens, userId: owned.ownerUserId, churchId, startDate, endDate, onProgress });
  const normalized = checkinsImport.normalizeCheckIns(payload, timezone, { startDate, endDate });

  // Existing individuals keyed by planning_center_id (active OR archived).
  const existingRows = await Database.query(
    `SELECT id, planning_center_id AS pcoId, is_active AS isActive
       FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
    [churchId]
  );
  const existingByPcoId = new Map(existingRows.map((r) => [r.pcoId, { id: r.id, isActive: r.isActive }]));

  const people = checkinsImport.resolvePeople(normalized, existingByPcoId);

  // Build the event->gathering map. For preview, "new" events have no id yet.
  const mappingByEvent = new Map(mappings.map((m) => [m.pcoEventId, m]));

  const allEventSummaries = checkinsImport.summarizeEvents(normalized);

  const summary = {
    startDate, endDate, timezone,
    matchedPeople: people.matched.length,
    peopleToCreate: people.toCreate.length,
    events: allEventSummaries
      .filter((e) => mappingByEvent.has(e.pcoEventId))
      .map((e) => ({ ...e, mapping: mappingByEvent.get(e.pcoEventId) })),
  };

  if (!commit) {
    // Preview: compute counts using a placeholder gathering id per mapped event.
    const eventToGathering = new Map();
    for (const m of mappings) eventToGathering.set(m.pcoEventId, m.gatheringTypeId || PREVIEW_PLACEHOLDER_ID);
    const personToIndividual = new Map(people.matched.map((p) => [p.pcoPersonId, p.individualId]));
    // include to-create people with a placeholder so record count is accurate
    for (const c of people.toCreate) personToIndividual.set(c.pcoPersonId, PREVIEW_PLACEHOLDER_ID);
    const writes = checkinsImport.buildRecordWrites(normalized, personToIndividual, eventToGathering);

    summary.recordsToWrite = writes.length;
    summary.sessionsInvolved = new Set(writes.map((w) => `${w.gatheringTypeId}|${w.date}`)).size;
    return summary;
  }

  // Commit: everything inside one transaction.
  let createdPeople = 0, gatheringsCreated = 0, sessionsCreated = 0, recordsWritten = 0, recordsSkipped = 0, assignmentsCreated = 0;

  await Database.transaction(async (conn) => {
    // 1) Create missing (inactive) people, capture ids.
    const personToIndividual = new Map(people.matched.map((p) => [p.pcoPersonId, p.individualId]));
    for (const c of people.toCreate) {
      const ins = await conn.query(
        `INSERT INTO individuals (first_name, last_name, people_type, is_active, planning_center_id, created_by, church_id)
         VALUES (?, ?, 'regular', 0, ?, ?, ?)`,
        [c.firstName, c.lastName, c.pcoPersonId, userId, churchId]
      );
      personToIndividual.set(c.pcoPersonId, ins.insertId);
      createdPeople++;
    }

    // 2) Resolve event -> gathering, creating new gatherings where requested.
    const eventToGathering = new Map();
    const userAssignmentJobs = []; // { gatheringTypeId, userAssignment }
    for (const m of mappings) {
      if (m.target === 'new') {
        const sched = m.schedule || {};
        const irregular = sched.irregular === true;
        const dayOfWeek = irregular ? null : (sched.dayOfWeek || null);
        const frequency = irregular ? null : (sched.frequency || null);
        const startTime = sched.startTime || null;
        const ins = await conn.query(
          `INSERT INTO gathering_types (name, attendance_type, day_of_week, start_time, frequency, created_by, church_id)
           VALUES (?, 'standard', ?, ?, ?, ?, ?)`,
          [m.newGatheringName, dayOfWeek, startTime, frequency, userId, churchId]
        );
        eventToGathering.set(m.pcoEventId, ins.insertId);
        newGatheringIds.add(ins.insertId);
        userAssignmentJobs.push({ gatheringTypeId: ins.insertId, userAssignment: m.userAssignment });
        gatheringsCreated++;
      } else if (m.gatheringTypeId) {
        eventToGathering.set(m.pcoEventId, m.gatheringTypeId);
      }
    }

    // 3) Build writes and apply, upserting sessions and DO NOTHING on records.
    const writes = checkinsImport.buildRecordWrites(normalized, personToIndividual, eventToGathering);
    const sessionCache = new Map(); // `${gid}|${date}` -> sessionId
    const latestPresent = new Map(); // individualId -> max date

    const writeProgress = makeImportProgressEmitter(churchId, jobId, 'writing');
    const totalWrites = writes.length;
    let writeIndex = 0;
    for (const w of writes) {
      const sKey = `${w.gatheringTypeId}|${w.date}`;
      let sessionId = sessionCache.get(sKey);
      if (sessionId == null) {
        const existing = await conn.query(
          `SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
          [w.gatheringTypeId, w.date, churchId]
        );
        if (existing.length > 0) {
          sessionId = existing[0].id;
        } else {
          const ins = await conn.query(
            `INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (?, ?, ?, ?)`,
            [w.gatheringTypeId, w.date, userId, churchId]
          );
          sessionId = ins.insertId;
          sessionsCreated++;
        }
        sessionCache.set(sKey, sessionId);
      }

      // NOTE: We intentionally do NOT add imported individuals to gathering_lists.
      // Present attendance is surfaced by reports directly from attendance_records
      // (reports.js: COUNT(... ar.present = 1 ...) with WHERE i.is_active=1 OR ar.present=1),
      // so historical/inactive attendees count in stats without cluttering the live roster.
      const result = await conn.query(
        `INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time, church_id)
         VALUES (?, ?, 1, 'regular', ?)
         ON CONFLICT(session_id, individual_id) DO NOTHING`,
        [sessionId, w.individualId, churchId]
      );
      // This codebase's DB layer maps better-sqlite3's `result.changes` to
      // `affectedRows`; a DO NOTHING no-op returns 0, a fresh insert returns 1.
      if (result.affectedRows && result.affectedRows > 0) recordsWritten++; else recordsSkipped++;

      const prev = latestPresent.get(w.individualId);
      if (!prev || prev < w.date) latestPresent.set(w.individualId, w.date);

      writeIndex++;
      if (writeProgress && (writeIndex % 50 === 0 || writeIndex === totalWrites)) {
        writeProgress({ fetched: writeIndex, total: totalWrites });
      }
    }
    if (writeProgress && totalWrites === 0) writeProgress({ fetched: 0, total: 0 });

    // 4) Move last_attendance_date forward only.
    for (const [individualId, date] of latestPresent) {
      await conn.query(
        `UPDATE individuals SET last_attendance_date = ?
           WHERE id = ? AND church_id = ? AND (last_attendance_date IS NULL OR last_attendance_date < ?)`,
        [date, individualId, churchId, date]
      );
    }

    // Member roster auto-fill: add active, recently-attending people to the roll
    // of each NEWLY CREATED gathering they attended. Existing gatherings are left
    // untouched. (Onboarding maps everything to new gatherings, so its prior
    // behaviour is preserved.)
    const newEventToGathering = new Map();
    for (const [evId, gid] of eventToGathering) {
      if (newGatheringIds.has(gid)) newEventToGathering.set(evId, gid);
    }
    if (newEventToGathering.size > 0) {
      const activeRows = await conn.query(
        `SELECT id FROM individuals WHERE church_id = ? AND is_active = 1`,
        [churchId]
      );
      const activeIndividualIds = new Set(activeRows.map((r) => r.id));
      const today = new Date().toISOString().slice(0, 10);
      const adds = checkinsImport.buildGatheringListAdds(
        normalized, activeIndividualIds, personToIndividual, newEventToGathering, recencyWeeks, today
      );
      for (const a of adds) {
        const r = await conn.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [a.gatheringTypeId, a.individualId, userId, churchId]
        );
        if (r.affectedRows && r.affectedRows > 0) assignmentsCreated++;
      }
    }

    // Staff-user assignment for new gatherings: none / me / copy-from-source.
    for (const job of userAssignmentJobs) {
      const ua = job.userAssignment || { mode: 'none' };
      if (ua.mode === 'me') {
        const r = await conn.query(
          `INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
           VALUES (?, ?, ?, ?) ON CONFLICT(user_id, gathering_type_id) DO NOTHING`,
          [userId, job.gatheringTypeId, userId, churchId]
        );
        if (r.affectedRows && r.affectedRows > 0) userAssignmentsCreated++;
      } else if (ua.mode === 'copy' && ua.sourceGatheringTypeId) {
        const src = await conn.query(
          `SELECT user_id FROM user_gathering_assignments WHERE gathering_type_id = ? AND church_id = ?`,
          [ua.sourceGatheringTypeId, churchId]
        );
        for (const s of src) {
          const r = await conn.query(
            `INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
             VALUES (?, ?, ?, ?) ON CONFLICT(user_id, gathering_type_id) DO NOTHING`,
            [s.user_id, job.gatheringTypeId, userId, churchId]
          );
          if (r.affectedRows && r.affectedRows > 0) userAssignmentsCreated++;
        }
      }
    }

    committedEventToGathering = eventToGathering;
  });

  // Persist settings so a future import can skip re-deciding mappings.
  try {
    const eventSummaries = allEventSummaries;
    const summaryByEvent = new Map(eventSummaries.map((e) => [e.pcoEventId, e]));
    const mappingsToSave = {};
    const importedToSave = {};
    for (const m of mappings) {
      const gid = committedEventToGathering.get(m.pcoEventId);
      // A 'new' mapping that successfully created a gathering is persisted as
      // 'existing' pointing at that gathering, so a later re-import reuses it
      // (attendance is idempotent via ON CONFLICT) instead of creating a duplicate.
      if (m.target === 'new' && gid) {
        mappingsToSave[m.pcoEventId] = {
          target: 'existing',
          gatheringTypeId: gid,
          newGatheringName: null,
          schedule: null,
          userAssignment: null,
        };
      } else {
        mappingsToSave[m.pcoEventId] = {
          target: m.target,
          gatheringTypeId: gid || m.gatheringTypeId || null,
          newGatheringName: m.newGatheringName || null,
          schedule: m.schedule || null,
          userAssignment: m.userAssignment || null,
        };
      }
      const s = summaryByEvent.get(m.pcoEventId);
      if (s && gid) importedToSave[m.pcoEventId] = { lastImportedDate: s.lastDate, gatheringTypeId: gid };
    }
    const prevState = await loadCheckinImportState(churchId);
    const nextState = checkinsImport.mergeCheckinImportState(prevState, {
      lastRange: { startDate, endDate },
      mappings: mappingsToSave,
      imported: importedToSave,
    });
    await Database.query(
      `UPDATE church_settings SET planning_center_checkin_import_state = ? WHERE church_id = ?`,
      [JSON.stringify(nextState), churchId]
    );
  } catch (e) {
    logger.warn('Failed to persist checkin import state', { error: e.message });
  }

  return { ...summary, createdPeople, gatheringsCreated, sessionsCreated, recordsWritten, recordsSkipped, assignmentsCreated, userAssignmentsCreated };
}

// Preview — no writes.
router.post('/planning-center/import-checkins/preview', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: false });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in preview error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

// Execute — writes inside a transaction.
router.post('/planning-center/import-checkins/execute', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in execute error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

module.exports = router;
