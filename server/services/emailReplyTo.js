const Database = require('../config/database');

async function resolveMainAdminReplyTo(churchId, options = {}) {
  if (!churchId) return null;
  const database = options.database || Database;
  const admins = await database.queryForChurch(
    churchId,
    `SELECT email
     FROM users
     WHERE church_id = ?
       AND role = 'admin'
       AND is_active = 1
       AND email IS NOT NULL
       AND TRIM(email) != ''
     ORDER BY datetime(created_at) ASC, id ASC
     LIMIT 1`,
    [churchId],
  );
  return admins[0]?.email || null;
}

module.exports = { resolveMainAdminReplyTo };
