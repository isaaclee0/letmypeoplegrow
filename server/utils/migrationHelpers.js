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
 * Check if an index exists in a table
 * @param {string} tableName - The table name
 * @param {string} indexName - The index name
 * @returns {Promise<boolean>} - True if index exists, false otherwise
 */
async function indexExists(tableName, indexName) {
  try {
    const result = await Database.query(`
      SELECT INDEX_NAME 
      FROM INFORMATION_SCHEMA.STATISTICS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = ? 
      AND INDEX_NAME = ?
    `, [tableName, indexName]);
    
    return result.length > 0;
  } catch (error) {
    console.error(`Error checking if index ${indexName} exists in ${tableName}:`, error);
    return false;
  }
}

/**
 * Safely add a column to a table
 * @param {string} tableName - The table name
 * @param {string} columnName - The column name
 * @param {string} columnDefinition - The column definition (e.g., "BOOLEAN DEFAULT false")
 * @param {string} afterColumn - The column to add after (optional)
 * @returns {Promise<boolean>} - True if column was added or already exists
 */
async function safeAddColumn(tableName, columnName, columnDefinition, afterColumn = null) {
  const exists = await columnExists(tableName, columnName);
  if (exists) {
    console.log(`✅ Column ${columnName} already exists in ${tableName}`);
    return true;
  }

  try {
    let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`;
    if (afterColumn) {
      sql += ` AFTER ${afterColumn}`;
    }
    
    await Database.query(sql);
    console.log(`✅ Added column ${columnName} to ${tableName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to add column ${columnName} to ${tableName}:`, error.message);
    return false;
  }
}

/**
 * Safely create an index
 * @param {string} tableName - The table name
 * @param {string} indexName - The index name
 * @param {string} columns - The columns to index (e.g., "column1, column2")
 * @returns {Promise<boolean>} - True if index was created or already exists
 */
async function safeCreateIndex(tableName, indexName, columns) {
  const exists = await indexExists(tableName, indexName);
  if (exists) {
    console.log(`✅ Index ${indexName} already exists on ${tableName}`);
    return true;
  }

  try {
    await Database.query(`CREATE INDEX ${indexName} ON ${tableName} (${columns})`);
    console.log(`✅ Created index ${indexName} on ${tableName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to create index ${indexName} on ${tableName}:`, error.message);
    return false;
  }
}

/**
 * Verify migration requirements
 * @param {Object} requirements - Object with table/column requirements
 * @returns {Promise<Object>} - Verification results
 */
async function verifyMigrationRequirements(requirements) {
  const results = {
    success: true,
    missing: [],
    existing: []
  };

  for (const [tableName, columns] of Object.entries(requirements)) {
    for (const columnName of columns) {
      const exists = await columnExists(tableName, columnName);
      if (exists) {
        results.existing.push(`${tableName}.${columnName}`);
      } else {
        results.missing.push(`${tableName}.${columnName}`);
        results.success = false;
      }
    }
  }

  return results;
}

/**
 * Get migration verification status
 * @returns {Promise<Object>} - Status of all migration requirements
 */
async function getMigrationStatus() {
  const requirements = {
    'individuals': ['is_visitor'],
    'visitors': ['last_attended'],
    'audit_log': ['entity_type', 'entity_id'],
    'attendance_sessions': ['recorded_by']
  };

  return await verifyMigrationRequirements(requirements);
}

module.exports = {
  columnExists,
  indexExists,
  safeAddColumn,
  safeCreateIndex,
  verifyMigrationRequirements,
  getMigrationStatus
}; 