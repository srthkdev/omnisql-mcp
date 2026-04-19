/**
 * Resolve the DB client CLI executable path.
 *
 * The CLI fallback is only used for drivers without a native implementation.
 * Configure the path explicitly via the OMNISQL_CLI_PATH environment variable.
 * Returns an empty string when not configured; callers must handle this case.
 */
export function findCliExecutable(): string {
  return process.env.OMNISQL_CLI_PATH ?? '';
}

/**
 * Validate SQL query for basic safety
 */
export function validateQuery(query: string): string | null {
  if (!query || query.trim().length === 0) {
    return 'Query cannot be empty';
  }

  const trimmedQuery = query.trim().toLowerCase();

  // Block potentially dangerous operations
  const dangerousPatterns = [
    /drop\s+database/i,
    /drop\s+schema/i,
    /truncate\s+table/i,
    /delete\s+from\s+\w+\s*;?\s*$/i, // DELETE without WHERE clause
    /update\s+(?:(?!where).)*\s*;?\s*$/i, // UPDATE without WHERE clause
    /grant\s+/i,
    /revoke\s+/i,
    /create\s+user/i,
    /drop\s+user/i,
    /alter\s+user/i,
    /shutdown/i,
    /restart/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmedQuery)) {
      return `Potentially dangerous query detected. Query blocked for safety.`;
    }
  }

  // Warn about operations that modify data
  const modifyingPatterns = [
    /^insert\s+/i,
    /^update\s+/i,
    /^delete\s+/i,
    /^create\s+/i,
    /^alter\s+/i,
    /^drop\s+/i,
  ];

  for (const pattern of modifyingPatterns) {
    if (pattern.test(trimmedQuery)) {
      // Allow but note - could add confirmation in future
      break;
    }
  }

  return null; // Query is valid
}

/**
 * Check if a query is read-only (SELECT, EXPLAIN, WITH...SELECT, SHOW, DESCRIBE, etc.)
 * Returns null if the query is read-only, or an error message if it's a write operation.
 */
export function enforceReadOnly(query: string): string | null {
  if (!query || query.trim().length === 0) {
    return 'Query cannot be empty';
  }

  const trimmed = query.trim().toLowerCase();

  // Allow read-only statements
  const readOnlyPrefixes = [
    /^select\s/,
    /^select$/, // bare SELECT (e.g. SELECT 1)
    /^with\s/, // CTEs that start with WITH
    /^explain\s/,
    /^show\s/,
    /^describe\s/,
    /^desc\s/,
    /^pragma\s/, // SQLite PRAGMA
    /^set\s+search_path/, // PostgreSQL search_path is safe
  ];

  for (const pattern of readOnlyPrefixes) {
    if (pattern.test(trimmed)) {
      return null; // Query is read-only
    }
  }

  return 'Only read-only queries (SELECT, EXPLAIN, SHOW, DESCRIBE) are allowed in read-only mode. Use write_query for data modifications.';
}

/**
 * Sanitize connection ID to prevent injection
 */
export function sanitizeConnectionId(connectionId: string): string {
  if (!connectionId || typeof connectionId !== 'string') {
    throw new Error('Connection ID must be a non-empty string');
  }

  // Remove potentially dangerous characters
  const sanitized = connectionId.replace(/[^a-zA-Z0-9_\-.]/g, '');

  if (sanitized.length === 0) {
    throw new Error('Connection ID contains no valid characters');
  }

  return sanitized;
}

/**
 * Sanitize SQL identifier (table name, schema name, column name)
 * Escapes single quotes and validates the identifier
 */
