const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');

const verifyToken = async (req, res, next) => {
  try {
    if (req.path.includes('/headcount/')) {
      logger.debugLog('AUTH: Verifying token for headcount', {
        path: req.path,
        hasAuthHeader: !!req.header('Authorization'),
        hasCookie: !!req.cookies?.authToken
      });
    }

    let token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      token = req.cookies?.authToken;
    }

    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const churchId = decoded.churchId;

    if (!churchId) {
      return res.status(401).json({ error: 'Invalid token: missing church context.' });
    }

    Database.setChurchContext(churchId, async () => {
      try {
        const users = await Database.query(
          'SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id, church_id FROM users WHERE id = ? AND is_active = 1',
          [decoded.userId]
        );

        if (users.length === 0) {
          return res.status(401).json({ error: 'Invalid token or user not found.' });
        }

        const user = users[0];
        user.church_id = decoded.churchId || user.church_id;
        req.user = user;
        next();
      } catch (error) {
        console.error('Auth middleware error (inner):', error);
        res.status(401).json({ error: 'Invalid token.' });
      }
    });
  } catch (error) {
    console.error('Auth middleware error:', error);

    if (error.name === 'TokenExpiredError') {
      res.clearCookie('authToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      });
      res.status(401).json({
        error: 'Token expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    } else if (error.name === 'JsonWebTokenError') {
      res.status(401).json({
        error: 'Invalid token format.',
        code: 'INVALID_TOKEN'
      });
    } else {
      res.status(401).json({ error: 'Invalid token.' });
    }
  }
};

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

const requireGatheringAccess = async (req, res, next) => {
  try {
    logger.accessLog('GATHERING ACCESS: Checking access', {
      path: req.path,
      gatheringTypeId: req.params.gatheringTypeId,
      userId: req.user?.id,
      userRole: req.user?.role
    });

    const { gatheringTypeId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole === 'admin') {
      return next();
    }

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

const auditLog = (action) => {
  return async (req, res, next) => {
    const originalJson = res.json;

    res.json = function(data) {
      if (res.statusCode < 400 && req.user) {
        setImmediate(async () => {
          try {
            const churchId = req.user.church_id;
            await Database.setChurchContext(churchId, async () => {
              let serviceName = null;
              let serviceDate = null;

              if (req.params.gatheringTypeId && req.params.date) {
                try {
                  const gatheringResult = await Database.query(
                    'SELECT name FROM gathering_types WHERE id = ?',
                    [req.params.gatheringTypeId]
                  );
                  if (gatheringResult.length > 0) {
                    serviceName = gatheringResult[0].name;
                  }
                  serviceDate = req.params.date;
                } catch (error) {
                  console.error('Error getting gathering info:', error);
                }
              }

              const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
              const existingAction = await Database.query(`
                SELECT id, new_values FROM audit_log
                WHERE user_id = ?
                  AND action = ?
                  AND created_at > ?
                  AND table_name = ?
                  AND church_id = ?
                ORDER BY created_at DESC
                LIMIT 1
              `, [
                req.user.id,
                action,
                fiveMinutesAgo,
                req.body?.table || 'attendance_sessions',
                req.user.church_id
              ]);

              if (existingAction.length > 0) {
                let existingValues = {};
                try {
                  if (existingAction[0].new_values) {
                    existingValues = typeof existingAction[0].new_values === 'string'
                      ? JSON.parse(existingAction[0].new_values)
                      : existingAction[0].new_values;
                  }
                } catch (_) {
                  existingValues = {};
                }

                await Database.query(`
                  UPDATE audit_log
                  SET new_values = ?,
                      created_at = datetime('now'),
                      table_name = ?,
                      record_id = ?
                  WHERE id = ? AND church_id = ?
                `, [
                  JSON.stringify({
                    ...existingValues,
                    latestUpdate: new Date().toISOString(),
                    serviceName,
                    serviceDate,
                    actionCount: (existingValues.actionCount || 1) + 1
                  }),
                  req.body?.table || 'attendance_sessions',
                  req.body?.id || data?.id || null,
                  existingAction[0].id,
                  req.user.church_id
                ]);
              } else {
                const enhancedBody = {
                  ...req.body,
                  serviceName,
                  serviceDate,
                  actionCount: 1,
                  firstAction: new Date().toISOString()
                };

                await Database.query(`
                  INSERT INTO audit_log (user_id, action, table_name, record_id, new_values, ip_address, user_agent, church_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                  req.user.id,
                  action,
                  req.body?.table || 'attendance_sessions',
                  req.body?.id || data?.id || null,
                  JSON.stringify(enhancedBody),
                  req.ip,
                  req.get('User-Agent'),
                  req.user.church_id
                ]);
              }
            });
          } catch (error) {
            console.error('Audit log error:', error);
          }
        });
      }

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
