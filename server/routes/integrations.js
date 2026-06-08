const express = require('express');
const https = require('https');
const fs = require('fs');
const multer = require('multer');
const csv = require('csv-parser');
const Database = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const logger = require('../config/logger');
const pcoSync = require('../services/planningCenterSync');
const { tallyMembership } = require('../services/planningCenter/summary');
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
async function getPlanningCenterTokens(userId, churchId) {
  try {
    console.log('🔍 Getting Planning Center tokens for:', { userId, churchId });
    const preferences = await Database.query(`
      SELECT preference_value
      FROM user_preferences
      WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?
      LIMIT 1
    `, [userId, churchId]);

    console.log('🔍 Query result:', { rowCount: preferences.length });

    if (preferences.length === 0) {
      console.log('❌ No Planning Center tokens found');
      return null;
    }

    const prefValue = preferences[0].preference_value;
    const data = typeof prefValue === 'string' ? JSON.parse(prefValue) : prefValue;
    console.log('✅ Planning Center tokens found, access_token prefix:', data.access_token?.substring(0, 20) + '...');
    return data;
  } catch (error) {
    console.error('❌ Error getting Planning Center tokens:', error);
    return null;
  }
}

// Helper function to save Planning Center OAuth tokens
async function savePlanningCenterTokens(userId, churchId, tokens) {
  try {
    // Delete existing tokens
    await Database.query(`
      DELETE FROM user_preferences
      WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?
    `, [userId, churchId]);

    // Insert new tokens
    await Database.query(`
      INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
      VALUES (?, 'planning_center_tokens', ?, ?)
    `, [userId, JSON.stringify(tokens), churchId]);

    return true;
  } catch (error) {
    console.error('Error saving Planning Center tokens:', error);
    return false;
  }
}

// Helper function to refresh Planning Center access token
async function refreshPlanningCenterToken(refreshToken) {
  try {
    const response = await makeHttpsRequest('https://api.planningcenteronline.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.PLANNING_CENTER_CLIENT_ID,
        client_secret: process.env.PLANNING_CENTER_CLIENT_SECRET
      }
    });

    if (response.status === 200) {
      return response.data;
    }

    return null;
  } catch (error) {
    console.error('Error refreshing Planning Center token:', error);
    return null;
  }
}

// Proactively refresh the access token if it's expired or expiring soon, ONCE,
// before any fan-out of parallel requests. PCO rotates the refresh token on use, so
// letting concurrent requests each refresh causes a race that invalidates the token.
// A single-flight guard coalesces concurrent callers onto one refresh.
const PCO_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh if <10 min of life left
const pcoRefreshInFlight = new Map(); // `${userId}|${churchId}` -> Promise<tokens>

async function ensureValidPlanningCenterTokens(userId, churchId, tokens) {
  if (!tokens || !tokens.refresh_token) return tokens;
  const expiringSoon = tokens.expires_at && Date.now() >= (tokens.expires_at - PCO_TOKEN_REFRESH_MARGIN_MS);
  if (!expiringSoon) return tokens;

  const key = `${userId}|${churchId}`;
  if (pcoRefreshInFlight.has(key)) return pcoRefreshInFlight.get(key);

  const refreshPromise = (async () => {
    const fresh = await refreshPlanningCenterToken(tokens.refresh_token);
    if (!fresh || !fresh.access_token) {
      // Refresh failed (e.g. refresh token revoked) — return existing tokens so the
      // caller surfaces a clear 401/Not connected rather than crashing here.
      return tokens;
    }
    const saved = {
      ...tokens,
      ...fresh, // new access_token AND rotated refresh_token
      expires_at: Date.now() + ((fresh.expires_in || 7200) * 1000),
    };
    await savePlanningCenterTokens(userId, churchId, saved);
    return saved;
  })();

  pcoRefreshInFlight.set(key, refreshPromise);
  try { return await refreshPromise; }
  finally { pcoRefreshInFlight.delete(key); }
}

