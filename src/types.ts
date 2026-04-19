export interface DatabaseConnection {
  id: string;
  name: string;
  driver: string;
  url: string;
  user?: string;
  host?: string;
  port?: number;
  database?: string;
  description?: string;
  connected?: boolean;
  readonly?: boolean;
  folder?: string;
  properties?: Record<string, string>;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  executionTime: number;
  error?: string;
}

export interface SchemaInfo {
  tableName: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  length?: number;
  precision?: number;
  scale?: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ConstraintInfo {
  name: string;
  type: 'PRIMARY_KEY' | 'FOREIGN_KEY' | 'UNIQUE' | 'CHECK';
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface ExportOptions {
  format: 'csv' | 'json' | 'xml' | 'excel' | 'sql';
  includeHeaders: boolean;
  delimiter?: string;
  encoding?: string;
  maxRows?: number;
}

export interface WorkspaceConfig {
  workspacePath?: string;
  executablePath?: string;
  timeout?: number;
  debug?: boolean;
}

export interface ConnectionTest {
  connectionId: string;
  success: boolean;
  error?: string;
  responseTime: number;
  databaseVersion?: string;
}

export interface DatabaseStats {
  connectionId: string;
  tableCount: number;
  totalSize: string;
  connectionTime: number;
  serverVersion: string;
  uptime?: string;
}

export interface BusinessInsight {
  id: number;
  insight: string;
  created_at: string;
  connection?: string;
  tags?: string[];
}

export interface TableResource {
  connectionId: string;
  tableName: string;
  schema?: string;
  uri: string;
}

// Transaction types
export interface Transaction {
  id: string;
  connectionId: string;
  startedAt: Date;
  status: 'active' | 'committed' | 'rolled_back';
}

export interface TransactionResult {
  transactionId: string;
  status: 'started' | 'committed' | 'rolled_back';
  message: string;
}

// Connection pool types
export interface PoolConfig {
  min: number;
  max: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

export interface PoolStats {
  connectionId: string;
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitingRequests: number;
}

// Explain/Query plan types
export interface ExplainResult {
  query: string;
  plan: QueryPlanNode[];
  executionTime?: number;
  planningTime?: number;
  totalCost?: number;
  format: 'text' | 'json';
}

export interface QueryPlanNode {
  operation: string;
  object?: string;
  cost?: number;
  rows?: number;
  width?: number;
  actualTime?: number;
  actualRows?: number;
  children?: QueryPlanNode[];
  details?: Record<string, unknown>;
}

// Schema diff types
export interface SchemaDiff {
  sourceConnection: string;
  targetConnection: string;
  differences: TableDiff[];
  summary: DiffSummary;
}

export interface TableDiff {
  tableName: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  columnDiffs?: ColumnDiff[];
  indexDiffs?: IndexDiff[];
}

export interface ColumnDiff {
  columnName: string;
  status: 'added' | 'removed' | 'modified';
  sourceType?: string;
  targetType?: string;
  changes?: string[];
}

export interface IndexDiff {
  indexName: string;
  status: 'added' | 'removed' | 'modified';
  changes?: string[];
}

export interface DiffSummary {
  tablesAdded: number;
  tablesRemoved: number;
  tablesModified: number;
  totalDifferences: number;
}
