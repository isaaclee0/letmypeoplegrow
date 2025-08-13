const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

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
    'invitations', 'csv-import', 'migrations', 'advancedMigrations', 'test', 
    'notification_rules', 
    // 'importrange', // Disabled - external data access feature
    'settings', 'activities'
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
const PORT = process.env.PORT || 3001;

// Validate required environment variables
const validateEnvironment = () => {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn('⚠️  Missing environment variables:', missing.join(', '));
    console.warn('Using default values where possible');
  }
  
  // Set defaults for missing variables
  if (!process.env.DB_HOST) process.env.DB_HOST = 'localhost';
  if (!process.env.DB_USER) process.env.DB_USER = 'root';
  if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = '';
  if (!process.env.DB_NAME) process.env.DB_NAME = 'church_attendance';
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'default_jwt_secret_change_in_production';
  
  console.log('✅ Environment validation completed');
};

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





// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookie parsing middleware
app.use(cookieParser());

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
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 100, // More lenient in development
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
    return req.user?.id ? `${req.ip}_${req.user.id}` : req.ip;
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
      development: process.env.NODE_ENV === 'development'
    },
    notes: !hasAnyService ? [
      'No external services configured',
      'Authentication limited to development mode',
      'Configure Brevo (email) and/or Crazytel (SMS) API keys for full functionality'
    ] : []
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

// Google Sheets test endpoints (AFTER routes are loaded)
app.get('/api/sheets-test', (req, res) => {
  console.log('📊 Google Sheets test endpoint called');
  console.log('📊 User-Agent:', req.get('User-Agent'));
  console.log('📊 Accept:', req.get('Accept'));
  console.log('📊 All headers:', req.headers);
  
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
  console.log('🔧 All headers:', JSON.stringify(req.headers, null, 2));
  
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
  console.log('🌐 All headers:', JSON.stringify(req.headers, null, 2));
  
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
app.use('*', (req, res) => {
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
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`🎉 Server running on port ${PORT}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
      console.log(`🗄️  Database health: http://localhost:${PORT}/health/db`);
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
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
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