export function sanitizeIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Identifier must be a non-empty string');
  }

  // Remove or escape dangerous characters
  // Allow alphanumeric, underscore, and dots (for schema.table notation)
  const sanitized = identifier.trim();

  // Check for SQL injection patterns
  if (/['";\\]/.test(sanitized)) {
    throw new Error('Identifier contains invalid characters');
  }

  // Check for suspicious patterns (SQL comments, semicolons)
  if (/--|\/\*|\*\/|;/.test(sanitized)) {
    throw new Error('Identifier contains suspicious patterns');
  }

  // Validate length
  if (sanitized.length > 128) {
    throw new Error('Identifier too long (max 128 characters)');
  }

  // Must start with letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    throw new Error('Identifier must start with a letter or underscore');
  }

  // Only allow safe characters
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized)) {
    throw new Error('Identifier contains invalid characters');
  }

  return sanitized;
}

/**
 * Redact sensitive fields from a connection object before returning to clients.
 * Strips passwords and other credentials to prevent credential leaks.
 */
export function redactConnection(conn: Record<string, any>): Record<string, any> {
  const redacted = { ...conn };

  // Redact password from top-level properties
  if (redacted.properties) {
    const props = { ...redacted.properties };
    const sensitiveKeys = ['password', 'secretkey', 'secret', 'token', 'apikey', 'api_key'];
    for (const key of Object.keys(props)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        props[key] = '***REDACTED***';
      }
    }
    redacted.properties = props;
  }

  return redacted;
}

/**
 * Redact sensitive fields from tool arguments before debug logging.
 */
export function redactArgs(args: Record<string, any>): Record<string, any> {
  const redacted = { ...args };
  const sensitiveKeys = ['password', 'secret', 'token', 'apikey', 'api_key', 'credential'];
  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      redacted[key] = '***REDACTED***';
    }
  }
  return redacted;
}

/**
 * Format error messages consistently
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return String(error);
}

/**
 * Get test query based on database driver
 */
export function getTestQuery(driver: string): string {
  const driverLower = driver.toLowerCase();

  if (driverLower.includes('postgresql') || driverLower.includes('postgres')) {
    return 'SELECT version();';
  } else if (driverLower.includes('mysql')) {
    return 'SELECT version();';
  } else if (driverLower.includes('oracle')) {
    return 'SELECT * FROM dual;';
  } else if (driverLower.includes('sqlite')) {
    return 'SELECT sqlite_version();';
  } else if (driverLower.includes('mssql') || driverLower.includes('sqlserver')) {
    return 'SELECT @@VERSION;';
  } else if (driverLower.includes('hana') || driverLower.includes('sap')) {
    return 'SELECT * FROM DUMMY;';
  } else if (driverLower.includes('db2')) {
    return 'SELECT 1 FROM SYSIBM.SYSDUMMY1;';
  } else if (driverLower.includes('mongodb')) {
    return 'db.version()';
  } else if (driverLower.includes('redis')) {
    return 'INFO server';
  } else {
    // Generic test query
    return 'SELECT 1;';
  }
}

/**
 * Build schema query based on database driver
 */
export function buildSchemaQuery(driver: string, tableName: string): string {
  const driverLower = driver.toLowerCase();
  const safeTableName = sanitizeIdentifier(tableName);

  if (driverLower.includes('postgresql') || driverLower.includes('postgres')) {
    return `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_name = '${safeTableName}'
      ORDER BY ordinal_position;
    `;
  } else if (driverLower.includes('mysql')) {
    return `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
        NUMERIC_PRECISION as numeric_precision,
        NUMERIC_SCALE as numeric_scale,
        COLUMN_KEY as column_key,
        EXTRA as extra
      FROM information_schema.COLUMNS
      WHERE TABLE_NAME = '${safeTableName}'
      ORDER BY ORDINAL_POSITION;
    `;
  } else if (driverLower.includes('sqlite')) {
    return `PRAGMA table_info(${safeTableName});`;
  } else if (driverLower.includes('oracle')) {
    return `
      SELECT
        column_name,
        data_type,
        nullable,
        data_default,
        data_length,
        data_precision,
        data_scale
      FROM user_tab_columns
      WHERE table_name = UPPER('${safeTableName}')
      ORDER BY column_id;
    `;
  } else if (driverLower.includes('mssql') || driverLower.includes('sqlserver')) {
    return `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
        NUMERIC_PRECISION as numeric_precision,
        NUMERIC_SCALE as numeric_scale
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = '${safeTableName}'
      ORDER BY ORDINAL_POSITION;
    `;
  } else {
    // Generic fallback
    return `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = '${safeTableName}';
    `;
  }
}