// Helper function to make authenticated Planning Center API requests
async function makePlanningCenterRequest(url, tokens, userId, churchId) {
  try {
    let accessToken = tokens.access_token;

    // Check if token needs refresh (if expires_at exists and is past)
    if (tokens.expires_at && Date.now() >= tokens.expires_at) {
      const newTokens = await refreshPlanningCenterToken(tokens.refresh_token);
      if (newTokens) {
        accessToken = newTokens.access_token;
        newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);
        // PCO ROTATES the refresh token on every refresh — persist the NEW one.
        // Keeping the old token (the previous bug) breaks the next refresh.
        if (!newTokens.refresh_token) newTokens.refresh_token = tokens.refresh_token;
        await savePlanningCenterTokens(userId, churchId, newTokens);
      }
    }

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
    const isEnabled = process.env.PLANNING_CENTER_ENABLED === 'true';

    if (!isEnabled) {
      return res.json({
        enabled: false,
        configured: false,
        connected: false,
        planningCenterAccount: null
      });
    }

    const userId = req.user.id;
    const churchId = req.user.church_id;

    const tokens = await getPlanningCenterTokens(userId, churchId);

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
        userId,
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

// Initiate OAuth flow
router.get('/planning-center/authorize', (req, res) => {
  const clientId = process.env.PLANNING_CENTER_CLIENT_ID;
  const redirectUri = process.env.PLANNING_CENTER_REDIRECT_URI;
  const scope = 'people check_ins'; // Request access to People and Check-ins

  console.log('🔐 Planning Center OAuth - redirect_uri:', redirectUri);

  // Optional post-OAuth redirect target. Only app-relative '/app/...' paths are
  // allowed (prevents open redirect). Falls back to Settings when absent/invalid.
  const rawReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const returnTo = /^\/app\//.test(rawReturnTo) ? rawReturnTo : '';

  // Generate state parameter for security (optional but recommended)
  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    churchId: req.user.church_id,
    timestamp: Date.now(),
    returnTo,
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
    let userId, churchId, returnTo;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
      churchId = stateData.churchId;
      returnTo = stateData.returnTo; // may be undefined for older flows
    } catch (e) {
      return res.status(400).send('Invalid state parameter');
    }

    // Exchange authorization code for access token
    const response = await makeHttpsRequest('https://api.planningcenteronline.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: {
        grant_type: 'authorization_code',
        code: code,
        client_id: process.env.PLANNING_CENTER_CLIENT_ID,
        client_secret: process.env.PLANNING_CENTER_CLIENT_SECRET,
        redirect_uri: process.env.PLANNING_CENTER_REDIRECT_URI
      }
    });

    if (response.status !== 200) {
      console.error('Planning Center OAuth error:', response.data);
      return res.status(500).send('Failed to obtain access token');
    }

    const tokens = response.data;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000); // Calculate expiration time

    // Save tokens to database
    await savePlanningCenterTokens(userId, churchId, tokens);

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
    const userId = req.user.id;
    const churchId = req.user.church_id;

    await Database.query(`
      DELETE FROM user_preferences
      WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?
    `, [userId, churchId]);

    res.json({ success: true, message: 'Planning Center disconnected successfully.' });
  } catch (error) {
    console.error('Disconnect Planning Center error:', error);
    res.status(500).json({ error: 'Failed to disconnect Planning Center.' });
  }
});

