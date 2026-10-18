import type {
  ConstraintInfo,
  SchemaInfo,
  SchemaDiff,
  TableDiff,
  ColumnDiff,
  DiffSummary,
} from '../types.js';

interface TableSchema {
  physicalKeys?: Record<string, string>;
  tableName: string;
  columns: Map<string, ColumnSchema>;
  indexes: Map<string, IndexSchema>;
  constraints?: Map<string, ConstraintInfo>;
}

interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
}

interface IndexSchema {
  type?: string;
  predicate?: string;
  name: string;
  columns: string[];
  unique: boolean;
}

/**
 * Compare schemas between two connections
 */
export async function compareSchemas(
  sourceTables: TableSchema[],
  targetTables: TableSchema[],
  sourceConnectionId: string,
  targetConnectionId: string
): Promise<SchemaDiff> {
  const sourceMap = new Map(sourceTables.map((t) => [t.tableName, t]));
  const targetMap = new Map(targetTables.map((t) => [t.tableName, t]));

  const differences: TableDiff[] = [];
  const processedTables = new Set<string>();

  // Check tables in source
  for (const [tableName, sourceTable] of sourceMap) {
    processedTables.add(tableName);
    const targetTable = targetMap.get(tableName);

    if (!targetTable) {
      // Table exists in source but not in target (removed in target)
      differences.push({
        tableName: sourceTable.tableName,
        status: 'removed',
      });
    } else {
      // Table exists in both - compare columns
      const columnDiffs = compareColumns(sourceTable.columns, targetTable.columns);
      const indexDiffs = compareIndexes(sourceTable.indexes, targetTable.indexes);
      const constraintDiffs = compareConstraints(
        sourceTable.constraints ?? new Map(),
        targetTable.constraints ?? new Map()
      );

      const physicalKeyDiffs = [
        ...new Set([
          ...Object.keys(sourceTable.physicalKeys ?? {}),
          ...Object.keys(targetTable.physicalKeys ?? {}),
        ]),
      ]
        .filter((kind) => sourceTable.physicalKeys?.[kind] !== targetTable.physicalKeys?.[kind])
        .map((kind) => ({
          kind,
          before: sourceTable.physicalKeys?.[kind],
          after: targetTable.physicalKeys?.[kind],
        }));
      if (
        columnDiffs.length > 0 ||
        indexDiffs.length > 0 ||
        constraintDiffs.length > 0 ||
        physicalKeyDiffs.length > 0
      ) {
        differences.push({
          tableName: sourceTable.tableName,
          status: 'modified',
          columnDiffs,
          indexDiffs,
          constraintDiffs,
          ...(physicalKeyDiffs.length ? { physicalKeyDiffs } : {}),
        });
      }
    }
  }

  // Check tables only in target (added)
  for (const [tableName, targetTable] of targetMap) {
    if (!processedTables.has(tableName)) {
      differences.push({
        tableName: targetTable.tableName,
        status: 'added',
      });
    }
  }

  // Calculate summary
  const summary: DiffSummary = {
    tablesAdded: differences.filter((d) => d.status === 'added').length,
    tablesRemoved: differences.filter((d) => d.status === 'removed').length,
    tablesModified: differences.filter((d) => d.status === 'modified').length,
    totalDifferences: differences.length,
  };

  return {
    sourceConnection: sourceConnectionId,
    targetConnection: targetConnectionId,
    differences,
    summary,
  };
}

function compareColumns(
  sourceColumns: Map<string, ColumnSchema>,
  targetColumns: Map<string, ColumnSchema>
): ColumnDiff[] {
  const diffs: ColumnDiff[] = [];
  const processedColumns = new Set<string>();

  // Check columns in source
  for (const [colName, sourceCol] of sourceColumns) {
    processedColumns.add(colName);
    const targetCol = targetColumns.get(colName);

    if (!targetCol) {
      diffs.push({
        columnName: sourceCol.name,
        status: 'removed',
        sourceType: sourceCol.type,
      });
    } else {
      const changes: string[] = [];

      if (normalizeType(sourceCol.type) !== normalizeType(targetCol.type)) {
        changes.push(`type: ${sourceCol.type} -> ${targetCol.type}`);
      }
      if (sourceCol.nullable !== targetCol.nullable) {
        changes.push(`nullable: ${sourceCol.nullable} -> ${targetCol.nullable}`);
      }
      if (sourceCol.defaultValue !== targetCol.defaultValue) {
        changes.push(
          `default: ${sourceCol.defaultValue || 'NULL'} -> ${targetCol.defaultValue || 'NULL'}`
        );
      }

      if (changes.length > 0) {
        diffs.push({
          columnName: sourceCol.name,
          status: 'modified',
          sourceType: sourceCol.type,
          targetType: targetCol.type,
          changes,
        });
      }
    }
  }

  // Check columns only in target (added)
  for (const [colName, targetCol] of targetColumns) {
    if (!processedColumns.has(colName)) {
      diffs.push({
        columnName: targetCol.name,
        status: 'added',
        targetType: targetCol.type,
      });
    }
  }

  return diffs;
}

