const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Import Winston logger
const logger = require('./config/logger');

// Import database initialization
const { initializeDatabase } = require('./startup');

// Import security middleware
const { 
  sanitizeInput, 
  detectSQLInjection, 
  createSecurityRateLimit 
} = require('./middleware/security');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const gatheringRoutes = require('./routes/gatherings');
const familyRoutes = require('./routes/families');
const individualRoutes = require('./routes/individuals');
const attendanceRoutes = require('./routes/attendance');
const reportRoutes = require('./routes/reports');
const notificationRoutes = require('./routes/notifications');
const onboardingRoutes = require('./routes/onboarding');
const invitationRoutes = require('./routes/invitations');
const csvImportRoutes = require('./routes/csv-import');
const migrationRoutes = require('./routes/migrations');
const testRoutes = require('./routes/test');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: true, // Allow all origins - nginx proxy handles security
  credentials: true
}));

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again later.'
// });
// app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookie parsing middleware
app.use(cookieParser());

// Request logging middleware
app.use(logger.createRequestLogger());

// Security middleware - apply to all routes
app.use(sanitizeInput);
app.use(detectSQLInjection);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/gatherings', gatheringRoutes);
app.use('/api/families', familyRoutes);
app.use('/api/individuals', individualRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/invitations', invitationRoutes);
app.use('/api/csv-import', csvImportRoutes);
app.use('/api/migrations', migrationRoutes);
app.use('/api/test', testRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', { 
    error: err.message, 
    stack: err.stack,
    url: req.url,
    method: req.method,
    userId: req.user?.id
  });
  res.status(500).json({ 
    error: 'Something went wrong!', 
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database schema
    await initializeDatabase();
    
    // Start the server
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`🏃 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('Server startup completed successfully');
    });
  } catch (error) {
    logger.error('❌ Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startServer(); 