// Import people from Planning Center
// Browse people from Planning Center (without importing)
router.get('/planning-center/people', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;

    const tokens = await getPlanningCenterTokens(userId, churchId);

    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    // Fetch all people from Planning Center, including household and address data
    let allPeople = [];
    let allIncluded = [];
    let nextUrl = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,addresses';

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch people from Planning Center');
      }

      const data = response.data;
      allPeople = allPeople.concat(data.data || []);
      allIncluded = allIncluded.concat(data.included || []);
      nextUrl = data.links?.next || null;
    }

    // Build lookup maps from included resources
    const householdNames = {};
    const addressGroupKey = {}; // addressId -> normalized group key

    for (const item of allIncluded) {
      if (item.type === 'Household') {
        householdNames[item.id] = item.attributes.name;
      } else if (item.type === 'Address') {
        const street = (item.attributes.street || '').toLowerCase().trim();
        const zip = (item.attributes.zip || '').toLowerCase().trim();
        if (street) {
          addressGroupKey[item.id] = `addr_${street}_${zip}`;
        }
      }
    }

    // Group people: prefer household ID, fall back to address-based grouping
    const groups = {};
    for (const person of allPeople) {
      // PCO uses plural 'households' (has-many relationship)
      const householdData = person.relationships?.households?.data;
      let groupId = householdData?.[0]?.id || null;

      if (!groupId) {
        // Fall back to address-based grouping
        const addressData = person.relationships?.addresses?.data || [];
        const primaryAddr = addressData.find(a => {
          const inc = allIncluded.find(i => i.id === a.id && i.type === 'Address');
          return inc?.attributes?.primary;
        }) || addressData[0];

        groupId = (primaryAddr && addressGroupKey[primaryAddr.id]) || `individual_${person.id}`;
      }

      if (!groups[groupId]) {
        groups[groupId] = { householdName: householdNames[groupId] || null, members: [] };
      }
      groups[groupId].members.push(person);
    }

    // Format response
    const families = Object.entries(groups).map(([groupId, { householdName, members }]) => {
      // Build LMPG-style name: "Lastname, Firstname and Firstname" using adults (non-children) first
      const adults = members.filter(m => !m.attributes.child);
      const nameMembers = adults.length > 0 ? adults : members;
      const lastName = nameMembers[0]?.attributes.last_name || 'Unknown';
      const firstNames = nameMembers.map(m => m.attributes.first_name).filter(Boolean);
      const familyName = firstNames.length > 0
        ? `${lastName}, ${firstNames.join(' and ')}`
        : lastName;

      return {
        householdId: groupId,
        familyName,
        members: members.map(m => ({
          id: m.id,
          firstName: m.attributes.first_name || '',
          lastName: m.attributes.last_name || '',
          email: m.attributes.emails?.[0] || null,
          phone: m.attributes.phone_numbers?.[0] || null,
          birthdate: m.attributes.birthdate || null,
          child: m.attributes.child || false,
          status: m.attributes.status || null,
          avatar: m.attributes.avatar || null,
        }))
      };
    });

    // Check which families already exist in the local database
    const localFamilies = await Database.query(
      `SELECT id, family_name, planning_center_id FROM families WHERE church_id = ?`,
      [churchId]
    );
    const localPcIds = new Set(localFamilies.map(f => f.planning_center_id).filter(Boolean));
    const localFamilyNames = localFamilies.map(f => f.family_name);
    let alreadyImportedCount = 0;
    for (const family of families) {
      // Prefer exact PCO ID match, fall back to name matching
      const matchedLocal = localPcIds.has(family.householdId)
        ? localFamilies.find(lf => lf.planning_center_id === family.householdId)
        : localFamilies.find(lf => namesMatch(family.familyName, lf.family_name));
      family.alreadyImported = !!matchedLocal;
      if (family.alreadyImported) {
        alreadyImportedCount++;
        // Backfill planning_center_id for families imported before this feature
        if (matchedLocal && !matchedLocal.planning_center_id) {
          Database.query(
            `UPDATE families SET planning_center_id = ? WHERE id = ? AND church_id = ?`,
            [family.householdId, matchedLocal.id, churchId]
          ).catch(e => logger.warn(`Failed to backfill planning_center_id: ${e.message}`));
        }
      }
    }

    res.json({
      success: true,
      totalPeople: allPeople.length,
      totalFamilies: families.length,
      alreadyImportedCount,
      families
    });
  } catch (error) {
    console.error('Browse Planning Center people error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch people from Planning Center.',
      details: error.message
    });
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

