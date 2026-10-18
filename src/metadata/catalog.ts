import { sanitizeIdentifier } from '../utils.js';
import { sqlDialect } from '../policy/analyzer.js';
import { DatabaseConnection, QueryResult, IndexInfo, ConstraintInfo } from '../types.js';
export type CatalogQuery = (sql: string) => Promise<QueryResult>;
export function records(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((c, i) => [c.toLowerCase(), row[i]]))
  );
}
export function tableParts(connection: DatabaseConnection, name: string) {
  const parts = name.split('.');
  if (parts.length > 2) throw new Error('Expected table or schema.table');
  parts.forEach(sanitizeIdentifier);
  const dialect = sqlDialect(connection.driver);
  const table = parts.at(-1)!;
  const schema =
    parts.length === 2
      ? `'${parts[0]}'`
      : dialect === 'postgres'
        ? 'current_schema()'
        : dialect === 'mysql'
          ? 'DATABASE()'
          : dialect === 'mssql'
            ? 'SCHEMA_NAME()'
            : "SYS_CONTEXT('USERENV','CURRENT_SCHEMA')";
  return { dialect, table, schema };
}
function indexQuery(c: DatabaseConnection, name: string): string | undefined {
  const { dialect, table, schema } = tableParts(c, name);
  if (dialect === 'postgres')
    return `SELECT x.relname AS index_name, pg_get_indexdef(i.indexrelid,k.ordinality::integer,true) AS column_name, k.ordinality AS ordinal_position, i.indisunique AS is_unique, i.indisprimary AS is_primary, am.amname AS index_type, pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred,i.indrelid) AS predicate, i.indisvalid AS is_valid FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) WHERE n.nspname=${schema} AND t.relname='${table}' AND k.ordinality<=i.indnkeyatts ORDER BY x.relname,k.ordinality`;
  if (dialect === 'mysql')
    return `SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS ordinal_position,NON_UNIQUE=0 AS is_unique,INDEX_NAME='PRIMARY' AS is_primary,INDEX_TYPE AS index_type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=${schema} AND TABLE_NAME='${table}' ORDER BY INDEX_NAME,SEQ_IN_INDEX`;
  if (dialect === 'mssql')
    return `SELECT i.name AS index_name,c.name AS column_name,ic.key_ordinal AS ordinal_position,i.is_unique,i.is_primary_key AS is_primary,i.type_desc AS index_type,i.filter_definition AS predicate,i.is_disabled AS is_disabled FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE s.name=${schema} AND t.name='${table}' AND ic.is_included_column=0 AND i.index_id>0 ORDER BY i.name,ic.key_ordinal`;
  if (dialect === 'oracle')
    return `SELECT i.index_name,c.column_name,c.column_position AS ordinal_position,CASE WHEN i.uniqueness='UNIQUE' THEN 1 ELSE 0 END AS is_unique,CASE WHEN p.constraint_type='P' THEN 1 ELSE 0 END AS is_primary,i.index_type,CASE WHEN i.status='VALID' THEN 1 ELSE 0 END AS is_valid FROM all_indexes i JOIN all_ind_columns c ON c.index_owner=i.owner AND c.index_name=i.index_name LEFT JOIN all_constraints p ON p.owner=i.table_owner AND p.table_name=i.table_name AND p.index_name=i.index_name AND p.constraint_type='P' WHERE i.table_owner=UPPER(${schema}) AND i.table_name=UPPER('${table}') ORDER BY i.index_name,c.column_position`;
}
function constraintQuery(c: DatabaseConnection, name: string): string | undefined {
  const { dialect, table, schema } = tableParts(c, name);
  if (dialect === 'postgres')
    return `SELECT k.conname AS constraint_name, CASE k.contype WHEN 'p' THEN 'PRIMARY_KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'f' THEN 'FOREIGN_KEY' WHEN 'c' THEN 'CHECK' END AS constraint_type,a.attname AS column_name,rn.nspname||'.'||rt.relname AS referenced_table,ra.attname AS referenced_column,pg_get_constraintdef(k.oid) AS definition,keys.ordinality AS ordinal_position FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN LATERAL unnest(k.conkey) WITH ORDINALITY keys(attnum,ordinality) ON true LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.attnum LEFT JOIN pg_class rt ON rt.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace LEFT JOIN pg_attribute ra ON ra.attrelid=k.confrelid AND ra.attnum=k.confkey[keys.ordinality] WHERE n.nspname=${schema} AND t.relname='${table}' AND k.contype IN ('p','u','f','c') ORDER BY k.conname,keys.ordinality`;
  if (dialect === 'mysql')
    return `SELECT k.CONSTRAINT_NAME AS constraint_name,REPLACE(k.CONSTRAINT_TYPE,' ','_') AS constraint_type,c.COLUMN_NAME AS column_name,CONCAT(c.REFERENCED_TABLE_SCHEMA,'.',c.REFERENCED_TABLE_NAME) AS referenced_table,c.REFERENCED_COLUMN_NAME AS referenced_column,c.ORDINAL_POSITION AS ordinal_position FROM information_schema.TABLE_CONSTRAINTS k LEFT JOIN information_schema.KEY_COLUMN_USAGE c ON c.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND c.TABLE_NAME=k.TABLE_NAME AND c.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=${schema} AND k.TABLE_NAME='${table}' ORDER BY k.CONSTRAINT_NAME,c.ORDINAL_POSITION`;
  if (dialect === 'oracle')
    return `SELECT k.constraint_name,CASE k.constraint_type WHEN 'P' THEN 'PRIMARY_KEY' WHEN 'U' THEN 'UNIQUE' WHEN 'R' THEN 'FOREIGN_KEY' WHEN 'C' THEN 'CHECK' END AS constraint_type,c.column_name,r.owner||'.'||r.table_name AS referenced_table,rc.column_name AS referenced_column,k.search_condition_vc AS definition,c.position AS ordinal_position FROM all_constraints k LEFT JOIN all_cons_columns c ON c.owner=k.owner AND c.constraint_name=k.constraint_name LEFT JOIN all_constraints r ON r.owner=k.r_owner AND r.constraint_name=k.r_constraint_name LEFT JOIN all_cons_columns rc ON rc.owner=r.owner AND rc.constraint_name=r.constraint_name AND rc.position=c.position WHERE k.owner=UPPER(${schema}) AND k.table_name=UPPER('${table}') AND k.constraint_type IN ('P','U','R','C') ORDER BY k.constraint_name,c.position`;
  if (dialect === 'mssql')
    return `SELECT k.name AS constraint_name,CASE WHEN k.type='PK' THEN 'PRIMARY_KEY' ELSE 'UNIQUE' END AS constraint_type,c.name AS column_name,CAST(NULL AS nvarchar(512)) AS referenced_table,CAST(NULL AS nvarchar(128)) AS referenced_column,CAST(NULL AS nvarchar(max)) AS definition,ic.key_ordinal AS ordinal_position FROM sys.key_constraints k JOIN sys.tables t ON t.object_id=k.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.index_columns ic ON ic.object_id=t.object_id AND ic.index_id=k.unique_index_id JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=ic.column_id WHERE s.name=${schema} AND t.name='${table}' UNION ALL SELECT f.name,'FOREIGN_KEY',pc.name,SCHEMA_NAME(rt.schema_id)+'.'+rt.name,rc.name,NULL,fc.constraint_column_id FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id JOIN sys.tables t ON t.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns pc ON pc.object_id=t.object_id AND pc.column_id=fc.parent_column_id JOIN sys.tables rt ON rt.object_id=f.referenced_object_id JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fc.referenced_column_id WHERE s.name=${schema} AND t.name='${table}' UNION ALL SELECT k.name,'CHECK',c.name,NULL,NULL,k.definition,0 FROM sys.check_constraints k JOIN sys.tables t ON t.object_id=k.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id LEFT JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=k.parent_column_id WHERE s.name=${schema} AND t.name='${table}' ORDER BY constraint_name,ordinal_position`;
}
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
export async function indexesAndConstraints(
  c: DatabaseConnection,
  name: string,
  query: CatalogQuery
): Promise<{ indexes: IndexInfo[]; constraints: ConstraintInfo[]; partial?: boolean }> {
  const dialect = sqlDialect(c.driver);
  const indexes: IndexInfo[] = [];
  const constraints: ConstraintInfo[] = [];
  if (dialect === 'sqlite') {
    const { table } = tableParts(c, name);
    for (const row of records(await query(`PRAGMA index_list('${table}')`))) {
      const indexName = String(row.name);
      const literal = indexName.replace(/'/g, "''");
      const columns = records(await query(`PRAGMA index_xinfo('${literal}')`))
        .filter((r) => Number(r.key) === 1)
        .map((r) => (r.name === null ? '(expression)' : String(r.name)));
      const definition = records(
        await query(`SELECT sql FROM sqlite_master WHERE type='index' AND name='${literal}'`)
      )[0]?.sql;
      indexes.push({
        name: indexName,
        columns,
        unique: bool(row.unique),
        type: 'BTREE',
        primary: row.origin === 'pk',
        ...(definition ? { definition: String(definition) } : {}),
      });
    }
    const fks = new Map<string, ConstraintInfo>();
    for (const row of records(await query(`PRAGMA foreign_key_list('${table}')`))) {
      const key = String(row.id);
      let fk = fks.get(key);
      if (!fk) {
        fk = {
          name: 'foreign_key_' + key,
          type: 'FOREIGN_KEY',
          columns: [],
          referencedTable: String(row.table),
          referencedColumns: [],
          nameIsGenerated: true,
        };
        fks.set(key, fk);
      }
      fk.columns.push(String(row.from));
      fk.referencedColumns!.push(String(row.to));
    }
    constraints.push(...fks.values());
    for (const i of indexes)
      if (i.unique)
        constraints.push({
          name: i.name,
          type: i.primary ? 'PRIMARY_KEY' : 'UNIQUE',
          columns: i.columns,
          nameIsGenerated: true,
        });
    return { indexes, constraints };
  }
  const indexSql = indexQuery(c, name),
    constraintSql = constraintQuery(c, name);
  if (!indexSql || !constraintSql)
    throw new Error('Index and constraint metadata is unsupported for this driver');
  const [indexResult, constraintResult] = await Promise.all([
    query(indexSql),
    query(constraintSql),
  ]);
  const grouped = new Map<string, IndexInfo>();
  for (const row of records(indexResult)) {
    const name = String(row.index_name);
    let index = grouped.get(name);
    if (!index) {
      index = {
        name,
        columns: [],
        unique: bool(row.is_unique),
        primary: bool(row.is_primary),
        type: String(row.index_type),
        ...(row.definition ? { definition: String(row.definition) } : {}),
        ...(row.predicate ? { predicate: String(row.predicate) } : {}),
        ...(row.is_valid !== undefined ? { valid: bool(row.is_valid) } : {}),
      };
      grouped.set(name, index);
    }
    index.columns.push(row.column_name === null ? '(expression)' : String(row.column_name));
  }
  const groupedConstraints = new Map<string, ConstraintInfo>();
  for (const row of records(constraintResult)) {
    const name = String(row.constraint_name);
    let k = groupedConstraints.get(name);
    if (!k) {
      k = {
        name,
        type: String(row.constraint_type) as ConstraintInfo['type'],
        columns: [],
        ...(row.referenced_table
          ? { referencedTable: String(row.referenced_table), referencedColumns: [] }
          : {}),
        ...(row.definition ? { definition: String(row.definition) } : {}),
      };
      groupedConstraints.set(name, k);
    }
    if (row.column_name) k.columns.push(String(row.column_name));
    if (row.referenced_column) k.referencedColumns?.push(String(row.referenced_column));
  }
  return {
    indexes: [...grouped.values()],
    constraints: [...groupedConstraints.values()],
    partial: indexResult.truncated === true || constraintResult.truncated === true,
  };
}
