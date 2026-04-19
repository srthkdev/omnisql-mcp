import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helper type that pairs a Zod schema with its JSON Schema equivalent
// for MCP tool registration.
// ---------------------------------------------------------------------------

export interface ToolSchemaDefinition {
  zodSchema: z.ZodObject<any>;
  jsonSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Connection tools
// ═══════════════════════════════════════════════════════════════════════════

export const ListConnectionsInput = z.object({
  includeDetails: z.boolean().default(false),
});

export const ListConnectionsSchema: ToolSchemaDefinition = {
  zodSchema: ListConnectionsInput,
  jsonSchema: {
    type: 'object',
    properties: {
      includeDetails: {
        type: 'boolean',
        description: 'Include detailed connection information',
        default: false,
      },
    },
  },
};

// ---------------------------------------------------------------------------

export const GetConnectionInfoInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
});

export const GetConnectionInfoSchema: ToolSchemaDefinition = {
  zodSchema: GetConnectionInfoInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
    },
    required: ['connectionId'],
  },
};

// ---------------------------------------------------------------------------

export const TestConnectionInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
});

export const TestConnectionSchema: ToolSchemaDefinition = {
  zodSchema: TestConnectionInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection to test',
      },
    },
    required: ['connectionId'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Query tools
// ═══════════════════════════════════════════════════════════════════════════

export const ExecuteQueryInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'Query is required'),
  maxRows: z.number().int().min(1).max(100000).default(1000),
});

export const ExecuteQuerySchema: ToolSchemaDefinition = {
  zodSchema: ExecuteQueryInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection to use',
      },
      query: {
        type: 'string',
        description: 'The SQL query to execute (SELECT statements only)',
      },
      maxRows: {
        type: 'number',
        description: 'Maximum number of rows to return (default: 1000)',
        default: 1000,
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ---------------------------------------------------------------------------

export const WriteQueryInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'Query is required'),
});

export const WriteQuerySchema: ToolSchemaDefinition = {
  zodSchema: WriteQueryInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection to use',
      },
      query: {
        type: 'string',
        description: 'The SQL query to execute (INSERT, UPDATE, DELETE)',
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ---------------------------------------------------------------------------

export const ExportDataInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'Query is required'),
  format: z.enum(['csv', 'json']).default('csv'),
  includeHeaders: z.boolean().default(true),
  maxRows: z.number().int().min(1).max(1000000).default(10000),
});

export const ExportDataSchema: ToolSchemaDefinition = {
  zodSchema: ExportDataInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      query: {
        type: 'string',
        description: 'The SQL query to execute for export (SELECT only)',
      },
      format: {
        type: 'string',
        enum: ['csv', 'json'],
        description: 'Export format (csv or json)',
        default: 'csv',
      },
      includeHeaders: {
        type: 'boolean',
        description: 'Include column headers in export',
        default: true,
      },
      maxRows: {
        type: 'number',
        description: 'Maximum number of rows to export',
        default: 10000,
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Schema tools
// ═══════════════════════════════════════════════════════════════════════════

export const ListTablesInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  schema: z.string().optional(),
  includeViews: z.boolean().default(false),
});

export const ListTablesSchema: ToolSchemaDefinition = {
  zodSchema: ListTablesInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      schema: {
        type: 'string',
        description: 'Specific schema to list tables from (optional)',
      },
      includeViews: {
        type: 'boolean',
        description: 'Include views in the results',
        default: false,
      },
    },
    required: ['connectionId'],
  },
};

// ---------------------------------------------------------------------------

export const GetTableSchemaInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  tableName: z.string().min(1, 'Table name is required'),
  includeIndexes: z.boolean().default(true),
});

export const GetTableSchemaSchema: ToolSchemaDefinition = {
  zodSchema: GetTableSchemaInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      tableName: {
        type: 'string',
        description: 'The name of the table to describe',
      },
      includeIndexes: {
        type: 'boolean',
        description: 'Include index information',
        default: true,
      },
    },
    required: ['connectionId', 'tableName'],
  },
};

// ---------------------------------------------------------------------------

export const CreateTableInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'CREATE TABLE statement is required'),
});

export const CreateTableSchema: ToolSchemaDefinition = {
  zodSchema: CreateTableInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      query: {
        type: 'string',
        description: 'CREATE TABLE statement',
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ---------------------------------------------------------------------------

export const AlterTableInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'ALTER TABLE statement is required'),
});

export const AlterTableSchema: ToolSchemaDefinition = {
  zodSchema: AlterTableInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      query: {
        type: 'string',
        description: 'ALTER TABLE statement',
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ---------------------------------------------------------------------------

export const DropTableInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  tableName: z.string().min(1, 'Table name is required'),
  confirm: z.boolean(),
});

export const DropTableSchema: ToolSchemaDefinition = {
  zodSchema: DropTableInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      tableName: {
        type: 'string',
        description: 'Name of the table to drop',
      },
      confirm: {
        type: 'boolean',
        description: 'Safety confirmation flag (must be true)',
      },
    },
    required: ['connectionId', 'tableName', 'confirm'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Transaction tools
// ═══════════════════════════════════════════════════════════════════════════

export const BeginTransactionInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
});

