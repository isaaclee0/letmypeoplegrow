const express = require('express');
const SchemaIntrospector = require('../utils/schemaIntrospector');
const MigrationPlanner = require('../utils/migrationPlanner');
const MigrationExecutor = require('../utils/migrationExecutor');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require admin authentication
router.use(verifyToken);
router.use(requireRole(['admin']));

/**
 * Get comprehensive database schema information
 */
router.get('/schema', async (req, res) => {
  try {
    const introspector = new SchemaIntrospector();
    const schema = await introspector.getFullSchema();
    
    res.json({
      success: true,
      schema,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting schema:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get database schema',
      details: error.message 
    });
  }
});

/**
 * Get schema for a specific table
 */
router.get('/schema/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    const introspector = new SchemaIntrospector();
    const tableSchema = await introspector.getTableSchema(tableName);
    
    if (!tableSchema) {
      return res.status(404).json({ 
        success: false, 
        error: `Table '${tableName}' not found` 
      });
    }
    
    res.json({
      success: true,
      tableSchema,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting table schema:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get table schema',
      details: error.message 
    });
  }
});

/**
 * Generate migration plan based on desired schema
 */
router.post('/plan', async (req, res) => {
  try {
    const { desiredSchema } = req.body;
    
    if (!desiredSchema) {
      return res.status(400).json({ 
        success: false, 
        error: 'Desired schema is required' 
      });
    }

    const planner = new MigrationPlanner();
    const plan = await planner.generateMigrationPlan(desiredSchema);
    
    res.json({
      success: true,
      plan,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating migration plan:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate migration plan',
      details: error.message 
    });
  }
});

/**
 * Execute migration plan
 */
router.post('/execute', async (req, res) => {
  try {
    const { 
      plan, 
      options = {} 
    } = req.body;
    
    if (!plan) {
      return res.status(400).json({ 
        success: false, 
        error: 'Migration plan is required' 
      });
    }

    const executor = new MigrationExecutor();
    const result = await executor.executeMigrationPlan(plan, options);
    
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error executing migration plan:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to execute migration plan',
      details: error.message 
    });
  }
});

/**
 * Validate migration plan without executing
 */
router.post('/validate', async (req, res) => {
  try {
    const { plan } = req.body;
    
    if (!plan) {
      return res.status(400).json({ 
        success: false, 
        error: 'Migration plan is required' 
      });
    }

    const executor = new MigrationExecutor();
    const result = await executor.executeMigrationPlan(plan, { 
      validateOnly: true 
    });
    
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error validating migration plan:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Migration plan validation failed',
      details: error.message 
    });
  }
});

/**
 * Dry run migration plan
 */
router.post('/dry-run', async (req, res) => {
  try {
    const { plan, options = {} } = req.body;
    
    if (!plan) {
      return res.status(400).json({ 
        success: false, 
        error: 'Migration plan is required' 
      });
    }

    const executor = new MigrationExecutor();
    const result = await executor.executeMigrationPlan(plan, { 
      ...options, 
      dryRun: true 
    });
    
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in dry run:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Dry run failed',
      details: error.message 
    });
  }
});

/**
 * Get migration execution history
 */
router.get('/history', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const executor = new MigrationExecutor();
    const history = await executor.getExecutionHistory(parseInt(limit));
    
    res.json({
      success: true,
      history,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting execution history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get execution history',
      details: error.message 
    });
  }
});

/**
 * Get specific execution details
 */
router.get('/history/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;
    const executor = new MigrationExecutor();
    const details = await executor.getExecutionDetails(executionId);
    
    if (!details) {
      return res.status(404).json({ 
        success: false, 
        error: `Execution '${executionId}' not found` 
      });
    }
    
    res.json({
      success: true,
      details,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting execution details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get execution details',
      details: error.message 
    });
  }
});

/**
 * Get database size information
 */
router.get('/size', async (req, res) => {
  try {
    const introspector = new SchemaIntrospector();
    const sizeInfo = await introspector.getDatabaseSize();
    
    res.json({
      success: true,
      sizeInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting database size:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get database size information',
      details: error.message 
    });
  }
});

/**
 * Check table row counts
 */
router.get('/row-counts', async (req, res) => {
  try {
    const introspector = new SchemaIntrospector();
    const tables = await introspector.getAllTables();
    const rowCounts = {};
    
    for (const table of tables) {
      if (table.name !== 'migrations') {
        rowCounts[table.name] = await introspector.getTableRowCount(table.name);
      }
    }
    
    res.json({
      success: true,
      rowCounts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting row counts:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get row counts',
      details: error.message 
    });
  }
});

/**
 * Generate CREATE TABLE statements for all tables
 */
router.get('/create-statements', async (req, res) => {
  try {
    const introspector = new SchemaIntrospector();
    const tables = await introspector.getAllTables();
    const createStatements = {};
    
    for (const table of tables) {
      if (table.name !== 'migrations') {
        createStatements[table.name] = await introspector.getCreateTableStatement(table.name);
      }
    }
    
    res.json({
      success: true,
      createStatements,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting CREATE statements:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get CREATE statements',
      details: error.message 
    });
  }
});

/**
 * Health check for migration system
 */
router.get('/health', async (req, res) => {
  try {
    const introspector = new SchemaIntrospector();
    const executor = new MigrationExecutor();
    
    // Test basic functionality
    const tables = await introspector.getAllTables();
    const history = await executor.getExecutionHistory(1);
    
    res.json({
      success: true,
      health: {
        schemaIntrospection: 'healthy',
        migrationExecution: 'healthy',
        tableCount: tables.length,
        recentExecutions: history.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Migration system health check failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Migration system health check failed',
      details: error.message 
    });
  }
});

module.exports = router;
