import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { advancedMigrationsAPI, SchemaInfo, MigrationPlan, MigrationExecution, DatabaseSizeInfo, RowCounts, CreateStatements, HealthStatus } from '../services/advancedMigrationsAPI';
import { useAuth } from './AuthContext';

interface AdvancedMigrationContextType {
  // Schema Analysis
  schema: SchemaInfo | null;
  databaseSize: DatabaseSizeInfo | null;
  rowCounts: RowCounts | null;
  createStatements: CreateStatements | null;
  healthStatus: HealthStatus | null;
  
  // Migration Planning & Execution
  currentPlan: MigrationPlan | null;
  executionHistory: MigrationExecution[];
  selectedExecution: MigrationExecution | null;
  
  // Loading States
  isLoadingSchema: boolean;
  isLoadingPlan: boolean;
  isLoadingExecution: boolean;
  isLoadingHistory: boolean;
  
  // Error States
  schemaError: string | null;
  planError: string | null;
  executionError: string | null;
  historyError: string | null;
  
  // Actions
  fetchSchema: () => Promise<void>;
  fetchDatabaseSize: () => Promise<void>;
  fetchRowCounts: () => Promise<void>;
  fetchCreateStatements: () => Promise<void>;
  fetchHealth: () => Promise<void>;
  generatePlan: (desiredSchema: SchemaInfo) => Promise<MigrationPlan>;
  executePlan: (plan: MigrationPlan, options?: any) => Promise<any>;
  validatePlan: (plan: MigrationPlan) => Promise<any>;
  dryRunPlan: (plan: MigrationPlan, options?: any) => Promise<any>;
  fetchExecutionHistory: (limit?: number) => Promise<void>;
  fetchExecutionDetails: (executionId: string) => Promise<void>;
  clearErrors: () => void;
}

const AdvancedMigrationContext = createContext<AdvancedMigrationContextType | undefined>(undefined);

export const useAdvancedMigration = () => {
  const context = useContext(AdvancedMigrationContext);
  if (context === undefined) {
    throw new Error('useAdvancedMigration must be used within an AdvancedMigrationProvider');
  }
  return context;
};

interface AdvancedMigrationProviderProps {
  children: React.ReactNode;
}

