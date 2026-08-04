const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const http = require('http');
require('dotenv').config({ quiet: true });

// Import Winston logger with error handling
let logger;
try {
  logger = require('./config/logger');
} catch (error) {
  console.error('Failed to load logger, using console fallback:', error.message);
  // Fallback logger
  logger = {
    info: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.log,
    createRequestLogger: () => (req, res, next) => next()
  };
}

// Import database initialization
let initializeDatabase;
try {
  const startup = require('./startup');
  initializeDatabase = startup.initializeDatabase;
} catch (error) {
  console.error('Failed to load startup module:', error.message);
  initializeDatabase = async () => {
    console.log('Database initialization skipped due to startup module error');
  };
}

// Import security middleware with fallbacks
let sanitizeInput, detectSQLInjection, createSecurityRateLimit;
try {
  const security = require('./middleware/security');
  sanitizeInput = security.sanitizeInput;
  detectSQLInjection = security.detectSQLInjection;
  createSecurityRateLimit = security.createSecurityRateLimit;
} catch (error) {
  console.error('Failed to load security middleware, using fallbacks:', error.message);
  // Fallback middleware
  sanitizeInput = (req, res, next) => next();
  detectSQLInjection = (req, res, next) => next();
  createSecurityRateLimit = () => (req, res, next) => next();
}

// Import routes with error handling
const loadRoutes = () => {
  const routes = {};
  const routeFiles = [
    'auth', 'users', 'gatherings', 'families', 'individuals',
    'attendance', 'reports', 'notifications', 'onboarding',
    'invitations', 'csv-import', 'people-imports', 'test',
    'notification_rules', 'contacts',
    // 'importrange', // Disabled - external data access feature
    'settings', 'activities', 'visitor-config', 'integrations', 'ai', 'kiosk', 'takeout'
  ];

  // Check external service availability (Crazytel for SMS, Brevo for Email)
  const externalServices = {
    crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
    brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
  };

  // Log service status
  console.log('🔧 External Services Status:');
  console.log(`   📱 Crazytel SMS: ${externalServices.crazytel ? '✅ Available' : '❌ Not configured'}`);
  console.log(`   📧 Brevo Email: ${externalServices.brevo ? '✅ Available' : '❌ Not configured'}`);
  
  if (!externalServices.brevo) {
    console.log('⚠️  WARNING: No external services configured. Authentication will be limited to development mode.');
  }

  routeFiles.forEach(routeName => {
    try {
      routes[routeName] = require(`./routes/${routeName}`);
      console.log(`✅ Loaded route: ${routeName}`);
    } catch (error) {
      console.warn(`⚠️  Failed to load route ${routeName}:`, error.message);
      
      // Create a fallback route with service status information
      const express = require('express');
      const router = express.Router();
      
      router.get('/', (req, res) => {
        res.status(503).json({ 
          error: 'Service temporarily unavailable',
          message: `${routeName} route is not available`,
          reason: error.message,
          externalServices: externalServices,
          note: 'Configure external services (Twilio/Brevo) to enable full functionality'
        });
      });
      
      // Add a status endpoint to check service availability
      router.get('/status', (req, res) => {
        res.json({
          service: routeName,
          status: 'disabled',
          reason: error.message,
          externalServices: externalServices,
          availableFeatures: {
            development: process.env.NODE_ENV === 'development',
            database: true,
            basicAuth: routeName === 'auth' && process.env.NODE_ENV === 'development'
          }
        });
      });
      
      routes[routeName] = router;
    }
  });

  return routes;
};

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Import WebSocket service
let webSocketService;
try {
  webSocketService = require('./services/websocket');
} catch (error) {
  console.warn('Failed to load WebSocket service:', error.message);
  // Create fallback service
  webSocketService = {
    initialize: () => console.log('WebSocket service disabled'),
    broadcastAttendanceUpdate: () => {},
    broadcastVisitorUpdate: () => {},
    getStats: () => ({ disabled: true }),
    shutdown: () => {}
  };
}

// Trust proxy (client nginx sets X-Forwarded-For)
app.set('trust proxy', 1);

// Use extended query parser (qs) so bracket notation like ?ids[]=1&ids[]=2 is
// parsed into arrays. Express 5 defaults to the simple parser which does not
// support this.
app.set('query parser', 'extended');

