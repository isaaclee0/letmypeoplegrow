const validator = require('validator');
const DOMPurify = require('isomorphic-dompurify');
const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for potential church ID guessing attempts
 * This helps prevent brute force attacks on church IDs
 */
const churchIdGuessingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit to 10 attempts per window
  message: { 
    error: 'Too many invalid church access attempts. Please try again later.',
    code: 'CHURCH_ACCESS_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Only count requests that result in church isolation errors
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
  // Custom key generator to track by IP
  keyGenerator: (req) => {
    return `church_guess_${req.ip}`;
  }
});

/**
 * Rate limiter for authentication attempts
 * This helps prevent brute force attacks on login
 */
const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit to 5 failed attempts per window
  message: { 
    error: 'Too many failed authentication attempts. Please try again later.',
    code: 'AUTH_ATTEMPTS_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Only count failed authentication attempts
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
  // Custom key generator to track by IP
  keyGenerator: (req) => {
    return `auth_fail_${req.ip}`;
  }
});

// SQL injection patterns to detect and block
const SQL_INJECTION_PATTERNS = [
  // More specific patterns that indicate actual SQL injection attempts
  /((\%3D)|(=))[^\n]*((\%27)|(\')|(\-\-)|(\%3B)|(;))/i,
  /\w*((\%27)|(\'))((\%6F)|o|(\%4F))((\%72)|r|(\%52))/i,
  /((\%27)|(\'))union/i,
  /exec(\s|\+)+(s|x)p\w+/i,
  /union([^\w]|[\w])+select/i,
  /select([^\w]|[\w])+from/i,
  /insert([^\w]|[\w])+into/i,
  /delete([^\w]|[\w])+from/i,
  /update([^\w]|[\w])+set/i,
  /drop([^\w]|[\w])+table/i,
  /alter([^\w]|[\w])+table/i,
  /create([^\w]|[\w])+table/i,
  /script[^>]*>.*<\/script/i,
  /javascript:/i,
  /vbscript:/i,
  /onload\s*=/i,
  /onerror\s*=/i
];

// XSS patterns to detect and block
const XSS_PATTERNS = [
  /<script[^>]*>.*?<\/script>/gi,
  /<iframe[^>]*>.*?<\/iframe>/gi,
  /<object[^>]*>.*?<\/object>/gi,
  /<embed[^>]*>/gi,
  /<link[^>]*>/gi,
  /javascript:/gi,
  /vbscript:/gi,
  /on\w+\s*=/gi
];

// Sanitize string input
const sanitizeString = (input) => {
  if (typeof input !== 'string') {
    return input;
  }
  
  // Trim whitespace
  let sanitized = input.trim();

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // HTML encode dangerous characters (strips HTML tags, preserves text and special chars)
  sanitized = DOMPurify.sanitize(sanitized, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: []
  });

  // NOTE: No manual SQL escaping needed - we use parameterized queries everywhere
  // This preserves user input like "O'Brien Family" correctly

  return sanitized;
};

// Check for SQL injection attempts
const containsSQLInjection = (input) => {
  if (typeof input !== 'string') {
    return false;
  }
  
  const lowerInput = input.toLowerCase();
  return SQL_INJECTION_PATTERNS.some(pattern => pattern.test(lowerInput));
};

// Check for XSS attempts
const containsXSS = (input) => {
  if (typeof input !== 'string') {
    return false;
  }
  
  return XSS_PATTERNS.some(pattern => pattern.test(input));
};

// Recursively sanitize object
const sanitizeObject = (obj, path = '') => {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'string') {
    // Check for malicious content
    if (containsSQLInjection(obj)) {
      throw new Error(`Potential SQL injection detected in ${path || 'input'}`);
    }
    
    if (containsXSS(obj)) {
      throw new Error(`Potential XSS attack detected in ${path || 'input'}`);
    }
    
    return sanitizeString(obj);
  }
  
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map((item, index) => 
      sanitizeObject(item, `${path}[${index}]`)
    );
  }
  
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      const sanitizedKey = sanitizeString(key);
      const newPath = path ? `${path}.${sanitizedKey}` : sanitizedKey;
      sanitized[sanitizedKey] = sanitizeObject(value, newPath);
    }
    return sanitized;
  }
  
  return obj;
};

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  try {
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body, 'body');
    }
    
    // Sanitize query parameters
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query, 'query');
    }
    
    // Sanitize route parameters
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params, 'params');
    }
    
    next();
  } catch (error) {
    console.error('Security middleware blocked malicious input:', error.message);
    res.status(400).json({ 
      error: 'Invalid input detected',
      details: 'Your request contains potentially malicious content and has been blocked for security reasons.'
    });
  }
};

