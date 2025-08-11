import React, { useState } from 'react';
import { useAdvancedMigration } from '../contexts/AdvancedMigrationContext';
import {
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  CogIcon,
  DocumentTextIcon,
  ChartBarIcon,
  ServerIcon,
  TableCellsIcon,
  PlayIcon,
  StopIcon,
  DocumentDuplicateIcon,
} from '@heroicons/react/24/outline';

const AdvancedMigrationsPage: React.FC = () => {
  const {
    schema,
    databaseSize,
    rowCounts,
    createStatements,
    healthStatus,
    currentPlan,
    executionHistory,
    selectedExecution,
    isLoadingSchema,
    isLoadingPlan,
    isLoadingExecution,
    isLoadingHistory,
    schemaError,
    planError,
    executionError,
    historyError,
    fetchSchema,
    fetchDatabaseSize,
    fetchRowCounts,
    fetchCreateStatements,
    fetchHealth,
    generatePlan,
    executePlan,
    validatePlan,
    dryRunPlan,
    fetchExecutionHistory,
    fetchExecutionDetails,
    clearErrors,
  } = useAdvancedMigration();

  const [activeTab, setActiveTab] = useState<'overview' | 'schema' | 'planning' | 'execution' | 'history'>('overview');
  const [isCreatePlanOpen, setIsCreatePlanOpen] = useState(false);
  const [desiredSchemaJson, setDesiredSchemaJson] = useState('');

  const handleRefresh = async () => {
    clearErrors();
    await Promise.all([
      fetchSchema(),
      fetchDatabaseSize(),
      fetchRowCounts(),
      fetchCreateStatements(),
      fetchHealth(),
      fetchExecutionHistory(),
    ]);
  };

  const handleGenerateTestPlan = async () => {
    if (!schema) return;
    
    try {
      // Create a simple test plan by adding a test column to users table
      const desiredSchema = {
        ...schema,
        columns: [
          ...schema.columns,
          {
            tableName: 'users',
            name: 'test_column',
            position: 999,
            defaultValue: null,
            isNullable: 'YES',
            dataType: 'varchar',
            maxLength: 100,
            numericPrecision: null,
            numericScale: null,
            datetimePrecision: null,
            characterSet: 'utf8mb4',
            columnCollation: 'utf8mb4_general_ci',
            columnType: 'varchar(100)',
            columnKey: '',
            extra: '',
            privileges: 'select,insert,update,references',
            comment: 'Test column for migration planning',
            isGenerated: 'NEVER',
            generationExpression: null,
          }
        ]
      };
      
      await generatePlan(desiredSchema);
    } catch (error) {
      console.error('Failed to generate test plan:', error);
    }
  };

  const handleOpenCreatePlan = () => {
    setDesiredSchemaJson('');
    setIsCreatePlanOpen(true);
  };

  const handleCreatePlanFromJson = async () => {
    try {
      const parsed = JSON.parse(desiredSchemaJson);
      await generatePlan(parsed);
      setIsCreatePlanOpen(false);
    } catch (e: any) {
      alert(`Invalid JSON: ${e.message}`);
    }
  };

  const handleExecutePlan = async (plan: any, options: any = {}) => {
    try {
      await executePlan(plan, options);
      await fetchExecutionHistory();
    } catch (error) {
      console.error('Failed to execute plan:', error);
    }
  };

  const handleDryRun = async (plan: any) => {
    try {
      await dryRunPlan(plan);
    } catch (error) {
      console.error('Failed to dry run plan:', error);
    }
  };

  const getRiskSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'text-red-600 bg-red-50 border-red-200';
      case 'high':
        return 'text-orange-600 bg-orange-50 border-orange-200';
      case 'medium':
        return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      case 'low':
        return 'text-blue-600 bg-blue-50 border-blue-200';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  if (isLoadingSchema && !schema) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (schemaError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <div className="flex">
          <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">Error loading database schema</h3>
            <div className="mt-2 text-sm text-red-700">{schemaError}</div>
            <div className="mt-4">
              <button
                onClick={handleRefresh}
                className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                <ArrowPathIcon className="h-4 w-4 mr-2" />
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Advanced Database Migrations
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Intelligent database schema analysis and migration management
              </p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={handleRefresh}
                disabled={isLoadingSchema}
                className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                <ArrowPathIcon className="h-4 w-4 mr-2" />
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-white shadow rounded-lg">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 px-6">
            {[
              { id: 'overview', name: 'Overview', icon: ChartBarIcon },
                             { id: 'schema', name: 'Schema Analysis', icon: TableCellsIcon },
              { id: 'planning', name: 'Migration Planning', icon: DocumentTextIcon },
              { id: 'execution', name: 'Execution', icon: PlayIcon },
              { id: 'history', name: 'History', icon: ClockIcon },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center ${
                  activeTab === tab.id
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <tab.icon className="h-4 w-4 mr-2" />
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Health Status */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">System Health</h3>
                {healthStatus ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex items-center">
                        <CheckCircleIcon className="h-5 w-5 text-green-400" />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-green-800">Schema Introspection</p>
                          <p className="text-sm text-green-600">{healthStatus.schemaIntrospection}</p>
                        </div>
                      </div>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex items-center">
                        <CheckCircleIcon className="h-5 w-5 text-green-400" />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-green-800">Migration Execution</p>
                          <p className="text-sm text-green-600">{healthStatus.migrationExecution}</p>
                        </div>
                      </div>
                    </div>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center">
                                                 <TableCellsIcon className="h-5 w-5 text-blue-400" />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-blue-800">Tables</p>
                          <p className="text-sm text-blue-600">{healthStatus.tableCount}</p>
                        </div>
                      </div>
                    </div>
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                      <div className="flex items-center">
                        <ClockIcon className="h-5 w-5 text-purple-400" />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-purple-800">Recent Executions</p>
                          <p className="text-sm text-purple-600">{healthStatus.recentExecutions}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-gray-500">Loading health status...</p>
                )}
              </div>

              {/* Database Size */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Database Size</h3>
                {databaseSize ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-gray-500">Total Size</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {Math.round(databaseSize.totalSize / 1024)} KB
                      </p>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-gray-500">Data Size</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {Math.round(databaseSize.dataSize / 1024)} KB
                      </p>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-gray-500">Index Size</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {Math.round(databaseSize.indexSize / 1024)} KB
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-gray-500">Loading database size...</p>
                )}
              </div>

              {/* Recent Executions */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Executions</h3>
                {executionHistory.length > 0 ? (
                  <div className="space-y-2">
                    {executionHistory.slice(0, 5).map((execution) => (
                      <div key={execution.executionId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{execution.executionId}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(execution.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            execution.errorMessage 
                              ? 'bg-red-100 text-red-800' 
                              : 'bg-green-100 text-green-800'
                          }`}>
                            {execution.errorMessage ? 'Failed' : 'Success'}
                          </span>
                          <button
                            onClick={() => fetchExecutionDetails(execution.executionId)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            <EyeIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500">No recent executions</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'schema' && (
            <div className="space-y-6">
              <h3 className="text-lg font-medium text-gray-900">Database Schema Analysis</h3>
              {schema ? (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div>
                    <h4 className="text-md font-medium text-gray-900 mb-3">Tables ({schema.tables.length})</h4>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {schema.tables.map((table) => (
                        <div key={table.name} className="p-3 bg-gray-50 rounded-lg">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-gray-900">{table.name}</p>
                              <p className="text-xs text-gray-500">
                                {table.tableRows} rows • {Math.round(table.dataLength / 1024)} KB
                              </p>
                            </div>
                            <span className="text-xs text-gray-400">{table.engine}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="text-md font-medium text-gray-900 mb-3">Columns ({schema.columns.length})</h4>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {schema.columns.slice(0, 20).map((column, index) => (
                        <div key={`${column.tableName}-${column.name}-${index}`} className="p-3 bg-gray-50 rounded-lg">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-gray-900">
                                {column.tableName}.{column.name}
                              </p>
                              <p className="text-xs text-gray-500">{column.columnType}</p>
                            </div>
                            <span className={`text-xs px-2 py-1 rounded ${
                              column.isNullable === 'NO' 
                                ? 'bg-red-100 text-red-800' 
                                : 'bg-green-100 text-green-800'
                            }`}>
                              {column.isNullable === 'NO' ? 'NOT NULL' : 'NULL'}
                            </span>
                          </div>
                        </div>
                      ))}
                      {schema.columns.length > 20 && (
                        <p className="text-sm text-gray-500 text-center">
                          ... and {schema.columns.length - 20} more columns
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-gray-500">Loading schema...</p>
              )}
            </div>
          )}

          {activeTab === 'planning' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">Migration Planning</h3>
                <button
                  onClick={handleGenerateTestPlan}
                  disabled={isLoadingPlan || !schema}
                  className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                >
                  <DocumentTextIcon className="h-4 w-4 mr-2" />
                  Generate Test Plan
                </button>
              </div>

              <div className="mt-2">
                <button
                  onClick={handleOpenCreatePlan}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <DocumentTextIcon className="h-4 w-4 mr-2" />
                  Create Plan from JSON
                </button>
              </div>

              {planError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4">
                  <div className="flex">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">Plan Generation Error</h3>
                      <div className="mt-2 text-sm text-red-700">{planError}</div>
                    </div>
                  </div>
                </div>
              )}

              {currentPlan && (
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="text-md font-medium text-blue-900 mb-2">Migration Plan Summary</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-blue-700">Columns to add: {currentPlan.summary.columnsToAdd.length}</p>
                        <p className="text-blue-700">Indexes to create: {currentPlan.summary.indexesToCreate.length}</p>
                        <p className="text-blue-700">Foreign keys to add: {currentPlan.summary.foreignKeysToAdd.length}</p>
                      </div>
                      <div>
                        <p className="text-blue-700">Estimated time: {currentPlan.estimatedTime}ms</p>
                        <p className="text-blue-700">Risks identified: {currentPlan.risks.length}</p>
                        <p className="text-blue-700">Migrations: {currentPlan.migrations.length}</p>
                      </div>
                    </div>
                  </div>

                  {currentPlan.risks.length > 0 && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <h4 className="text-md font-medium text-yellow-900 mb-2">Risk Assessment</h4>
                      <div className="space-y-2">
                        {currentPlan.risks.map((risk, index) => (
                          <div key={index} className={`p-2 rounded border ${getRiskSeverityColor(risk.severity)}`}>
                            <p className="text-sm font-medium">{risk.description}</p>
                            <p className="text-xs opacity-75">Severity: {risk.severity}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex space-x-3">
                    <button
                      onClick={() => handleDryRun(currentPlan)}
                      disabled={isLoadingExecution}
                      className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                    >
                      <DocumentDuplicateIcon className="h-4 w-4 mr-2" />
                      Dry Run
                    </button>
                    <button
                      onClick={() => handleExecutePlan(currentPlan, { dryRun: false })}
                      disabled={isLoadingExecution}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                    >
                      <PlayIcon className="h-4 w-4 mr-2" />
                      Execute Plan
                    </button>
                  </div>
                </div>
              )}

              {!currentPlan && !isLoadingPlan && (
                <div className="text-center py-12">
                  <DocumentTextIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No migration plan</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Generate a test plan to see the migration planning system in action.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'execution' && (
            <div className="space-y-6">
              <h3 className="text-lg font-medium text-gray-900">Migration Execution</h3>
              {executionError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4">
                  <div className="flex">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">Execution Error</h3>
                      <div className="mt-2 text-sm text-red-700">{executionError}</div>
                    </div>
                  </div>
                </div>
              )}
              <p className="text-gray-500">
                Use the Planning tab to generate and execute migration plans.
              </p>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-6">
              <h3 className="text-lg font-medium text-gray-900">Execution History</h3>
              {historyError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4">
                  <div className="flex">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">History Error</h3>
                      <div className="mt-2 text-sm text-red-700">{historyError}</div>
                    </div>
                  </div>
                </div>
              )}
              {executionHistory.length > 0 ? (
                <div className="space-y-4">
                  {executionHistory.map((execution) => (
                    <div key={execution.executionId} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{execution.executionId}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(execution.createdAt).toLocaleString()} • {execution.durationMs}ms
                          </p>
                          {execution.errorMessage && (
                            <p className="text-xs text-red-600 mt-1">{execution.errorMessage}</p>
                          )}
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            execution.errorMessage 
                              ? 'bg-red-100 text-red-800' 
                              : 'bg-green-100 text-green-800'
                          }`}>
                            {execution.errorMessage ? 'Failed' : 'Success'}
                          </span>
                          {execution.dryRun && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              Dry Run
                            </span>
                          )}
                          <button
                            onClick={() => fetchExecutionDetails(execution.executionId)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            <EyeIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500">No execution history available</p>
              )}
            </div>
          )}
        </div>
      </div>

      {isCreatePlanOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white w-full max-w-3xl rounded-lg shadow-lg">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-medium text-gray-900">Create Plan from Desired Schema JSON</h3>
              <button onClick={() => setIsCreatePlanOpen(false)} className="text-gray-400 hover:text-gray-600">
                <XCircleIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-gray-600 mb-2">Paste a desired schema JSON matching the format from Schema Analysis.</p>
              <textarea
                className="w-full h-64 border border-gray-300 rounded p-2 font-mono text-sm"
                placeholder={`{ "tables": [], "columns": [], "indexes": [], "foreignKeys": [], "constraints": [] }`}
                value={desiredSchemaJson}
                onChange={(e) => setDesiredSchemaJson(e.target.value)}
              />
            </div>
            <div className="px-4 py-3 border-t border-gray-200 flex justify-end space-x-2">
              <button onClick={() => setIsCreatePlanOpen(false)} className="px-3 py-2 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Cancel</button>
              <button onClick={handleCreatePlanFromJson} className="px-3 py-2 text-sm rounded bg-primary-600 text-white hover:bg-primary-700">Generate Plan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdvancedMigrationsPage;