// Validate required environment variables
const validateEnvironment = () => {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'default_jwt_secret_change_in_production';
  console.log('✅ Environment validation completed');
};

// Checks whether INTEGRATION_CREDENTIALS_KEY (server/services/peopleSync/
// credentialCipher.js — encrypts every Elvanto/Planning Center credential
// on the church-scoped integration_connections table) is set to a valid
// base64-encoded 32-byte key, and — if not — whether any church actually
// has credential data that depends on it. Reproduced empirically in review:
// without this key, a deployment with a valid legacy Elvanto API key still
// sitting in user_preferences would have every credential-encryption
// operation throw, and (before this fix) that throw was silently swallowed
// into a misleading 401 "not connected" on every one-shot import route —
// see routes/integrations.js's resolveElvantoApiKeyOrRespond, and
// legacyCredential.js's own migration path.
//
// Deliberately NOT a hard startup failure (no process.exit here): a
// misconfigured Elvanto/Planning Center key must not take down attendance
// tracking — this app's actual core function — for every church, including
// the (likely common) case of a church that never uses either integration.
// Must be called AFTER the database is initialized (needs the registry to
// enumerate churches) and BEFORE the server starts accepting requests.
//
//   - key is valid: silent, no log line (the common, correctly-configured case).
//   - key is missing/invalid AND at least one church has dependent data (a
//     legacy Elvanto/PCO row still awaiting migration, or an
//     already-connected encrypted integration): a loud, specific
//     console.error naming the exact consequence, so this is never
//     mistaken for "not connected" by whoever is watching server logs.
//   - key is missing/invalid AND no church has any dependent data yet (a
//     fresh install that has never touched either integration): a quiet
//     warning only — this must never nag an installation that doesn't need
//     the key yet.
async function checkIntegrationCredentialsKey() {
  const { encryptCredential, decryptCredential } = require('./services/peopleSync/credentialCipher');

  let keyFormatValid = false;
  try {
    // Cheapest possible validity probe: round-trip a throwaway value
    // through the real cipher. Never touches real data, and the probe
    // value itself is never logged either way. NOTE: this only proves the
    // key is well-formed (right length/encoding) — ANY well-formed 32-byte
    // key round-trips its OWN freshly-encrypted probe perfectly fine, even
    // one that doesn't match what a real, already-stored row was encrypted
    // with (e.g. a rotated/regenerated key). That mismatch case is checked
    // separately, below, against real data.
    decryptCredential(encryptCredential({ probe: true }));
    keyFormatValid = true;
  } catch (_) {
    keyFormatValid = false;
  }

  let Database;
  let churches;
  try {
    Database = require('./config/database');
    churches = Database.listChurches();
  } catch (error) {
    console.warn('⚠️  Failed to check INTEGRATION_CREDENTIALS_KEY configuration against existing church data:', error.message);
    return;
  }

  if (!keyFormatValid) {
    let affectedChurches = 0;
    for (const church of churches) {
      try {
        const legacyRows = await Database.queryForChurch(
          church.church_id,
          `SELECT COUNT(*) AS n FROM user_preferences WHERE preference_key IN ('elvanto_api_key', 'planning_center_tokens')`
        );
        const connectionRows = await Database.queryForChurch(
          church.church_id,
          `SELECT COUNT(*) AS n FROM integration_connections`
        );
        if ((legacyRows[0]?.n || 0) > 0 || (connectionRows[0]?.n || 0) > 0) affectedChurches++;
      } catch (churchError) {
        // A brand-new/not-yet-migrated church DB missing one of these
        // tables is not itself evidence of a problem — skip it rather than
        // letting one church's schema quirk abort the whole startup check.
        console.warn(`⚠️  Could not check integration credential data for church ${church.church_id}:`, churchError.message);
      }
    }

    if (affectedChurches > 0) {
      console.error(
        `❌ CONFIGURATION ERROR: INTEGRATION_CREDENTIALS_KEY is missing or invalid, but ${affectedChurches} ` +
        `church(es) have Elvanto/Planning Center credential data that depends on it (a legacy row still awaiting ` +
        `migration, or an already-connected encrypted integration). Every credential-encryption operation for ` +
        `those churches will fail until a valid base64-encoded 32-byte key is set in server/.env — see ` +
        `server/.env.example. This does NOT stop the server from starting (attendance tracking is unaffected), ` +
        `but Elvanto/Planning Center integration features are broken for those churches until this is fixed.`
      );
    } else {
      console.warn(
        '⚠️  INTEGRATION_CREDENTIALS_KEY is not set. No church currently has Elvanto/Planning Center credential ' +
        'data, so nothing is broken yet — but this MUST be set (see server/.env.example) before any church ' +
        'connects one of those integrations, or the connection will silently fail.'
      );
    }
    return;
  }

  // Key format is valid — but does it actually match what any EXISTING
  // integration_connections row was encrypted with? A container redeployed
  // with a regenerated/rotated key (exactly the scenario server/.env.example
  // already warns against — "must stay stable across restarts") passes the
  // round-trip probe above trivially, while every existing credential
  // silently becomes undecryptable. Attempts one real row per church (the
  // cheapest possible check — no need to check every row once one has
  // failed to decrypt for a church) and reports a MISMATCH distinctly from
  // "missing", since it is a different, more actionable diagnosis for an
  // operator (rotate back, or reconnect every integration for those
  // churches).
  let mismatchedChurches = 0;
  for (const church of churches) {
    try {
      const rows = await Database.queryForChurch(
        church.church_id,
        `SELECT credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version
           FROM integration_connections LIMIT 1`
      );
      if (!rows.length) continue;
      try {
        decryptCredential(rows[0]);
      } catch (_) {
        mismatchedChurches++;
      }
    } catch (churchError) {
      // A brand-new church DB missing this table yet is not evidence of a
      // problem — skip it rather than letting one church's schema quirk
      // abort the whole startup check.
      console.warn(`⚠️  Could not check integration_connections for church ${church.church_id}:`, churchError.message);
    }
  }

  if (mismatchedChurches > 0) {
    console.error(
      `❌ CONFIGURATION ERROR: INTEGRATION_CREDENTIALS_KEY does not match the key ${mismatchedChurches} church(es)' ` +
      `existing Elvanto/Planning Center credentials were encrypted with (it may have been rotated or regenerated ` +
      `since those credentials were saved). Every encrypted credential for those churches is now undecryptable — ` +
      `those integrations will behave as disconnected/misconfigured until either the correct key is restored, or ` +
      `each affected church reconnects its integration(s) to re-encrypt under the current key.`
    );
  }
}

