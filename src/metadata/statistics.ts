import { sanitizeDiagnostic } from '../privacy.js';
import { mysqlNameEquals, duckdbNameEquals } from './names.js';
import type { DatabaseConnection } from '../types.js';
import { type CatalogQuery, records, tableParts } from './catalog.js';
export interface TableStatistics {
  tableName: string;
  rowEstimate: string | null;
  dataBytes: string | null;
  indexBytes: string | null;
  totalBytes: string | null;
  estimated: true;
  notes: string[];
}
/** Catalog estimates avoid scanning application tables or running COUNT(*). */
export async function tableStatistics(
  c: DatabaseConnection,
  name: string,
  query: CatalogQuery
): Promise<TableStatistics> {
  const { dialect, table, schema } = tableParts(c, name);
  let sql: string;
  if (dialect === 'postgres')
    sql = `SELECT CASE WHEN t.reltuples>=0 THEN t.reltuples::bigint ELSE NULL END AS row_estimate,pg_table_size(t.oid)::text AS data_bytes,pg_indexes_size(t.oid)::text AS index_bytes,pg_total_relation_size(t.oid)::text AS total_bytes FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${schema} AND t.relname=${table} AND t.relkind IN ('r','m','p')`;
  else if (dialect === 'clickhouse')
    sql = `SELECT total_rows AS row_estimate,NULL AS data_bytes,NULL AS index_bytes,total_bytes FROM system.tables WHERE database=currentDatabase() AND database=${schema} AND name=${table}`;
  else if (dialect === 'duckdb')
    sql = `SELECT estimated_size::VARCHAR AS row_estimate,NULL AS data_bytes,NULL AS index_bytes,NULL AS total_bytes FROM duckdb_tables() WHERE database_name=current_database() AND ${duckdbNameEquals('schema_name', schema)} AND ${duckdbNameEquals('table_name', table)}`;
  else if (dialect === 'mysql')
    sql = `SELECT TABLE_ROWS AS row_estimate,DATA_LENGTH AS data_bytes,INDEX_LENGTH AS index_bytes,DATA_LENGTH+INDEX_LENGTH AS total_bytes FROM information_schema.TABLES WHERE ${mysqlNameEquals('TABLE_SCHEMA', schema)} AND ${mysqlNameEquals('TABLE_NAME', table)}`;
  else if (dialect === 'mssql')
    sql = `SELECT SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END) AS row_estimate,SUM(CASE WHEN p.index_id IN (0,1) THEN p.used_page_count ELSE 0 END)*8192 AS data_bytes,SUM(CASE WHEN p.index_id>1 THEN p.used_page_count ELSE 0 END)*8192 AS index_bytes,SUM(p.used_page_count)*8192 AS total_bytes FROM sys.dm_db_partition_stats p JOIN sys.tables t ON t.object_id=p.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=${schema} AND t.name=${table}`;
  else if (dialect === 'oracle')
    sql = `SELECT t.num_rows AS row_estimate,(SELECT SUM(bytes) FROM user_segments WHERE segment_name=t.table_name AND segment_type LIKE 'TABLE%') AS data_bytes,(SELECT SUM(s.bytes) FROM user_segments s JOIN user_indexes i ON i.index_name=s.segment_name WHERE i.table_name=t.table_name) AS index_bytes,CAST(NULL AS NUMBER) AS total_bytes FROM all_tables t WHERE t.owner=${schema} AND t.table_name=${table} AND t.owner=SYS_CONTEXT('USERENV','SESSION_USER')`;
  else if (dialect === 'sqlite')
    sql = `SELECT NULL AS row_estimate,SUM(CASE WHEN name=${table} THEN pgsize ELSE 0 END) AS data_bytes,SUM(CASE WHEN name<>${table} THEN pgsize ELSE 0 END) AS index_bytes,SUM(pgsize) AS total_bytes FROM dbstat WHERE name=${table} OR name IN (SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=${table})`;
  else throw new Error('Table statistics are unsupported for this driver');
  const notes: string[] = [];
  let row: Record<string, unknown> | undefined;
  try {
    row = records(await query(sql))[0];
  } catch (error) {
    notes.push(`Catalog statistics unavailable: ${sanitizeDiagnostic(error)}`);
  }
  const scalar = (key: string): string | null =>
    row?.[key] === null || row?.[key] === undefined ? null : String(row[key]);
  const dataBytes = scalar('data_bytes'),
    indexBytes = scalar('index_bytes');
  let totalBytes = scalar('total_bytes');
  if (totalBytes === null && dataBytes !== null)
    totalBytes = (BigInt(dataBytes) + BigInt(indexBytes ?? '0')).toString();
  if (!row)
    notes.push(
      'No statistics visible for this table; the table may be empty, partitioned, or outside catalog permissions.'
    );
  if (dialect === 'duckdb')
    notes.push(
      'DuckDB reports row estimates; per-table physical byte sizes are unavailable without attributing shared database blocks.'
    );
  if (dialect === 'oracle')
    notes.push(
      'Storage covers the current Oracle user; LOB segments and global partition totals may require additional catalog privileges.'
    );
  if (dialect === 'postgres')
    notes.push('Row counts depend on ANALYZE. Partitioned parents exclude child-relation storage.');
  return {
    tableName: name,
    rowEstimate: scalar('row_estimate'),
    dataBytes,
    indexBytes,
    totalBytes,
    estimated: true,
    notes,
  };
}