// Browse check-ins from Planning Center (without importing)
router.get('/planning-center/checkins', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { startDate, endDate } = req.query;

    const tokens = await getPlanningCenterTokens(userId, churchId);

    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required.' });
    }

    // Reuse the shared fetch: it buffers the created_at window and includes
    // event_period so we can show the real service date (starts_at), not the
    // data-entry date. See fetchAllCheckins / normalizeCheckIns.
    const force = req.query.refresh === '1';
    const { payload } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate, force });
    const { data: allCheckIns, included } = payload;

    // Build lookup maps for included resources
    const people = {};
    const events = {};
    const periodStartsAt = {};
    for (const item of included) {
      if (item.type === 'Person') {
        people[item.id] = {
          id: item.id,
          name: item.attributes.name || `${item.attributes.first_name || ''} ${item.attributes.last_name || ''}`.trim(),
        };
      } else if (item.type === 'Event') {
        events[item.id] = {
          id: item.id,
          name: item.attributes.name || 'Unknown Event',
        };
      } else if (item.type === 'EventPeriod') {
        periodStartsAt[item.id] = item.attributes.starts_at || null;
      }
    }

    // Format check-ins, dating each by its EventPeriod (the actual service), and
    // keep only those whose service date falls in the requested range.
    const checkIns = allCheckIns.map(ci => {
      const personId = ci.relationships?.person?.data?.id;
      const eventId = ci.relationships?.event?.data?.id;
      const periodId = ci.relationships?.event_period?.data?.id;
      const startsAt = periodId ? periodStartsAt[periodId] : null;

      return {
        id: ci.id,
        checkedInAt: startsAt || ci.attributes.created_at,
        date: startsAt ? startsAt.slice(0, 10) : null,
        kind: ci.attributes.kind,
        person: personId ? people[personId] : null,
        event: eventId ? events[eventId] : null,
      };
    }).filter((c) => c.date && c.date >= startDate && c.date <= endDate);

    res.json({
      success: true,
      totalCheckIns: checkIns.length,
      checkIns
    });
  } catch (error) {
    console.error('Browse Planning Center check-ins error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch check-ins from Planning Center.',
      details: error.message
    });
  }
});

// List distinct PCO events that have check-ins in range (for the mapping screen).
router.get('/planning-center/checkins/events', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { startDate, endDate } = resolveRange(req.query.startDate, req.query.endDate);

    const tokens = await getPlanningCenterTokens(userId, churchId);
    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    const force = req.query.refresh === '1';
    const onProgress = makeImportProgressEmitter(churchId, req.query.jobId, 'fetching');
    const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate, force, onProgress });
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

router.post('/planning-center/link-family', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const { householdId, familyId } = req.body;

    if (!householdId || !familyId) {
      return res.status(400).json({ error: 'householdId and familyId are required.' });
    }

    const result = await Database.query(
      `UPDATE families SET planning_center_id = ? WHERE id = ? AND church_id = ?`,
      [householdId, familyId, churchId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Family not found.' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Link Planning Center family error:', error);
    res.status(500).json({ error: 'Failed to link family.' });
  }
});

