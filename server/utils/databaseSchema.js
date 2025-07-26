const Database = require('../config/database');

/**
 * Check if a column exists in a table
 * @param {string} tableName - The table name
 * @param {string} columnName - The column name
 * @returns {Promise<boolean>} - True if column exists, false otherwise
 */
async function columnExists(tableName, columnName) {
  try {
    const result = await Database.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = ? 
      AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    
    return result.length > 0;
  } catch (error) {
    console.error(`Error checking if column ${columnName} exists in ${tableName}:`, error);
    return false;
  }
}

/**
 * Check if required columns exist and throw helpful error if not
 * @param {string} tableName - The table name
 * @param {string} columnName - The column name
 * @param {string} migrationVersion - The migration version that adds this column
 * @returns {Promise<void>}
 */
async function requireColumn(tableName, columnName, migrationVersion) {
  const exists = await columnExists(tableName, columnName);
  if (!exists) {
    throw new Error(
      `Column '${columnName}' does not exist in table '${tableName}'. ` +
      `Please run migration ${migrationVersion} first. ` +
      `You can do this through the admin interface in the Migrations section.`
    );
  }
}

/**
 * Check if is_visitor column exists and provide helpful error if not
 * @returns {Promise<void>}
 */
async function requireIsVisitorColumn() {
  return requireColumn('individuals', 'is_visitor', '002_add_contact_fields');
}

/**
 * Check if last_attended column exists in visitors table and provide helpful error if not
 * @returns {Promise<void>}
 */
async function requireLastAttendedColumn() {
  return requireColumn('visitors', 'last_attended', '003_enhance_visitors_table');
}

module.exports = {
  columnExists,
  requireColumn,
  requireIsVisitorColumn,
  requireLastAttendedColumn
}; 