export const AdvancedMigrationProvider: React.FC<AdvancedMigrationProviderProps> = ({ children }) => {
  const { user } = useAuth();
  
  // State
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [databaseSize, setDatabaseSize] = useState<DatabaseSizeInfo | null>(null);
  const [rowCounts, setRowCounts] = useState<RowCounts | null>(null);
  const [createStatements, setCreateStatements] = useState<CreateStatements | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  
  const [currentPlan, setCurrentPlan] = useState<MigrationPlan | null>(null);
  const [executionHistory, setExecutionHistory] = useState<MigrationExecution[]>([]);
  const [selectedExecution, setSelectedExecution] = useState<MigrationExecution | null>(null);
  
  // Loading States
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const [isLoadingExecution, setIsLoadingExecution] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  
  // Error States
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Schema Analysis Actions
  const fetchSchema = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    
    try {
      setIsLoadingSchema(true);
      setSchemaError(null);
      const response = await advancedMigrationsAPI.getSchema();
      setSchema(response.data.schema);
    } catch (err: any) {
      console.error('Failed to fetch schema:', err);
      setSchemaError(err.response?.data?.error || 'Failed to fetch database schema');
    } finally {
      setIsLoadingSchema(false);
    }
  }, [user]);

  const fetchDatabaseSize = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    
    try {
      const response = await advancedMigrationsAPI.getDatabaseSize();
      setDatabaseSize(response.data.sizeInfo);
    } catch (err: any) {
      console.error('Failed to fetch database size:', err);
    }
  }, [user]);

  const fetchRowCounts = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    
    try {
      const response = await advancedMigrationsAPI.getRowCounts();
      setRowCounts(response.data.rowCounts);
    } catch (err: any) {
      console.error('Failed to fetch row counts:', err);
    }
  }, [user]);

  const fetchCreateStatements = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    
    try {
      const response = await advancedMigrationsAPI.getCreateStatements();
      setCreateStatements(response.data.createStatements);
    } catch (err: any) {
      console.error('Failed to fetch CREATE statements:', err);
    }
  }, [user]);

  const fetchHealth = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    
    try {
      const response = await advancedMigrationsAPI.getHealth();
      setHealthStatus(response.data.health);
    } catch (err: any) {
      console.error('Failed to fetch health status:', err);
    }
  }, [user]);

  // Migration Planning & Execution Actions
  const generatePlan = useCallback(async (desiredSchema: SchemaInfo): Promise<MigrationPlan> => {
    if (!user || user.role !== 'admin') {
      throw new Error('Admin access required');
    }
    
    try {
      setIsLoadingPlan(true);
      setPlanError(null);
      const response = await advancedMigrationsAPI.generatePlan(desiredSchema);
      const plan = response.data.plan;
      setCurrentPlan(plan);
      return plan;
    } catch (err: any) {
      console.error('Failed to generate migration plan:', err);
      const error = err.response?.data?.error || 'Failed to generate migration plan';
      setPlanError(error);
      throw new Error(error);
    } finally {
      setIsLoadingPlan(false);
    }
  }, [user]);

  const executePlan = useCallback(async (plan: MigrationPlan, options?: any) => {
    if (!user || user.role !== 'admin') {
      throw new Error('Admin access required');
    }
    
    try {
      setIsLoadingExecution(true);
      setExecutionError(null);
      const response = await advancedMigrationsAPI.executePlan(plan, options);
      return response.data.result;
    } catch (err: any) {
      console.error('Failed to execute migration plan:', err);
      const error = err.response?.data?.error || 'Failed to execute migration plan';
      setExecutionError(error);
      throw new Error(error);
    } finally {
      setIsLoadingExecution(false);
    }
  }, [user]);

  const validatePlan = useCallback(async (plan: MigrationPlan) => {
    if (!user || user.role !== 'admin') {
      throw new Error('Admin access required');
    }
    
    try {
      const response = await advancedMigrationsAPI.validatePlan(plan);
      return response.data.result;
    } catch (err: any) {
      console.error('Failed to validate migration plan:', err);
      throw new Error(err.response?.data?.error || 'Failed to validate migration plan');
    }
  }, [user]);

  const dryRunPlan = useCallback(async (plan: MigrationPlan, options?: any) => {
    if (!user || user.role !== 'admin') {
      throw new Error('Admin access required');
    }
    
    try {
      const response = await advancedMigrationsAPI.dryRunPlan(plan, options);
      return response.data.result;
    } catch (err: any) {
      console.error('Failed to dry run migration plan:', err);
      throw new Error(err.response?.data?.error || 'Failed to dry run migration plan');
    }
  }, [user]);

  // History & Monitoring Actions
  const fetchExecutionHistory = useCallback(async (limit?: number) => {
    if (!user || user.role !== 'admin') return;
    
    try {
      setIsLoadingHistory(true);
      setHistoryError(null);
      const response = await advancedMigrationsAPI.getExecutionHistory(limit);
      setExecutionHistory(response.data.history);
    } catch (err: any) {
      console.error('Failed to fetch execution history:', err);
      setHistoryError(err.response?.data?.error || 'Failed to fetch execution history');
    } finally {
      setIsLoadingHistory(false);
    }
  }, [user]);

  const fetchExecutionDetails = useCallback(async (executionId: string) => {
    if (!user || user.role !== 'admin') return;
    
    try {
      const response = await advancedMigrationsAPI.getExecutionDetails(executionId);
      setSelectedExecution(response.data.details);
    } catch (err: any) {
      console.error('Failed to fetch execution details:', err);
    }
  }, [user]);

  const clearErrors = useCallback(() => {
    setSchemaError(null);
    setPlanError(null);
    setExecutionError(null);
    setHistoryError(null);
  }, []);

  // Initial data fetch
  useEffect(() => {
    if (user && user.role === 'admin') {
      fetchSchema();
      fetchDatabaseSize();
      fetchRowCounts();
      fetchCreateStatements();
      fetchHealth();
      fetchExecutionHistory();
    }
  }, [user, fetchSchema, fetchDatabaseSize, fetchRowCounts, fetchCreateStatements, fetchHealth, fetchExecutionHistory]);

  const value: AdvancedMigrationContextType = {
    // Schema Analysis
    schema,
    databaseSize,
    rowCounts,
    createStatements,
    healthStatus,
    
    // Migration Planning & Execution
    currentPlan,
    executionHistory,
    selectedExecution,
    
    // Loading States
    isLoadingSchema,
    isLoadingPlan,
    isLoadingExecution,
    isLoadingHistory,
    
    // Error States
    schemaError,
    planError,
    executionError,
    historyError,
    
    // Actions
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
  };

  return (
    <AdvancedMigrationContext.Provider value={value}>
      {children}
    </AdvancedMigrationContext.Provider>
  );
};