router.post('/planning-center/import-people', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;

    const tokens = await getPlanningCenterTokens(userId, churchId);

    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    logger.info('Starting Planning Center people import', { userId, churchId });

    const importedFamilies = [];
    const importedIndividuals = [];
    const errors = [];

    // Optional: only import specific households
    const { householdIds } = req.body; // array of householdId strings, or undefined = import all

    // Fetch all people from Planning Center (same logic as browse endpoint)
    let allPeople = [];
    let allIncluded = [];
    let nextUrl = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,addresses';

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch people from Planning Center');
      }

      const data = response.data;
      allPeople = allPeople.concat(data.data || []);
      allIncluded = allIncluded.concat(data.included || []);
      nextUrl = data.links?.next || null;

      logger.info(`Fetched ${allPeople.length} people so far...`);
    }

    logger.info(`Total people fetched: ${allPeople.length}`);

    // Build address lookup (same as browse endpoint)
    const addressGroupKey = {};
    for (const item of allIncluded) {
      if (item.type === 'Address') {
        const street = (item.attributes.street || '').toLowerCase().trim();
        const zip = (item.attributes.zip || '').toLowerCase().trim();
        if (street) addressGroupKey[item.id] = `addr_${street}_${zip}`;
      }
    }

    // Group people by household with address fallback
    const households = {};
    for (const person of allPeople) {
      const householdData = person.relationships?.households?.data;
      let groupId = householdData?.[0]?.id || null;
      if (!groupId) {
        const addressData = person.relationships?.addresses?.data || [];
        const primaryAddr = addressData.find(a => {
          const inc = allIncluded.find(i => i.id === a.id && i.type === 'Address');
          return inc?.attributes?.primary;
        }) || addressData[0];
        groupId = (primaryAddr && addressGroupKey[primaryAddr.id]) || `individual_${person.id}`;
      }
      if (!households[groupId]) households[groupId] = [];
      households[groupId].push(person);
    }

    logger.info(`Grouped into ${Object.keys(households).length} households`);

    // Load existing family names for duplicate detection
    const localFamilies = await Database.query(
      `SELECT id, family_name, planning_center_id FROM families WHERE church_id = ?`,
      [churchId]
    );
    const localFamilyNames = localFamilies.map(f => f.family_name);

    // Process each household
    for (const [householdId, members] of Object.entries(households)) {
      // Skip if caller specified a subset and this isn't in it
      if (householdIds && householdIds.length > 0 && !householdIds.includes(householdId)) continue;

      try {
        // Build LMPG-style family name
        const adults = members.filter(m => !m.attributes.child);
        const nameMembers = adults.length > 0 ? adults : members;
        const lastName = nameMembers[0]?.attributes.last_name || 'Unknown';
        const firstNames = nameMembers.map(m => m.attributes.first_name).filter(Boolean);
        const familyName = firstNames.length > 0
          ? `${lastName}, ${firstNames.join(' and ')}`
          : lastName;

        // Skip families that already exist, but backfill planning_center_id if missing
        const matchedFamily = localFamilies.find(lf => namesMatch(familyName, lf.family_name));
        if (matchedFamily) {
          logger.info(`Skipping already-imported family: ${familyName}`);
          if (!matchedFamily.planning_center_id) {
            await Database.query(
              `UPDATE families SET planning_center_id = ? WHERE id = ? AND church_id = ?`,
              [householdId, matchedFamily.id, churchId]
            );
            logger.info(`Backfilled planning_center_id for family: ${familyName}`);
          }
          continue;
        }

        // Create family, storing the PCO household ID for sync tracking
        const familyResult = await Database.query(`
          INSERT INTO families (church_id, family_name, planning_center_id, created_by, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `, [churchId, familyName, householdId, userId]);

        const familyId = familyResult.insertId;
        importedFamilies.push({ id: familyId, name: familyName });

        // Sort members: adults first, then children
        const children = members.filter(m => m.attributes.child === true);
        const sortedMembers = [...adults, ...children];

        // Create individuals
        for (let i = 0; i < sortedMembers.length; i++) {
          const person = sortedMembers[i];
          const attrs = person.attributes;

          const isChild = attrs.child === true ? 1 : 0;

          const individualResult = await Database.query(`
            INSERT INTO individuals
            (church_id, family_id, first_name, last_name,
             people_type, is_child, is_active, created_by, created_at, planning_center_id)
            VALUES (?, ?, ?, ?, 'regular', ?, 1, ?, datetime('now'), ?)
          `, [
            churchId,
            familyId,
            attrs.first_name || '',
            attrs.last_name || '',
            isChild,
            userId,
            person.id  // PCO person ID
          ]);

          importedIndividuals.push({
            id: individualResult.insertId,
            name: `${attrs.first_name} ${attrs.last_name}`
          });
        }
      } catch (error) {
        logger.error(`Error importing household ${householdId}:`, error);
        errors.push({
          household: householdId,
          error: error.message
        });
      }
    }

    logger.info('Planning Center people import completed', {
      userId,
      churchId,
      familiesImported: importedFamilies.length,
      individualsImported: importedIndividuals.length,
      errors: errors.length
    });

    res.json({
      success: true,
      message: `Imported ${importedFamilies.length} families and ${importedIndividuals.length} people from Planning Center.`,
      imported: {
        families: importedFamilies.length,
        individuals: importedIndividuals.length
      },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Import Planning Center people error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import people from Planning Center.',
      details: error.message
    });
  }
});

