const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');

// Ensure logs directory exists with error handling
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (error) {
  console.warn('Failed to create logs directory:', error.message);
  // Use a fallback directory in /tmp if we can't create the logs directory
  logsDir = '/tmp/letmypeoplegrow-logs';
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  } catch (fallbackError) {
    console.error('Failed to create fallback logs directory:', fallbackError.message);
  }
}

// Define log levels and colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(logColors);

// Custom format
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += `\n${JSON.stringify(meta, null, 2)}`;
    }
    
    return log;
  })
);

// Console format (with colors for development)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let log = `${timestamp} ${level}: ${message}`;
    
    // Add metadata if present (but keep it concise for console)
    if (Object.keys(meta).length > 0 && !meta.stack) {
      log += ` ${JSON.stringify(meta)}`;
    }
    
    return log;
  })
);

// Create file transports with error handling
const createFileTransports = () => {
  const transports = [];
  
  try {
    // Error log file (errors only)
    transports.push(new DailyRotateFile({
      filename: path.join(logsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'error',
      format: customFormat
    }));
  } catch (error) {
    console.warn('Failed to create error log transport:', error.message);
  }
  
  try {
    // Combined log file (all levels)
    transports.push(new DailyRotateFile({
      filename: path.join(logsDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      format: customFormat
    }));
  } catch (error) {
    console.warn('Failed to create combined log transport:', error.message);
  }
  
  return transports;
};

// Create exception handlers with error handling
const createExceptionHandlers = () => {
  const handlers = [];
  
  try {
    handlers.push(new DailyRotateFile({
      filename: path.join(logsDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    }));
  } catch (error) {
    console.warn('Failed to create exception handler:', error.message);
  }
  
  return handlers;
};

// Create rejection handlers with error handling
const createRejectionHandlers = () => {
  const handlers = [];
  
  try {
    handlers.push(new DailyRotateFile({
      filename: path.join(logsDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    }));
  } catch (error) {
    console.warn('Failed to create rejection handler:', error.message);
  }
  
  return handlers;
};

// Create the logger with fallback to console if file logging fails
let logger;

try {
  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels: logLevels,
    format: customFormat,
    transports: [
      ...createFileTransports(),
      // Console output (always include as fallback)
      new winston.transports.Console({
        format: consoleFormat,
        level: process.env.CONSOLE_LOG_LEVEL || 'debug'
      })
    ],
    
    // Handle uncaught exceptions and unhandled rejections
    exceptionHandlers: createExceptionHandlers(),
    rejectionHandlers: createRejectionHandlers()
  });
} catch (error) {
  console.error('Failed to create Winston logger, using console fallback:', error.message);
  
  // Fallback logger
  logger = {
    error: console.error,
    warn: console.warn,
    info: console.log,
    debug: console.log,
    http: console.log,
    log: console.log
  };
}

// Add request logging middleware with error handling
logger.createRequestLogger = () => {
  return (req, res, next) => {
    try {
      const start = Date.now();
      
      // Log request
      logger.http(`${req.method} ${req.url}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id
      });
      
      // Log response when finished
      res.on('finish', () => {
        try {
          const duration = Date.now() - start;
          const level = res.statusCode >= 400 ? 'warn' : 'http';
          
          logger.log(level, `${req.method} ${req.url} ${res.statusCode} - ${duration}ms`, {
            statusCode: res.statusCode,
            duration,
            ip: req.ip,
            userId: req.user?.id
          });
        } catch (logError) {
          console.warn('Failed to log response:', logError.message);
        }
      });
    } catch (error) {
      console.warn('Request logging failed:', error.message);
    }
    
    next();
  };
};

module.exports = logger; 