export const BeginTransactionSchema: ToolSchemaDefinition = {
  zodSchema: BeginTransactionInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
    },
    required: ['connectionId'],
  },
};

// ---------------------------------------------------------------------------

export const CommitTransactionInput = z.object({
  transactionId: z.string().min(1, 'Transaction ID is required'),
});

export const CommitTransactionSchema: ToolSchemaDefinition = {
  zodSchema: CommitTransactionInput,
  jsonSchema: {
    type: 'object',
    properties: {
      transactionId: {
        type: 'string',
        description: 'The transaction ID returned by begin_transaction',
      },
    },
    required: ['transactionId'],
  },
};

// ---------------------------------------------------------------------------

export const RollbackTransactionInput = z.object({
  transactionId: z.string().min(1, 'Transaction ID is required'),
});

export const RollbackTransactionSchema: ToolSchemaDefinition = {
  zodSchema: RollbackTransactionInput,
  jsonSchema: {
    type: 'object',
    properties: {
      transactionId: {
        type: 'string',
        description: 'The transaction ID returned by begin_transaction',
      },
    },
    required: ['transactionId'],
  },
};

// ---------------------------------------------------------------------------

export const ExecuteInTransactionInput = z.object({
  transactionId: z.string().min(1, 'Transaction ID is required'),
  query: z.string().min(1, 'Query is required'),
});

export const ExecuteInTransactionSchema: ToolSchemaDefinition = {
  zodSchema: ExecuteInTransactionInput,
  jsonSchema: {
    type: 'object',
    properties: {
      transactionId: {
        type: 'string',
        description: 'The transaction ID returned by begin_transaction',
      },
      query: {
        type: 'string',
        description: 'The SQL query to execute',
      },
    },
    required: ['transactionId', 'query'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Analysis tools
// ═══════════════════════════════════════════════════════════════════════════

export const ExplainQueryInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
  query: z.string().min(1, 'Query is required'),
  analyze: z.boolean().default(false),
  format: z.enum(['text', 'json']).default('text'),
});

export const ExplainQuerySchema: ToolSchemaDefinition = {
  zodSchema: ExplainQueryInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
      query: {
        type: 'string',
        description: 'The SQL query to analyze',
      },
      analyze: {
        type: 'boolean',
        description: 'Run EXPLAIN ANALYZE for actual execution stats',
        default: false,
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format for the execution plan',
        default: 'text',
      },
    },
    required: ['connectionId', 'query'],
  },
};

// ---------------------------------------------------------------------------

export const CompareSchemasInput = z.object({
  sourceConnectionId: z.string().min(1, 'Source connection ID is required'),
  targetConnectionId: z.string().min(1, 'Target connection ID is required'),
  includeMigrationScript: z.boolean().default(false),
});

export const CompareSchemasSchema: ToolSchemaDefinition = {
  zodSchema: CompareSchemasInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sourceConnectionId: {
        type: 'string',
        description: 'The source connection ID to compare from',
      },
      targetConnectionId: {
        type: 'string',
        description: 'The target connection ID to compare to',
      },
      includeMigrationScript: {
        type: 'boolean',
        description: 'Generate SQL migration script',
        default: false,
      },
    },
    required: ['sourceConnectionId', 'targetConnectionId'],
  },
};

// ---------------------------------------------------------------------------

export const GetPoolStatsInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
});

export const GetPoolStatsSchema: ToolSchemaDefinition = {
  zodSchema: GetPoolStatsInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
    },
    required: ['connectionId'],
  },
};

// ---------------------------------------------------------------------------

export const GetDatabaseStatsInput = z.object({
  connectionId: z.string().min(1, 'Connection ID is required'),
});

export const GetDatabaseStatsSchema: ToolSchemaDefinition = {
  zodSchema: GetDatabaseStatsInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        description: 'The ID or name of the DBeaver connection',
      },
    },
    required: ['connectionId'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Insight tools
// ═══════════════════════════════════════════════════════════════════════════

export const AppendInsightInput = z.object({
  insight: z.string().min(1, 'Insight text is required'),
  connection: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const AppendInsightSchema: ToolSchemaDefinition = {
  zodSchema: AppendInsightInput,
  jsonSchema: {
    type: 'object',
    properties: {
      insight: {
        type: 'string',
        description: 'The business insight or analysis note to store',
      },
      connection: {
        type: 'string',
        description: 'Optional connection ID to associate with this insight',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags to categorize the insight',
      },
    },
    required: ['insight'],
  },
};

// ---------------------------------------------------------------------------

export const ListInsightsInput = z.object({
  connection: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const ListInsightsSchema: ToolSchemaDefinition = {
  zodSchema: ListInsightsInput,
  jsonSchema: {
    type: 'object',
    properties: {
      connection: {
        type: 'string',
        description: 'Filter insights by connection ID (optional)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter insights by tags (optional)',
      },
    },
  },
};