export async function visibleStorage(
  c: DatabaseConnection,
  names: Set<string>,
  query: CatalogQuery
) {
  const { dialect } = tableParts(c, 'placeholder');
  let sql: string;
  if (dialect === 'postgres')
    sql = `SELECT n.nspname AS table_schema,t.relname AS table_name,pg_total_relation_size(t.oid)::text AS total_bytes FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.relkind IN ('r','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`;
  else if (dialect === 'clickhouse')
    sql =
      'SELECT database AS table_schema,name AS table_name,total_bytes FROM system.tables WHERE database=currentDatabase()';
  else if (dialect === 'duckdb')
    return {
      totalSizeBytes: null,
      sizeComplete: false,
      notes: [
        'DuckDB database blocks are shared; per-table physical byte attribution is unavailable.',
      ],
    };
  else if (dialect === 'mysql')
    sql = `SELECT TABLE_SCHEMA AS table_schema,TABLE_NAME AS table_name,DATA_LENGTH+INDEX_LENGTH AS total_bytes FROM information_schema.TABLES WHERE ${mysqlNameEquals('TABLE_SCHEMA', 'DATABASE()')}`;
  else if (dialect === 'mssql')
    sql =
      'SELECT s.name AS table_schema,t.name AS table_name,SUM(p.used_page_count)*8192 AS total_bytes FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.dm_db_partition_stats p ON p.object_id=t.object_id GROUP BY s.name,t.name';
  else if (dialect === 'oracle')
    sql =
      "SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS table_schema,t.table_name,(SELECT SUM(bytes) FROM user_segments s WHERE s.segment_name=t.table_name OR s.segment_name IN (SELECT i.index_name FROM user_indexes i WHERE i.table_name=t.table_name)) AS total_bytes FROM user_tables t";
  else if (dialect === 'sqlite')
    sql =
      "SELECT 'main' AS table_schema,m.tbl_name AS table_name,SUM(d.pgsize) AS total_bytes FROM dbstat d JOIN sqlite_master m ON m.name=d.name WHERE m.type IN ('table','index') GROUP BY m.tbl_name";
  else throw new Error('Storage metadata is unsupported for this driver');
  const notes: string[] = [];
  let bytes = 0n;
  const known = new Set<string>();
  try {
    const result = await query(sql);
    if (result.truncated)
      notes.push('Catalog output reached its budget; storage totals are partial.');
    for (const row of records(result)) {
      const name = [row.table_schema, row.table_name].filter(Boolean).join('.');
      if (names.has(name) && row.total_bytes !== null && row.total_bytes !== undefined) {
        known.add(name);
        bytes += BigInt(String(row.total_bytes));
      }
    }
  } catch (error) {
    notes.push(`Storage catalog unavailable: ${sanitizeDiagnostic(error)}`);
  }
  if (dialect === 'oracle')
    notes.push('Oracle storage covers the connected user; LOB segments may be separate.');
  if (dialect === 'postgres')
    notes.push(
      'Partitioned parent sizes exclude child relations; child tables are included separately when visible.'
    );
  return {
    totalSizeBytes: known.size ? bytes.toString() : null,
    sizeComplete: known.size === names.size,
    notes,
  };
}