// Read sync config (allow-list + enabled flag)
router.get('/planning-center/membership-filter', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const rows = await Database.query(
      `SELECT planning_center_sync_enabled AS enabled, planning_center_membership_allowlist AS allowlist
         FROM church_settings WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    let allowlist = [];
    if (rows.length && rows[0].allowlist) { try { allowlist = JSON.parse(rows[0].allowlist); } catch (_) {} }
    res.json({ enabled: !!(rows.length && rows[0].enabled), allowlist });
  } catch (error) {
    logger.error('Get PCO membership filter error:', error);
    res.status(500).json({ error: 'Failed to read sync config.' });
  }
});

// Write sync config
router.put('/planning-center/membership-filter', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const { enabled, allowlist } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' });
    if (!Array.isArray(allowlist) || !allowlist.every((v) => typeof v === 'string')) {
      return res.status(400).json({ error: 'allowlist must be an array of strings.' });
    }
    await Database.query(
      `UPDATE church_settings
          SET planning_center_sync_enabled = ?, planning_center_membership_allowlist = ?,
              planning_center_auto_archive = 0
        WHERE church_id = ?`,
      [enabled ? 1 : 0, JSON.stringify(allowlist), churchId]
    );
    res.json({ success: true, enabled: !!enabled, allowlist });
  } catch (error) {
    logger.error('Set PCO membership filter error:', error);
    res.status(500).json({ error: 'Failed to save sync config.' });
  }
});

// Dry-run: compute the reconcile plan without writing anything
router.get('/planning-center/sync/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    // The "Refresh from Planning Center" button sends ?refresh=1 to bypass the cache.
    const force = req.query.refresh === '1' || req.query.force === '1';
    const plan = await pcoSync.computePlanForChurch(churchId, accessToken, { force });
    res.json({
      success: true,
      summary: {
        link: plan.link.length,
        restore: (plan.restore || []).length,
        ambiguous: plan.ambiguous.length,
        visitorMatches: (plan.visitorMatches || []).length,
        archiveExtras: (plan.archiveExtras || []).length,
        unmatchedVisitors: (plan.unmatchedVisitors || []).length,
        add: plan.add.length,
        update: plan.update.length,
        archive: plan.archive.length,
        reactivate: plan.reactivate.length,
      },
      plan,
    });
  } catch (error) {
    logger.error('PCO sync plan error:', error);
    res.status(500).json({ error: 'Failed to compute sync plan.' });
  }
});

// Membership distribution for the allow-list editor (person counts only, no check-ins)
router.get('/planning-center/membership-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const { people } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    res.json({ success: true, ...tallyMembership(people) });
  } catch (error) {
    logger.error('PCO membership summary error:', error);
    res.status(500).json({ error: 'Failed to load membership summary.' });
  }
});

// Apply: recompute the plan and apply it. Body may include { selections } for review choices.
// With no selections, applies everything except ambiguous (auto mode).
router.post('/planning-center/sync/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computePlanForChurch(churchId, accessToken);

    // Sanitize caller selections against the freshly-computed plan so a client can only:
    //  - resolve an ambiguous individual to one of ITS offered candidate pcoIds
    //  - opt out of pcoIds that are actually in the add bucket
    const rawSel = (req.body && req.body.selections) || {};
    const candidatesByIndividual = new Map(
      plan.ambiguous.map((a) => [a.individualId, new Set(a.candidates)])
    );
    const ambiguous = {};
    for (const [individualId, pcoId] of Object.entries(rawSel.ambiguous || {})) {
      const allowed = candidatesByIndividual.get(Number(individualId));
      if (allowed && pcoId && allowed.has(pcoId)) ambiguous[individualId] = pcoId;
    }
    const addPcoIds = new Set(plan.add.map((a) => a.pcoId));
    const skipAddPcoIds = (Array.isArray(rawSel.skipAddPcoIds) ? rawSel.skipAddPcoIds : [])
      .filter((id) => addPcoIds.has(id));
    // Same shape, individualIds — only honour ids actually in the archiveExtras bucket.
    const extraIds = new Set((plan.archiveExtras || []).map((x) => Number(x.individualId)));
    const skipArchiveExtraIds = (Array.isArray(rawSel.skipArchiveExtraIds) ? rawSel.skipArchiveExtraIds : [])
      .map(Number)
      .filter((id) => extraIds.has(id));
    // Visitor decisions: only honour ids actually in the visitorMatches bucket and valid choices.
    const visitorOfferIds = new Set((plan.visitorMatches || []).map((v) => Number(v.individualId)));
    const visitorChoices = {};
    for (const [rawId, choice] of Object.entries(rawSel.visitorChoices || {})) {
      const id = Number(rawId);
      if (visitorOfferIds.has(id) && (choice === 'promote' || choice === 'keep')) {
        visitorChoices[id] = choice;
      }
    }
    const selections = { ambiguous, skipAddPcoIds, skipArchiveExtraIds, visitorChoices };

    const result = await pcoSync.applyForChurch(churchId, plan, userId, selections);

    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      archiveExtras: (plan.archiveExtras || []).length,
      unmatchedVisitors: (plan.unmatchedVisitors || []).length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_last_sync = datetime('now'),
              planning_center_last_sync_archived = ?,
              planning_center_last_sync_result = ?
        WHERE church_id = ?`,
      [result.archived, JSON.stringify(summary), churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO sync apply error:', error);
    res.status(500).json({ error: 'Failed to apply sync.' });
  }
});

