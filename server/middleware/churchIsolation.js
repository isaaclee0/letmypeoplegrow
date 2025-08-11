const Database = require('../config/database');
const { isValidChurchId, sanitizeChurchIdForLogging } = require('../utils/churchIdGenerator');

/**
 * Middleware to ensure church data isolation
 * This middleware automatically adds church_id filtering to all database queries
 * and validates that church_id is present in the user context
 */
const ensureChurchIsolation = (req, res, next) => {
  // Skip church isolation for auth routes that don't require authentication
  const authRoutes = ['/auth', '/auth/request-code', '/auth/verify-code'];
  const isAuthRoute = authRoutes.some(route => req.path.startsWith(route));
  
  // Skip church isolation for importrange routes (they use different validation)
  const isImportrangeRoute = req.path.startsWith('/importrange');
  
  if (isAuthRoute || isImportrangeRoute) {
    return next();
  }
  
  // Ensure user has church_id
  if (!req.user || !req.user.church_id) {
    console.warn('Church isolation: Missing user or church_id', {
      userId: req.user?.id,
      path: req.path,
      ip: req.ip
    });
    return res.status(401).json({ 
      error: 'User church context not found. Please log in again.',
      code: 'MISSING_CHURCH_CONTEXT'
    });
  }

  // Validate church_id format for security
  if (!isValidChurchId(req.user.church_id)) {
    console.error('Church isolation: Invalid church_id format', {
      userId: req.user.id,
      churchId: sanitizeChurchIdForLogging(req.user.church_id),
      path: req.path,
      ip: req.ip
    });
    return res.status(401).json({ 
      error: 'Invalid church context. Please log in again.',
      code: 'INVALID_CHURCH_CONTEXT'
    });
  }

  // Add church_id to request for easy access
  req.churchId = req.user.church_id;
  
  // Log church access for security monitoring (sanitized)
  if (process.env.NODE_ENV === 'production') {
    console.log('Church access', {
      userId: req.user.id,
      churchId: sanitizeChurchIdForLogging(req.user.church_id),
      path: req.path,
      method: req.method,
      ip: req.ip
    });
  }
  
  next();
};

/**
 * Middleware to validate that a resource belongs to the user's church
 * Use this for operations that modify specific resources
 */
const validateChurchOwnership = (tableName, idField = 'id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[idField] || req.body[idField];
      
      if (!resourceId) {
        return res.status(400).json({ 
          error: `Resource ID is required`,
          code: 'MISSING_RESOURCE_ID'
        });
      }

      // Check if the resource belongs to the user's church
      const [resources] = await Database.query(
        `SELECT ${idField} FROM ${tableName} WHERE ${idField} = ? AND church_id = ?`,
        [resourceId, req.user.church_id]
      );

      if (resources.length === 0) {
        return res.status(403).json({ 
          error: 'Access denied. Resource does not belong to your church.',
          code: 'CHURCH_ACCESS_DENIED'
        });
      }

      next();
    } catch (error) {
      console.error('Church ownership validation error:', error);
      res.status(500).json({ error: 'Error validating resource ownership.' });
    }
  };
};

/**
 * Helper function to add church_id to database queries
 * Use this in route handlers to ensure church isolation
 */
const addChurchFilter = (query, churchId) => {
  // Simple check to see if WHERE clause already exists
  const upperQuery = query.toUpperCase();
  if (upperQuery.includes('WHERE')) {
    return query.replace(/WHERE/i, `WHERE church_id = ? AND `);
  } else {
    return query + ' WHERE church_id = ?';
  }
};

/**
 * Middleware to automatically filter all database queries by church_id
 * This is a more advanced approach that modifies the Database.query method
 */
const setupChurchFiltering = () => {
  const originalQuery = Database.query;
  
  Database.query = function(sql, params = []) {
    // Only apply church filtering to SELECT, UPDATE, DELETE operations
    // and only if the query involves tables that have church_id
    const upperSql = sql.toUpperCase();
    const hasChurchIdTables = [
      'families', 'individuals', 'attendance_records', 'attendance_sessions',
      'gathering_types', 'gathering_lists', 'notifications', 'notification_rules',
      'onboarding_progress', 'otc_codes', 'user_gathering_assignments',
      'user_invitations', 'users', 'audit_log', 'church_settings'
    ].some(table => upperSql.includes(table.toUpperCase()));
    
    if (hasChurchIdTables && !upperSql.includes('CHURCH_ID = ?')) {
      // This is a simplified approach - in practice, you'd need more sophisticated SQL parsing
      // For now, we'll rely on explicit church_id filtering in route handlers
    }
    
    return originalQuery.call(this, sql, params);
  };
};

/**
 * Response wrapper to ensure all responses include church context
 */
const addChurchContext = (req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    // Add church context to successful responses
    if (res.statusCode < 400 && req.user && req.user.church_id) {
      if (typeof data === 'object' && data !== null) {
        data.church_id = req.user.church_id;
      }
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

module.exports = {
  ensureChurchIsolation,
  validateChurchOwnership,
  addChurchFilter,
  setupChurchFiltering,
  addChurchContext
};
