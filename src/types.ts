export interface DBeaverConnection {
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
  format: 'csv' | 'json';
  includeHeaders: boolean;
  delimiter?: string;
  encoding?: string;
  maxRows?: number;
}

// Driver system types
export type DriverDialect = 'postgres' | 'mysql' | 'mssql' | 'sqlite';

export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: any;
  timeout?: number;
  poolConfig?: PoolConfig;
  properties?: Record<string, string>;
}

export interface ExecuteResult {
  affectedRows: number;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  schema?: string;
}

// Tool system types
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

export interface ToolContext {
  connectionRegistry: ConnectionRegistryInterface;
  driverRegistry: DriverRegistryInterface;
  safetyLayer: SafetyLayerInterface;
  transactionManager: TransactionManagerInterface;
  config: ServerConfig;
  log: (message: string, level?: 'info' | 'error' | 'debug') => void;
}

export interface ServerConfig {
  debug: boolean;
  readOnly: boolean;
  disabledTools: string[];
  allowedConnections: Set<string> | null;
  timeout: number;
}

// Access control types
export interface AccessRules {
  readOnly: boolean;
  allowInsert: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
  allowDDL: boolean;
}

// Interfaces for dependency injection
export interface ConnectionRegistryInterface {
  getConnection(id: string): Promise<DBeaverConnection | null>;
  getAllConnections(): Promise<DBeaverConnection[]>;
}

export interface DriverRegistryInterface {
  getDriver(connection: DBeaverConnection): Promise<DatabaseDriverInterface>;
  closeAll(): Promise<void>;
}

export interface DatabaseDriverInterface {
  readonly name: string;
  readonly dialect: DriverDialect;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  getSchema(table: string): Promise<SchemaInfo>;
  listTables(schema?: string, includeViews?: boolean): Promise<TableInfo[]>;
  getStats(): Promise<DatabaseStats>;
  testConnection(): Promise<ConnectionTest>;
  getPoolStats(): PoolStats | null;
  disconnect(): Promise<void>;
}

export interface SafetyLayerInterface {
  classifyQuery(sql: string): { type: string; isReadOnly: boolean };
  validateQuery(sql: string, rules: AccessRules): string | null;
  enforceReadOnly(sql: string): string | null;
  quoteIdentifier(identifier: string, dialect: DriverDialect): string;
  sanitizeIdentifier(identifier: string): string;
}

export interface TransactionManagerInterface {
  beginTransaction(connection: DBeaverConnection): Promise<TransactionResult>;
  commitTransaction(transactionId: string): Promise<TransactionResult>;
  rollbackTransaction(transactionId: string): Promise<TransactionResult>;
  executeInTransaction(
    transactionId: string,
    query: string
  ): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }>;
  rollbackAll(): Promise<number>;
  cleanupStaleTransactions(maxAgeMs?: number): Promise<number>;
  getActiveTransactions(): Transaction[];
}

export interface DBeaverConfig {
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