// Security middleware with error handling
try {
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));
} catch (error) {
  console.warn('Helmet middleware failed, continuing without it:', error.message);
}

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
    'Accept',
    'Accept-Language',
    'Accept-Encoding',
    'DNT',
    'Connection',
    'Upgrade-Insecure-Requests',
    'User-Agent',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Sec-Fetch-User'
  ],
  exposedHeaders: ['Set-Cookie'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));





// Cookie parsing must precede the authenticated people-import request
// boundary below so verifyToken can read its HTTP-only auth cookie before
// malformed or oversized JSON is considered.
app.use(cookieParser());

// Body parsing middleware. These narrow parsers must precede the general
// 10 MiB parser so both Content-Length and chunked requests retain their
// route-specific limits without changing unrelated API upload limits.
const { createSourceBuilderJsonParser } = require('./routes/integrations/sourceBuilder');
app.use('/api/integrations/people-sync/providers', createSourceBuilderJsonParser());
const { createPeopleImportsRequestBoundary } = require('./routes/people-imports');
app.use('/api/people-imports', createPeopleImportsRequestBoundary());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware with error handling
try {
  app.use(logger.createRequestLogger());
} catch (error) {
  console.warn('Request logging failed, continuing without it:', error.message);
}

// Security middleware - apply to all routes with error handling
try {
  app.use(sanitizeInput);
  app.use(detectSQLInjection);
} catch (error) {
  console.warn('Security middleware failed, continuing without it:', error.message);
}

// Church isolation middleware - ensure proper data isolation between churches
try {
  const { ensureChurchIsolation, addChurchContext } = require('./middleware/churchIsolation');
  // Note: Church isolation middleware should be applied at the route level after authentication
  // app.use('/api', ensureChurchIsolation); // Removed - causes issues with auth routes
  app.use('/api', addChurchContext);
  console.log('✅ Church isolation middleware loaded');
} catch (error) {
  console.warn('Church isolation middleware failed, continuing without it:', error.message);
}

