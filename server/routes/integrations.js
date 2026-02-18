const express = require('express');
const https = require('https');
const Database = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const logger = require('../config/logger');

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
          resolve({ status: res.statusCode, data: parsedData });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
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
  
  // Check if one contains the other (for partial matches)
  if (n1.includes(n2) || n2.includes(n1)) return true;
  
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
      ON DUPLICATE KEY UPDATE
        preference_value = VALUES(preference_value),
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

        const gatheringInsertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
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

        const gatheringInsertId = Array.isArray(result) ? result[0]?.insertId : result?.insertId;
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
                VALUES (?, ?, NOW(), NOW())
              `, [familyName, req.user.church_id]);

              const familyInsertId = Array.isArray(familyResult) ? familyResult[0]?.insertId : familyResult?.insertId;
              if (!familyInsertId) {
                errors.push(`Failed to create family for person ${personId}: no insertId returned`);
                console.error(`Family insert result:`, familyResult);
                continue;
              }

              const individualResult = await Database.query(`
                INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id, created_at, updated_at)
                VALUES (?, ?, ?, 'regular', ?, NOW(), NOW())
              `, [person.firstname, person.lastname, familyInsertId, req.user.church_id]);

              const individualInsertId = Array.isArray(individualResult) ? individualResult[0]?.insertId : individualResult?.insertId;
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
                VALUES (?, ?, NOW(), NOW())
              `, [familyName, req.user.church_id]);

              // MariaDB returns an object with insertId for INSERT queries, not an array
              const localFamilyId = Array.isArray(familyResult) ? familyResult[0]?.insertId : familyResult?.insertId;
              
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
                    VALUES (?, ?, ?, 'regular', ?, NOW(), NOW())
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
              VALUES (?, ?, NOW(), NOW())
            `, [familyName, req.user.church_id]);
          } catch (dbErr) {
            errors.push(`Failed to create family for person ${personId} (${person.firstname} ${person.lastname}): ${dbErr.message}`);
            console.error(`Database error creating family for person ${personId}:`, dbErr);
            continue;
          }

          const familyInsertId = Array.isArray(familyResult) ? familyResult[0]?.insertId : familyResult?.insertId;
          if (!familyInsertId) {
            errors.push(`Failed to create family for person ${personId}: no insertId returned`);
            console.error(`Family insert result:`, familyResult);
            continue;
          }

          let individualResult;
          try {
            individualResult = await Database.query(`
              INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id, created_at, updated_at)
              VALUES (?, ?, ?, 'regular', ?, NOW(), NOW())
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

          const individualInsertId = Array.isArray(individualResult) ? individualResult[0]?.insertId : individualResult?.insertId;
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