// SQL injection detection middleware (additional layer)
const detectSQLInjection = (req, res, next) => {
  const checkPayload = (obj, path = '') => {
    if (typeof obj === 'string') {
      if (containsSQLInjection(obj)) {
        throw new Error(`SQL injection attempt detected in ${path || 'request'}: ${obj.substring(0, 100)}...`);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      Object.entries(obj).forEach(([key, value]) => {
        const newPath = path ? `${path}.${key}` : key;
        checkPayload(value, newPath);
      });
    }
  };

  try {
    checkPayload(req.body, 'body');
    checkPayload(req.query, 'query');
    checkPayload(req.params, 'params');
    next();
  } catch (error) {
    console.error('SQL injection attempt blocked:', error.message);
    console.error('Request details:', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl,
      method: req.method,
      body: req.body,
      query: req.query
    });
    
    res.status(400).json({ 
      error: 'Security violation detected',
      details: 'Your request has been blocked due to potentially malicious content.'
    });
  }
};

// File upload security middleware
const secureFileUpload = (allowedTypes = ['text/csv'], maxSize = 5 * 1024 * 1024) => {
  return (req, res, next) => {
    if (req.file) {
      // Check file type
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Invalid file type',
          details: `Only ${allowedTypes.join(', ')} files are allowed`
        });
      }
      
      // Check file size
      if (req.file.size > maxSize) {
        return res.status(400).json({
          error: 'File too large',
          details: `Maximum file size is ${Math.round(maxSize / 1024 / 1024)}MB`
        });
      }
      
      // Check filename for path traversal
      if (req.file.originalname.includes('..') || req.file.originalname.includes('/') || req.file.originalname.includes('\\')) {
        return res.status(400).json({
          error: 'Invalid filename',
          details: 'Filename contains invalid characters'
        });
      }
      
      // Sanitize filename
      req.file.originalname = sanitizeString(req.file.originalname);
    }
    
    next();
  };
};

// Rate limiting for security-sensitive endpoints
const createSecurityRateLimit = (windowMs = 15 * 60 * 1000, max = 10) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      error: 'Too many requests',
      details: 'Please try again later'
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
};

// Validate email addresses more strictly
const validateEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }
  
  // Use validator.js for robust email validation
  if (!validator.isEmail(email)) {
    return false;
  }
  
  // Additional checks for suspicious patterns
  const suspiciousPatterns = [
    /script/i,
    /javascript/i,
    /vbscript/i,
    /<.*>/,
    /['"]/,
    /\\/
  ];
  
  return !suspiciousPatterns.some(pattern => pattern.test(email));
};

// Validate phone numbers
const validatePhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return false;
  }
  
  // Remove common formatting characters
  const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
  
  // Check if it's all digits (with possible leading +)
  const phonePattern = /^\+?[0-9]{8,15}$/;
  return phonePattern.test(cleanPhone);
};

// Enhanced input validation middleware
const validateInput = (validationRules = {}) => {
  return (req, res, next) => {
    const errors = [];
    
    // Check body fields
    if (validationRules.body) {
      Object.entries(validationRules.body).forEach(([field, rules]) => {
        const value = req.body[field];
        
        if (rules.required && (!value || value === '')) {
          errors.push(`${field} is required`);
          return;
        }
        
        if (value && rules.type === 'email' && !validateEmail(value)) {
          errors.push(`${field} must be a valid email address`);
        }
        
        if (value && rules.type === 'phone' && !validatePhoneNumber(value)) {
          errors.push(`${field} must be a valid phone number`);
        }
        
        if (value && rules.maxLength && value.length > rules.maxLength) {
          errors.push(`${field} must be no more than ${rules.maxLength} characters`);
        }
        
        if (value && rules.minLength && value.length < rules.minLength) {
          errors.push(`${field} must be at least ${rules.minLength} characters`);
        }
      });
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }
    
    next();
  };
};

module.exports = {
  sanitizeInput,
  detectSQLInjection,
  secureFileUpload,
  createSecurityRateLimit,
  validateEmail,
  validatePhoneNumber,
  validateInput,
  sanitizeString,
  sanitizeObject,
  churchIdGuessingLimiter,
  authAttemptLimiter
}; 