function compareIndexes(
  sourceIndexes: Map<string, IndexSchema>,
  targetIndexes: Map<string, IndexSchema>
): { indexName: string; status: 'added' | 'removed' | 'modified'; changes?: string[] }[] {
  const diffs: {
    indexName: string;
    status: 'added' | 'removed' | 'modified';
    changes?: string[];
  }[] = [];
  const processedIndexes = new Set<string>();

  for (const [indexName, sourceIdx] of sourceIndexes) {
    processedIndexes.add(indexName);
    const targetIdx = targetIndexes.get(indexName);

    if (!targetIdx) {
      diffs.push({ indexName: sourceIdx.name, status: 'removed' });
    } else {
      const changes: string[] = [];

      if (JSON.stringify(sourceIdx.columns) !== JSON.stringify(targetIdx.columns)) {
        changes.push(
          `columns: [${sourceIdx.columns.join(', ')}] -> [${targetIdx.columns.join(', ')}]`
        );
      }
      if (sourceIdx.unique !== targetIdx.unique) {
        changes.push(`unique: ${sourceIdx.unique} -> ${targetIdx.unique}`);
      }

      if (sourceIdx.type !== targetIdx.type)
        changes.push(`method: ${sourceIdx.type} -> ${targetIdx.type}`);
      if (sourceIdx.predicate !== targetIdx.predicate)
        changes.push(`predicate: ${sourceIdx.predicate} -> ${targetIdx.predicate}`);
      if (changes.length > 0) {
        diffs.push({ indexName: sourceIdx.name, status: 'modified', changes });
      }
    }
  }

  for (const [indexName, targetIdx] of targetIndexes) {
    if (!processedIndexes.has(indexName)) {
      diffs.push({ indexName: targetIdx.name, status: 'added' });
    }
  }

  return diffs;
}

function compareConstraints(
  source: Map<string, ConstraintInfo>,
  target: Map<string, ConstraintInfo>
) {
  const diffs: {
    constraintName: string;
    status: 'added' | 'removed' | 'modified';
    changes?: string[];
  }[] = [];
  for (const [name, c] of source) {
    const t = target.get(name);
    if (!t) {
      diffs.push({ constraintName: name, status: 'removed' });
      continue;
    }
    const changes = [];
    for (const key of [
      'type',
      'columns',
      'referencedTable',
      'referencedColumns',
      'definition',
    ] as const)
      if (JSON.stringify(c[key]) !== JSON.stringify(t[key])) changes.push(`${key} changed`);
    if (changes.length) diffs.push({ constraintName: name, status: 'modified', changes });
  }
  for (const name of target.keys())
    if (!source.has(name)) diffs.push({ constraintName: name, status: 'added' });
  return diffs;
}

/**
 * Normalize SQL type for comparison (handles variations like INT vs INTEGER)
 */