// Global rate limiting - protect against general API abuse
// Increased limit to accommodate cache-first loading pattern which makes multiple
// background refresh requests on page load
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 300, // Increased from 100 to 300 for cache-first pattern
  message: { 
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests to avoid penalizing normal usage
  skipSuccessfulRequests: true,
  // Custom key generator to include user ID if available
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip);
    return req.user?.id ? `${ipKey}_${req.user.id}` : ipKey;
  }
});

app.use('/api', globalLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || 'unknown'
  });
});

// Database health check
app.get('/health/db', async (req, res) => {
  try {
    const Database = require('./config/database');
    const isConnected = await Database.testConnection();
    res.status(200).json({ 
      status: isConnected ? 'OK' : 'ERROR',
      database: isConnected ? 'connected' : 'disconnected'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR',
      database: 'error',
      message: error.message 
    });
  }
});

// Service status endpoint
app.get('/health/services', (req, res) => {
  const externalServices = {
    crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
    brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
  };

  const hasAnyService = externalServices.brevo || externalServices.crazytel;

  res.status(200).json({
    status: hasAnyService ? 'partial' : 'limited',
    externalServices: externalServices,
    environment: process.env.NODE_ENV || 'development',
    features: {
      authentication: hasAnyService || process.env.NODE_ENV === 'development',
      sms: externalServices.crazytel,
      email: externalServices.brevo,
      websockets: !webSocketService.getStats().disabled,
      development: process.env.NODE_ENV === 'development'
    },
    notes: !hasAnyService ? [
      'No external services configured',
      'Authentication limited to development mode',
      'Configure Brevo (email) and/or Crazytel (SMS) API keys for full functionality'
    ] : []
  });
});

// WebSocket status endpoint
app.get('/health/websocket', (req, res) => {
  const stats = webSocketService.getStats();
  res.status(200).json({
    status: stats.disabled ? 'disabled' : 'OK',
    ...stats,
    timestamp: new Date().toISOString()
  });
});

// Clear token page endpoint
app.get('/clear-token', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, '../client/public/clear-token.html'));
  } catch (error) {
    res.status(404).json({ error: 'Clear token page not found' });
  }
});

// iOS Safari debug page endpoint
app.get('/ios-debug', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, '../client/public/ios-debug.html'));
  } catch (error) {
    res.status(404).json({ error: 'iOS debug page not found' });
  }
});

