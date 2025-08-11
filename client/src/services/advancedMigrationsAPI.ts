import api from './api';

// Types for the advanced migration system
export interface SchemaInfo {
  tables: TableInfo[];
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
}

export interface TableInfo {
  name: string;
  type: string;
  engine: string;
  tableRows: number;
  avgRowLength: number;
  dataLength: number;
  maxDataLength: number;
  indexLength: number;
  dataFree: number;
  autoIncrement: number;
  createTime: string;
  updateTime: string;
  checkTime: string;
  collation: string;
  checksum: number;
  createOptions: string;
  comment: string;
}

export interface ColumnInfo {
  tableName: string;
  name: string;
  position: number;
  defaultValue: string | null;
  isNullable: string;
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
  characterSet: string | null;
  columnCollation: string | null;
  columnType: string;
  columnKey: string;
  extra: string;
  privileges: string;
  comment: string;
  isGenerated: string;
  generationExpression: string | null;
}

export interface IndexInfo {
  tableName: string;
  name: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
  collation: string;
  cardinality: number;
  subPart: number | null;
  packed: string | null;
  nullable: string;
  indexType: string;
  comment: string;
  indexComment: string;
}

export interface ForeignKeyInfo {
  name: string;
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
}

export interface ConstraintInfo {
  name: string;
  tableName: string;
  type: string;
}

export interface MigrationPlan {
  summary: {
    tablesToCreate: string[];
    tablesToDrop: string[];
    tablesToModify: string[];
    columnsToAdd: Array<{ table: string; column: ColumnInfo }>;
    columnsToModify: Array<{ table: string; current: ColumnInfo; desired: ColumnInfo }>;
    columnsToDrop: Array<{ table: string; column: ColumnInfo }>;
    indexesToCreate: Array<{ table: string; index: IndexInfo }>;
    indexesToDrop: Array<{ table: string; index: IndexInfo }>;
    foreignKeysToAdd: Array<{ table: string; foreignKey: ForeignKeyInfo }>;
    foreignKeysToDrop: Array<{ table: string; foreignKey: ForeignKeyInfo }>;
    constraintsToAdd: Array<{ table: string; constraint: ConstraintInfo }>;
    constraintsToDrop: Array<{ table: string; constraint: ConstraintInfo }>;
  };
  migrations: Array<{
    type: string;
    description: string;
    sql: string;
    tables?: string[];
    columns?: Array<{ table: string; column: string; sql: string }>;
    indexes?: Array<{ table: string; index: string; sql: string }>;
    foreignKeys?: Array<{ table: string; foreignKey: string; sql: string }>;
  }>;
  risks: Array<{
    type: string;
    severity: string;
    description: string;
    table?: string;
    column?: string;
    rowCount?: number;
    operations?: number;
  }>;
  estimatedTime: number;
  rollbackPlan: {
    migrations: Array<{
      type: string;
      description: string;
      sql: string;
    }>;
    description: string;
    risks: Array<{
      type: string;
      severity: string;
      description: string;
    }>;
  } | null;
}

export interface MigrationExecution {
  id: number;
  executionId: string;
  planSummary: any;
  results: any;
  durationMs: number;
  backupPath: string | null;
  dryRun: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export interface DatabaseSizeInfo {
  totalSize: number;
  dataSize: number;
  indexSize: number;
  tableCount: number;
}

export interface RowCounts {
  [tableName: string]: number;
}

export interface CreateStatements {
  [tableName: string]: string;
}

export interface HealthStatus {
  schemaIntrospection: string;
  migrationExecution: string;
  tableCount: number;
  recentExecutions: number;
}

// Advanced Migrations API
export const advancedMigrationsAPI = {
  // Schema Analysis
  getSchema: () => 
    api.get<{ success: boolean; schema: SchemaInfo; timestamp: string }>('/advanced-migrations/schema'),
    
  getTableSchema: (tableName: string) => 
    api.get<{ success: boolean; tableSchema: any; timestamp: string }>(`/advanced-migrations/schema/${tableName}`),
    
  getDatabaseSize: () => 
    api.get<{ success: boolean; sizeInfo: DatabaseSizeInfo; timestamp: string }>('/advanced-migrations/size'),
    
  getRowCounts: () => 
    api.get<{ success: boolean; rowCounts: RowCounts; timestamp: string }>('/advanced-migrations/row-counts'),
    
  getCreateStatements: () => 
    api.get<{ success: boolean; createStatements: CreateStatements; timestamp: string }>('/advanced-migrations/create-statements'),
    
  // Migration Planning & Execution
  generatePlan: (desiredSchema: SchemaInfo) => 
    api.post<{ success: boolean; plan: MigrationPlan; timestamp: string }>('/advanced-migrations/plan', { desiredSchema }),
    
  executePlan: (plan: MigrationPlan, options?: {
    dryRun?: boolean;
    validateOnly?: boolean;
    skipBackup?: boolean;
    maxRetries?: number;
    rollbackOnError?: boolean;
  }) => 
    api.post<{ success: boolean; result: any; timestamp: string }>('/advanced-migrations/execute', { plan, options }),
    
  validatePlan: (plan: MigrationPlan) => 
    api.post<{ success: boolean; result: any; timestamp: string }>('/advanced-migrations/validate', { plan }),
    
  dryRunPlan: (plan: MigrationPlan, options?: any) => 
    api.post<{ success: boolean; result: any; timestamp: string }>('/advanced-migrations/dry-run', { plan, options }),
    
  // History & Monitoring
  getExecutionHistory: (limit?: number) => 
    api.get<{ success: boolean; history: MigrationExecution[]; timestamp: string }>(`/advanced-migrations/history?limit=${limit || 50}`),
    
  getExecutionDetails: (executionId: string) => 
    api.get<{ success: boolean; details: MigrationExecution; timestamp: string }>(`/advanced-migrations/history/${executionId}`),
    
  getHealth: () => 
    api.get<{ success: boolean; health: HealthStatus; timestamp: string }>('/advanced-migrations/health'),
};