function normalizeType(type: string): string {
  let normalized = '',
    quote = '',
    gap = false;
  for (let i = 0; i < type.length; i++) {
    const char = type[i];
    if (quote) {
      normalized += char;
      if (char === '\\' && i + 1 < type.length) normalized += type[++i];
      else if (char === quote) {
        if (type[i + 1] === quote) normalized += type[++i];
        else quote = '';
      }
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      normalized += char;
      gap = false;
    } else if (/\s/.test(char)) gap = true;
    else {
      if (gap && /[a-zA-Z0-9_]/.test(normalized.at(-1) ?? '') && /[a-zA-Z0-9_]/.test(char))
        normalized += ' ';
      normalized += char.replace(/[A-Z]/g, (c) => c.toLowerCase());
      gap = false;
    }
  }

  const typeMap: Record<string, string> = {
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    bool: 'boolean',
    float4: 'real',
    float8: 'double precision',
    varchar: 'character varying',
    char: 'character',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
  };

  const alias = normalized.match(/^([a-z][a-z ]*)(?=\(|$)/)?.[1];
  return alias && typeMap[alias] ? typeMap[alias] + normalized.slice(alias.length) : normalized;
}

export function comparableSchema(schema: SchemaInfo): TableSchema {
  if (schema.partial)
    throw new Error(
      'Cannot compare incomplete schema metadata; grant the required catalog access or narrow the scope'
    );
  const type = (column: SchemaInfo['columns'][number]) => {
    if (column.type.includes('(')) return column.type;
    if (
      /^(?:character varying|varchar|nvarchar|character|char|nchar|binary|varbinary)$/i.test(
        column.type
      ) &&
      column.length !== undefined
    )
      return `${column.type}(${column.length === -1 ? 'max' : column.length})`;
    if (/^(?:decimal|numeric|number)$/i.test(column.type) && column.precision !== undefined)
      return `${column.type}(${column.precision}${column.scale === undefined ? '' : ',' + column.scale})`;
    return column.type;
  };
  return {
    tableName: schema.tableName,
    physicalKeys: schema.physicalKeys,
    constraints: new Map(schema.constraints.map((k) => [k.name, k])),
    columns: new Map(
      schema.columns.map((c) => [
        c.name,
        {
          name: c.name,
          type: type(c),
          nullable: c.nullable,
          defaultValue: c.defaultValue ?? undefined,
        },
      ])
    ),
    indexes: new Map(
      schema.indexes.map((i) => [
        i.name,
        {
          name: i.name,
          columns: i.columns,
          unique: i.unique,
          type: i.type,
          predicate: i.predicate,
        },
      ])
    ),
  };
}

/**
 * Generate SQL migration script from schema diff
 */
export function generateMigrationScript(diff: SchemaDiff, driver: string): string {
  const lines = [
    `-- Schema difference review: ${diff.sourceConnection} -> ${diff.targetConnection}`,
    `-- Generated at ${new Date().toISOString()}`,
    '-- Review data compatibility, defaults, constraints, and locking before applying changes.',
  ];
  const mysql = /mysql|mariadb/i.test(driver),
    mssql = /mssql|sqlserver/i.test(driver),
    postgres = /postgres/i.test(driver);
  const quote = (name: string) =>
    name
      .split('.')
      .map((p) =>
        mysql
          ? '`' + p.replace(/`/g, '``') + '`'
          : mssql
            ? '[' + p.replace(/]/g, ']]') + ']'
            : '"' + p.replace(/"/g, '""') + '"'
      )
      .join('.');
  for (const t of diff.differences) {
    lines.push('', `-- ${t.status}: ${t.tableName}`);
    if (t.status !== 'modified') {
      lines.push('-- Complete table definition and dependency review required.');
      continue;
    }
    for (const c of t.columnDiffs ?? []) {
      lines.push(
        `-- ${c.status}: ${c.columnName}${c.changes?.length ? '; ' + c.changes.join('; ') : ''}`
      );
      // A type-only PostgreSQL alteration is self-contained. Other changes need
      // complete target definitions, which this difference object does not carry.
      if (
        c.status === 'modified' &&
        postgres &&
        c.changes?.some((change) => change.startsWith('type:'))
      ) {
        lines.push(
          `-- ALTER TABLE ${quote(t.tableName)} ALTER COLUMN ${quote(c.columnName)} TYPE ${c.targetType};`
        );
      } else
        lines.push(
          '-- Generate a migration from the complete target schema before applying this change.'
        );
    }
    for (const k of t.physicalKeyDiffs ?? [])
      lines.push(`-- Changed ${quote(k.kind)} storage key: review target expression.`);
    for (const c of t.constraintDiffs ?? [])
      lines.push(`-- ${c.status} constraint ${quote(c.constraintName)}: review target definition.`);
    for (const i of t.indexDiffs ?? [])
      lines.push(`-- ${i.status} index ${quote(i.indexName)}: review complete index definition.`);
  }
  return lines.map((line) => line.replace(/[\r\n\u2028\u2029]/g, ' ')).join('\n');
}