// CORS test endpoint
app.get('/cors-test', (req, res) => {
  res.status(200).json({ 
    message: 'CORS is working!',
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});



// Load and apply routes
const routes = loadRoutes();

// API routes with error handling
// Convert route names like advancedMigrations -> advanced-migrations and notification_rules -> notification-rules
const toKebabCase = (name) => name
  .replace(/_/g, '-')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase();

Object.entries(routes).forEach(([name, router]) => {
  try {
    const mountPath = `/api/${toKebabCase(name)}`;
    app.use(mountPath, router);
    console.log(`🔗 Mounted route '${name}' at '${mountPath}'`);
  } catch (error) {
    console.warn(`Failed to apply route ${name}:`, error.message);
  }
});

// ===== EXPRESS ERROR HANDLER =====
// This catches all errors that occur in API routes
app.use('/api', (error, req, res, next) => {
  console.error('🚨 EXPRESS ERROR HANDLER: Caught unhandled error in API route');
  console.error('🔍 ERROR TYPE:', error.constructor.name);
  console.error('🔍 ERROR MESSAGE:', error.message);
  console.error('🔍 ERROR STACK:', error.stack);
  console.error('🔍 ERROR CODE:', error.code);
  console.error('🔍 ERROR ERRNO:', error.errno);
  console.error('🔍 ERROR SQLSTATE:', error.sqlState);
  console.error('🔍 ERROR SQLMESSAGE:', error.sqlMessage);
  console.error('🔍 REQUEST DETAILS:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    params: req.params,
    query: req.query,
    headers: req.headers,
    userId: req.user?.id,
    churchId: req.user?.church_id
  });
  console.error('🔍 FULL ERROR OBJECT:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
  
  // Send a generic 500 error response
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Google Sheets test endpoints (AFTER routes are loaded)
app.get('/api/sheets-test', (req, res) => {
  console.log('📊 Google Sheets test endpoint called');
  console.log('📊 User-Agent:', req.get('User-Agent'));
  console.log('📊 Accept:', req.get('Accept'));
  // Removed sensitive header logging for security
  
  const testData = [
    ['Date', 'Name', 'Status'],
    ['2025-01-01', 'John Doe', 'Present'],
    ['2025-01-01', 'Jane Smith', 'Present'],
    ['2025-01-08', 'John Doe', 'Absent']
  ];
  
  const csvContent = testData
    .map(row => row.map(field => `"${field}"`).join(','))
    .join('\n');
  
  // Try different Content-Type for Google Sheets
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(csvContent);
  
  console.log('📊 CSV sent successfully');
});

// Ultra-simple Google Sheets test endpoint
app.get('/api/simple-test', (req, res) => {
  console.log('🔧 Simple test endpoint called by:', req.get('User-Agent'));
  // Removed sensitive header logging for security
  
  // Minimal CSV content
  const csvContent = 'Date,Name,Status\n2025-01-01,John Doe,Present\n2025-01-01,Jane Smith,Present';
  
  // Only essential headers
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(csvContent);
  
  console.log('🔧 Simple CSV sent successfully');
});

// Public Google Sheets test endpoint (completely bypasses all middleware)
app.get('/api/public-csv', (req, res) => {
  console.log('🌐 Public CSV endpoint called by:', req.get('User-Agent'));
  // Removed sensitive header logging for security
  
  // Very simple CSV - no quotes, no extra characters
  const csvContent = 'A,B,C\n1,2,3\n4,5,6';
  
  // Remove all problematic headers
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('X-Frame-Options');
  res.removeHeader('X-Content-Type-Options');
  res.removeHeader('X-XSS-Protection');
  res.removeHeader('Strict-Transport-Security');
  res.removeHeader('X-Download-Options');
  res.removeHeader('X-Permitted-Cross-Domain-Policies');
  res.removeHeader('Referrer-Policy');
  res.removeHeader('X-DNS-Prefetch-Control');
  res.removeHeader('Origin-Agent-Cluster');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.removeHeader('Cache-Control');
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
  
  // Set only essential headers - no charset
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(csvContent);
  
  console.log('🌐 Public CSV sent successfully');
});

// Ultra-simple endpoint for IMPORTDATA testing
app.get('/api/importdata-test', (req, res) => {
  console.log('📋 IMPORTDATA test endpoint called by:', req.get('User-Agent'));
  
  // Minimal CSV content
  const csvContent = 'Name,Value\nTest,123';
  
  // Only essential headers
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(csvContent);
  
  console.log('📋 IMPORTDATA test CSV sent successfully');
});

// Test endpoint outside /api/ path
app.get('/csv-test', (req, res) => {
  console.log('📋 CSV test endpoint called by:', req.get('User-Agent'));
  
  // Minimal CSV content
  const csvContent = 'Name,Value\nTest,123';
  
  // Only essential headers
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(csvContent);
  
  console.log('📋 CSV test sent successfully');
});

// Error handling middleware
app.use((err, req, res, next) => {
  const errorMessage = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error';
  
  try {
    logger.error('Unhandled server error', { 
      error: err.message, 
      stack: err.stack,
      url: req.url,
      method: req.method,
      userId: req.user?.id
    });
  } catch (logError) {
    console.error('Logging failed:', logError.message);
    console.error('Original error:', err.message);
  }
  
  res.status(500).json({ 
    error: 'Something went wrong!', 
    message: errorMessage 
  });
});

// 404 handler
app.use('*splat', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function startServer() {
  try {
    // Validate environment first
    validateEnvironment();
    
    console.log('🚀 Starting Let My People Grow server...');
    console.log(`🏃 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔌 Port: ${PORT}`);
    
    // Initialize database schema with retry logic
    let dbInitialized = false;
    let retryCount = 0;
    const maxRetries = 5;
    
    while (!dbInitialized && retryCount < maxRetries) {
      try {
        console.log(`🗄️  Attempting database initialization (attempt ${retryCount + 1}/${maxRetries})...`);
        await initializeDatabase();
        dbInitialized = true;
        console.log('✅ Database initialized successfully');
      } catch (error) {
        retryCount++;
        console.warn(`⚠️  Database initialization attempt ${retryCount} failed:`, error.message);
        
        if (retryCount < maxRetries) {
          console.log(`⏳ Retrying in 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          console.error('❌ Database initialization failed after all retries');
          console.log('🚀 Starting server anyway (some features may not work)');
        }
      }
    }

    // Checks INTEGRATION_CREDENTIALS_KEY against existing church data — see
    // checkIntegrationCredentialsKey's own header note. Needs the registry
    // (populated above by initializeDatabase) to enumerate churches, and
    // must run before the provider registration/scheduler steps below,
    // which are the things that actually exercise encrypted credentials.
    if (dbInitialized) {
      try {
        await checkIntegrationCredentialsKey();
      } catch (error) {
        console.warn('⚠️  INTEGRATION_CREDENTIALS_KEY check failed unexpectedly:', error.message);
      }
    }

    // Initialize WebSocket service
    try {
      webSocketService.initialize(server);
      
      // Initialize WebSocket broadcast utility
      const websocketBroadcast = require('./utils/websocketBroadcast');
      websocketBroadcast.initialize(webSocketService);
      
      console.log('✅ WebSocket service initialized');
    } catch (error) {
      console.warn('⚠️  WebSocket service initialization failed:', error.message);
    }
    
    // Initialize weekly review scheduler
    let weeklyReviewScheduler;
    try {
      weeklyReviewScheduler = require('./services/weeklyReviewScheduler');
      weeklyReviewScheduler.start();
      console.log('✅ Weekly review scheduler initialized');
    } catch (error) {
      console.warn('⚠️  Weekly review scheduler initialization failed:', error.message);
    }

    // Register the provider-neutral people-sync adapters (Planning Center,
    // Elvanto) exactly once, before anything that could resolve one by name
    // gets a chance to run. Tasks 14/15 built providerRegistry.getProvider()
    // and every orchestrator.js pipeline function (buildReview/applyReviewed/
    // runUnattended/previewAuthoritySwitch) calls it internally, lazily, the
    // first time a real HTTP request or a scheduled batch reaches it — but
    // nothing called registerBuiltInProviders() to populate that registry
    // until now. Without this, every one of those calls would throw "Unknown
    // provider" the moment real traffic (or the scheduler below) arrived.
    // Placed here, before the people-sync scheduler starts and before
    // server.listen() below accepts any request, so registration is always
    // complete before either can be reached. registerBuiltInProviders() is
    // idempotent (see providerRegistry.js), so calling it again later (e.g.
    // a hot-reload path) is harmless.
    try {
      require('./services/peopleSync/providerRegistry').registerBuiltInProviders();
      console.log('✅ People-sync providers registered (Planning Center, Elvanto)');
    } catch (error) {
      console.warn('⚠️  People-sync provider registration failed:', error.message);
    }

    // Initialize the provider-neutral people-sync scheduler (Task 10). This is
    // the ONLY people-sync cron job started — planningCenterSync.start()
    // (kept only for external/back-compat callers) delegates to this exact
    // same module, so starting both here would register two cron jobs
    // running the identical work twice a night. Always require/start via
    // peopleSync/scheduler directly at startup, never via planningCenterSync.
    try {
      const peopleSyncScheduler = require('./services/peopleSync/scheduler');
      peopleSyncScheduler.start();
      console.log('✅ People-sync scheduler initialized');
    } catch (error) {
      console.warn('⚠️  People-sync scheduler initialization failed:', error.message);
    }

    // Start the server
    server.listen(PORT, () => {
      console.log(`🎉 Server running on port ${PORT}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
      console.log(`🗄️  Database health: http://localhost:${PORT}/health/db`);
      console.log(`🔌 WebSocket: ${webSocketService.getStats().disabled ? 'Disabled' : 'Enabled'}`);
      console.log('✅ Server startup completed successfully');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  webSocketService.shutdown();
  try { require('./services/weeklyReviewScheduler').stop(); } catch (_) {}
  try { require('./services/peopleSync/scheduler').stop(); } catch (_) {}
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  webSocketService.shutdown();
  try { require('./services/weeklyReviewScheduler').stop(); } catch (_) {}
  try { require('./services/peopleSync/scheduler').stop(); } catch (_) {}
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

startServer();
