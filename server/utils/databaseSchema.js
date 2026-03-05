const Database = require('../config/database');

async function columnExists(tableName, columnName) {
  try {
    const result = await Database.query(
      `PRAGMA table_info(${tableName})`
    );
    return result.some(col => col.name === columnName);
  } catch (error) {
    console.error(`Error checking if column ${columnName} exists in ${tableName}:`, error);
    return false;
  }
}

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

async function requireIsVisitorColumn() {
  return requireColumn('individuals', 'is_visitor', '002_add_contact_fields');
}

async function requireLastAttendedColumn() {
  return requireColumn('individuals', 'last_attendance_date', '003_enhance_visitors_table');
}

module.exports = {
  columnExists,
  requireColumn,
  requireIsVisitorColumn,
  requireLastAttendedColumn
};