/**
 * Build list tables query based on database driver
 */
export function buildListTablesQuery(
  driver: string,
  schema?: string,
  includeViews: boolean = false
): string {
  const driverLower = driver.toLowerCase();
  const safeSchema = schema ? sanitizeIdentifier(schema) : null;

  if (driverLower.includes('postgresql') || driverLower.includes('postgres')) {
    let query = `
      SELECT
        table_name,
        table_type,
        table_schema
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    `;

    if (safeSchema) {
      query += ` AND table_schema = '${safeSchema}'`;
    }

    if (!includeViews) {
      query += ` AND table_type = 'BASE TABLE'`;
    }

    query += ` ORDER BY table_schema, table_name;`;
    return query;
  } else if (driverLower.includes('mysql')) {
    let query = `
      SELECT
        TABLE_NAME as table_name,
        TABLE_TYPE as table_type,
        TABLE_SCHEMA as table_schema
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    `;

    if (safeSchema) {
      query += ` AND TABLE_SCHEMA = '${safeSchema}'`;
    }

    if (!includeViews) {
      query += ` AND TABLE_TYPE = 'BASE TABLE'`;
    }

    query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME;`;
    return query;
  } else if (driverLower.includes('sqlite')) {
    const query = `
      SELECT
        name as table_name,
        type as table_type
      FROM sqlite_master
      WHERE type IN ('table'${includeViews ? ", 'view'" : ''})
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `;
    return query;
  } else if (driverLower.includes('oracle')) {
    let query = `
      SELECT
        table_name,
        'TABLE' as table_type,
        owner as table_schema
      FROM all_tables
    `;

    if (safeSchema) {
      query += ` WHERE owner = UPPER('${safeSchema}')`;
    }

    if (includeViews) {
      query += `
        UNION ALL
        SELECT
          view_name as table_name,
          'VIEW' as table_type,
          owner as table_schema
        FROM all_views
      `;

      if (safeSchema) {
        query += ` WHERE owner = UPPER('${safeSchema}')`;
      }
    }

    query += ` ORDER BY table_name;`;
    return query;
  } else {
    // Generic fallback
    let query = `
      SELECT
        table_name,
        table_type,
        table_schema
      FROM information_schema.tables
    `;

    if (safeSchema) {
      query += ` WHERE table_schema = '${safeSchema}'`;
    }

    if (!includeViews) {
      query += `${safeSchema ? ' AND' : ' WHERE'} table_type = 'BASE TABLE'`;
    }

    query += ` ORDER BY table_schema, table_name;`;
    return query;
  }
}

/**
 * Parse database version from query result
 */
export function parseVersionFromResult(result: any): string | undefined {
  if (!result || !result.rows || result.rows.length === 0) {
    return undefined;
  }

  const firstRow = result.rows[0];
  if (Array.isArray(firstRow) && firstRow.length > 0) {
    return String(firstRow[0]);
  } else if (firstRow && typeof firstRow === 'object') {
    const firstValue = Object.values(firstRow)[0];
    return firstValue !== undefined ? String(firstValue) : undefined;
  }
  return undefined;
}

/**
 * Convert query results to CSV format
 */
export function convertToCSV(columns: string[], rows: any[][]): string {
  if (rows.length === 0) return '';

  // Create CSV header row
  let csv = columns.map((col) => `"${col.replace(/"/g, '""')}"`).join(',') + '\n';

  // Add data rows
  rows.forEach((row) => {
    const values = row.map((val) => {
      // Handle null/undefined values
      if (val === null || val === undefined) {
        return '';
      }

      // Convert to string and escape quotes
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    });
    csv += values.join(',') + '\n';
  });

  return csv;
}