// Import check-ins from Planning Center
// Shared core: fetch, normalize, resolve people, and (optionally) write.
async function runCheckinImport({ req, commit }) {
  const userId = req.user.id;
  const churchId = req.user.church_id;
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

  const tokens = await getPlanningCenterTokens(userId, churchId);
  if (!tokens || !tokens.access_token) {
    const err = new Error('Planning Center not connected.');
    err.statusCode = 400;
    throw err;
  }

  const onProgress = makeImportProgressEmitter(churchId, jobId, 'fetching');
  const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate, onProgress });
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
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Execute — writes inside a transaction.
router.post('/planning-center/import-checkins/execute', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in execute error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// ─── Historical CSV Attendance Backfill ─────────────────────────────────────

const csvUpload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function parseDateHeader(str) {
  // "9-Feb-25" → "2025-02-09"
  const [day, mon, yr] = str.trim().split('-');
  if (!day || !mon || !yr || !MONTH_MAP[mon]) return null;
  return `20${yr}-${MONTH_MAP[mon]}-${day.padStart(2, '0')}`;
}

function isDateHeader(str) {
  return /^\d{1,2}-[A-Z][a-z]{2}-\d{2}$/.test(str.trim());
}

async function parseHistoricalCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

async function matchAndBuildRecords(rows, churchId) {
  // Extract date column names from first row keys
  const firstRow = rows[0] || {};
  const dateHeaders = Object.keys(firstRow).filter(isDateHeader);

  // Load all individuals for this church once
  const individuals = await Database.query(
    `SELECT id, first_name, last_name, people_type FROM individuals WHERE church_id = ?`,
    [churchId]
  );
  // Build lookup: "firstname lastname" → individual
  const nameMap = new Map();
  for (const ind of individuals) {
    const key = `${ind.first_name.trim().toLowerCase()} ${ind.last_name.trim().toLowerCase()}`;
    nameMap.set(key, ind);
  }

  // Load all gathering assignments for Sunday gatherings
  const sundayGatherings = await Database.query(
    `SELECT gl.individual_id, gt.id AS gathering_type_id, gt.name AS gathering_name
     FROM gathering_lists gl
     JOIN gathering_types gt ON gl.gathering_type_id = gt.id
     WHERE gl.church_id = ? AND gt.day_of_week = 'Sunday' AND gt.attendance_type = 'standard'`,
    [churchId]
  );
  // Build map: individual_id → [{ gathering_type_id, gathering_name }]
  const gatheringMap = new Map();
  for (const row of sundayGatherings) {
    if (!gatheringMap.has(row.individual_id)) gatheringMap.set(row.individual_id, []);
    gatheringMap.get(row.individual_id).push({ id: row.gathering_type_id, name: row.gathering_name });
  }

  const matched = [];
  const unmatched = [];
  const noGatherings = [];

  for (const row of rows) {
    const firstName = (row['First Name'] || '').trim();
    const lastName = (row['Last Name'] || '').trim();
    if (!firstName && !lastName) continue;

    const key = `${firstName.toLowerCase()} ${lastName.toLowerCase()}`;
    const individual = nameMap.get(key);

    if (!individual) {
      unmatched.push({ firstName, lastName, reason: 'No exact match in database' });
      continue;
    }

    const gatherings = gatheringMap.get(individual.id) || [];
    if (gatherings.length === 0) {
      noGatherings.push({ firstName, lastName, individualId: individual.id, reason: 'Not assigned to any Sunday gathering' });
      continue;
    }

    // Build attendance entries per date
    const entries = [];
    let trueCount = 0;
    let falseCount = 0;
    for (const header of dateHeaders) {
      const dateStr = parseDateHeader(header);
      if (!dateStr) continue;
      const present = (row[header] || '').trim().toUpperCase() === 'TRUE' ? 1 : 0;
      if (present) trueCount++; else falseCount++;
      entries.push({ date: dateStr, present });
    }

    matched.push({
      firstName,
      lastName,
      individualId: individual.id,
      peopleType: individual.people_type,
      gatherings,
      entries,
      trueCount,
      falseCount
    });
  }

  return { dateHeaders, matched, unmatched, noGatherings };
}

// Preview — no DB writes
router.post('/historical-csv-preview',
  verifyToken,
  csvUpload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });
    const filePath = req.file.path;
    try {
      const rows = await parseHistoricalCsv(filePath);
      if (!rows.length) return res.status(400).json({ error: 'CSV file is empty.' });

      const { dateHeaders, matched, unmatched, noGatherings } = await matchAndBuildRecords(rows, req.user.church_id);

      const dates = dateHeaders.map(parseDateHeader).filter(Boolean);
      const previewMatched = matched.map(m => ({
        name: `${m.firstName} ${m.lastName}`,
        individualId: m.individualId,
        gatherings: m.gatherings,
        trueCount: m.trueCount,
        falseCount: m.falseCount
      }));

      res.json({
        dates,
        dateCount: dates.length,
        matched: previewMatched,
        unmatched,
        noGatherings
      });
    } catch (err) {
      logger.error('Historical CSV preview error:', err);
      res.status(500).json({ error: 'Failed to parse CSV.', details: err.message });
    } finally {
      fs.unlink(filePath, () => {});
    }
  }
);