// Helper function to make authenticated Planning Center API requests
async function makePlanningCenterRequest(url, tokens, userId, churchId) {
  try {
    let accessToken = tokens.access_token;

    // Check if token needs refresh (if expires_at exists and is past)
    if (tokens.expires_at && Date.now() >= tokens.expires_at) {
      const newTokens = await refreshPlanningCenterToken(tokens.refresh_token);
      if (newTokens) {
        accessToken = newTokens.access_token;
        // Save new tokens
        newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);
        newTokens.refresh_token = tokens.refresh_token; // Keep original refresh token
        await savePlanningCenterTokens(userId, churchId, newTokens);
      }
    }

    const response = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    return response;
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
        return res.json({
          enabled: true,
          configured: true,
          connected: true,
          planningCenterAccount: accountName
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

  // Generate state parameter for security (optional but recommended)
  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    churchId: req.user.church_id,
    timestamp: Date.now()
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
    let userId, churchId;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
      churchId = stateData.churchId;
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

    // Redirect to settings page with success message
    res.redirect('/app/settings?tab=integrations&pco_success=true');
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

    // Fetch all people from Planning Center
    let allPeople = [];
    let nextUrl = 'https://api.planningcenteronline.com/people/v2/people?per_page=100';

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch people from Planning Center');
      }

      const data = response.data;
      allPeople = allPeople.concat(data.data || []);
      nextUrl = data.links?.next || null;
    }

    // Group people by household
    const households = {};
    for (const person of allPeople) {
      const householdId = person.relationships?.household?.data?.id || `individual_${person.id}`;

      if (!households[householdId]) {
        households[householdId] = [];
      }
      households[householdId].push(person);
    }

    // Format response
    const families = Object.entries(households).map(([householdId, members]) => {
      const lastNames = [...new Set(members.map(m => m.attributes.last_name).filter(Boolean))];
      const familyName = lastNames.length === 1
        ? `${lastNames[0]} Family`
        : lastNames.length === 2
        ? `${lastNames[0]} & ${lastNames[1]}`
        : lastNames.length > 0
        ? `${lastNames[0]} Family`
        : 'Unknown Family';

      return {
        householdId,
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

    res.json({
      success: true,
      totalPeople: allPeople.length,
      totalFamilies: families.length,
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

    let url = `https://api.planningcenteronline.com/check-ins/v2/check_ins?` +
      `filter=checked_in_at&where[checked_in_at][gte]=${startDate}&where[checked_in_at][lte]=${endDate}&` +
      `per_page=100&include=event,person`;

    let allCheckIns = [];
    let included = [];
    let nextUrl = url;

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch check-ins from Planning Center');
      }

      const data = response.data;
      allCheckIns = allCheckIns.concat(data.data || []);
      included = included.concat(data.included || []);
      nextUrl = data.links?.next || null;
    }

    // Build lookup maps for included resources
    const people = {};
    const events = {};
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
      }
    }

    // Format check-ins
    const checkIns = allCheckIns.map(ci => {
      const personId = ci.relationships?.person?.data?.id;
      const eventId = ci.relationships?.event?.data?.id;

      return {
        id: ci.id,
        checkedInAt: ci.attributes.checked_in_at,
        kind: ci.attributes.kind,
        person: personId ? people[personId] : null,
        event: eventId ? events[eventId] : null,
      };
    });

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

    // Fetch all people from Planning Center
    let allPeople = [];
    let nextUrl = 'https://api.planningcenteronline.com/people/v2/people?per_page=100';

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch people from Planning Center');
      }

      const data = response.data;
      allPeople = allPeople.concat(data.data || []);

      // Check for next page
      nextUrl = data.links?.next || null;

      logger.info(`Fetched ${allPeople.length} people so far...`);
    }

    logger.info(`Total people fetched: ${allPeople.length}`);

    // Group people by household (family)
    const households = {};
    for (const person of allPeople) {
      const householdId = person.relationships?.household?.data?.id || `individual_${person.id}`;

      if (!households[householdId]) {
        households[householdId] = [];
      }

      households[householdId].push(person);
    }

    logger.info(`Grouped into ${Object.keys(households).length} households`);

    // Process each household
    for (const [householdId, members] of Object.entries(households)) {
      try {
        // Determine family name
        const lastNames = [...new Set(members.map(m => m.attributes.last_name).filter(Boolean))];
        const familyName = lastNames.length === 1
          ? `${lastNames[0]} Family`
          : lastNames.length === 2
          ? `${lastNames[0]} & ${lastNames[1]}`
          : lastNames.length > 0
          ? `${lastNames[0]} Family`
          : 'Unknown Family';

        // Create family
        const familyResult = await Database.query(`
          INSERT INTO families (church_id, family_name, created_by, created_at)
          VALUES (?, ?, ?, NOW())
        `, [churchId, familyName, userId]);

        const familyId = familyResult.insertId;
        importedFamilies.push({ id: familyId, name: familyName });

        // Sort members to identify main contacts (adults first)
        const adults = members.filter(m => m.attributes.child === false);
        const children = members.filter(m => m.attributes.child === true);
        const sortedMembers = [...adults, ...children];

        // Create individuals
        for (let i = 0; i < sortedMembers.length; i++) {
          const person = sortedMembers[i];
          const attrs = person.attributes;

          const isMainContact1 = i === 0; // First adult is MC1
          const isMainContact2 = i === 1 && adults.length >= 2; // Second adult is MC2

          const individualResult = await Database.query(`
            INSERT INTO individuals
            (church_id, family_id, first_name, last_name, email, mobile, date_of_birth,
             people_type, is_main_contact_1, is_main_contact_2, is_active, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', ?, ?, true, ?, NOW())
          `, [
            churchId,
            familyId,
            attrs.first_name || '',
            attrs.last_name || '',
            attrs.emails?.[0] || null,
            attrs.phone_numbers?.[0] || null,
            attrs.birthdate || null,
            isMainContact1,
            isMainContact2,
            userId
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

// Import check-ins from Planning Center
router.post('/planning-center/import-checkins', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { startDate, endDate, eventId } = req.body;

    const tokens = await getPlanningCenterTokens(userId, churchId);

    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required.' });
    }

    logger.info('Starting Planning Center check-ins import', {
      userId,
      churchId,
      startDate,
      endDate,
      eventId
    });

    // Fetch check-ins from Planning Center
    let url = `https://api.planningcenteronline.com/check-ins/v2/check_ins?` +
      `filter=checked_in_at&where[checked_in_at][gte]=${startDate}&where[checked_in_at][lte]=${endDate}&` +
      `per_page=100&include=event,person`;

    if (eventId) {
      url += `&where[event_id]=${eventId}`;
    }

    let allCheckIns = [];
    let nextUrl = url;

    while (nextUrl) {
      const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);

      if (response.status !== 200) {
        throw new Error('Failed to fetch check-ins from Planning Center');
      }

      const data = response.data;
      allCheckIns = allCheckIns.concat(data.data || []);

      nextUrl = data.links?.next || null;

      logger.info(`Fetched ${allCheckIns.length} check-ins so far...`);
    }

    logger.info(`Total check-ins fetched: ${allCheckIns.length}`);

    // TODO: Map check-ins to gatherings and create attendance records
    // This requires mapping Planning Center events to your gathering_types
    // and Planning Center people to your individuals table

    res.json({
      success: true,
      message: `Fetched ${allCheckIns.length} check-ins from Planning Center.`,
      checkIns: allCheckIns.length,
      note: 'Check-in mapping to attendance records is not yet implemented. Manual mapping required.'
    });
  } catch (error) {
    console.error('Import Planning Center check-ins error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import check-ins from Planning Center.',
      details: error.message
    });
  }
});

module.exports = router;
