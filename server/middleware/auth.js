const jwt = require('jsonwebtoken');
const Database = require('../config/database');

// Verify JWT token
const verifyToken = async (req, res, next) => {
  try {
    // Check for token in Authorization header first (for backward compatibility)
    let token = req.header('Authorization')?.replace('Bearer ', '');
    
    // If no token in header, check for cookie
    if (!token) {
      token = req.cookies?.authToken;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user details from database
    const users = await Database.query(
      'SELECT id, email, role, first_name, last_name, is_active, first_login_completed FROM users WHERE id = ? AND is_active = true',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid token or user not found.' });
    }

    req.user = users[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// Role-based access control
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    next();
  };
};

// Check if user can access specific gathering
const requireGatheringAccess = async (req, res, next) => {
  try {
    const { gatheringTypeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Admins have access to all gatherings
    if (userRole === 'admin') {
      return next();
    }

    // Check if user is assigned to this gathering type
    const assignments = await Database.query(
      'SELECT id FROM user_gathering_assignments WHERE user_id = ? AND gathering_type_id = ?',
      [userId, gatheringTypeId]
    );

    if (assignments.length === 0) {
      return res.status(403).json({ error: 'Access denied to this gathering type.' });
    }

    next();
  } catch (error) {
    console.error('Gathering access middleware error:', error);
    res.status(500).json({ error: 'Error checking gathering access.' });
  }
};

// Audit log middleware
const auditLog = (action) => {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json;
    
    // Override json method to capture response
    res.json = function(data) {
      // Log successful actions (status < 400)
      if (res.statusCode < 400 && req.user) {
        setImmediate(async () => {
          try {
            await Database.query(`
              INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_values, ip_address, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
              req.user.id,
              action,
              req.body?.table || null,
              req.body?.id || data?.id || null,
              req.body ? JSON.stringify(req.body) : null,
              req.ip,
              req.get('User-Agent')
            ]);
          } catch (error) {
            console.error('Audit log error:', error);
          }
        });
      }
      
      // Call original json method
      originalJson.call(this, data);
    };
    
    next();
  };
};

module.exports = {
  verifyToken,
  requireRole,
  requireGatheringAccess,
  auditLog
}; 