// Execute — writes attendance records
router.post('/historical-csv-execute',
  verifyToken,
  csvUpload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });
    const filePath = req.file.path;
    try {
      const rows = await parseHistoricalCsv(filePath);
      if (!rows.length) return res.status(400).json({ error: 'CSV file is empty.' });

      const { matched, unmatched, noGatherings } = await matchAndBuildRecords(rows, req.user.church_id);

      let sessionsCreated = 0;
      let recordsWritten = 0;

      await Database.transaction(async (conn) => {
        for (const person of matched) {
          for (const entry of person.entries) {
            for (const gathering of person.gatherings) {
              // Upsert attendance session
              const existing = await conn.query(
                `SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
                [gathering.id, entry.date, req.user.church_id]
              );
              let sessionId;
              if (existing.length > 0) {
                sessionId = existing[0].id;
              } else {
                const ins = await conn.query(
                  `INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (?, ?, ?, ?)`,
                  [gathering.id, entry.date, req.user.id, req.user.church_id]
                );
                sessionId = ins.insertId;
                sessionsCreated++;
              }

              // Upsert attendance record
              await conn.query(
                `INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(session_id, individual_id) DO UPDATE SET
                   present = excluded.present,
                   people_type_at_time = excluded.people_type_at_time,
                   updated_at = CURRENT_TIMESTAMP`,
                [sessionId, person.individualId, entry.present, req.user.church_id, person.peopleType]
              );
              recordsWritten++;
            }
          }

          // Update last_attendance_date to latest TRUE date
          if (person.trueCount > 0) {
            const latestPresent = person.entries
              .filter(e => e.present)
              .map(e => e.date)
              .sort()
              .pop();
            if (latestPresent) {
              await conn.query(
                `UPDATE individuals SET last_attendance_date = ?
                 WHERE id = ? AND church_id = ?
                   AND (last_attendance_date IS NULL OR last_attendance_date < ?)`,
                [latestPresent, person.individualId, req.user.church_id, latestPresent]
              );
            }
          }
        }
      });

      res.json({
        success: true,
        sessionsCreated,
        recordsWritten,
        matchedCount: matched.length,
        unmatched,
        noGatherings
      });
    } catch (err) {
      logger.error('Historical CSV execute error:', err);
      res.status(500).json({ error: 'Failed to import attendance.', details: err.message });
    } finally {
      fs.unlink(filePath, () => {});
    }
  }
);

module.exports = router;
