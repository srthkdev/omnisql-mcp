/** INFORMATION_SCHEMA string collations do not necessarily match MySQL table names. */
export function mysqlNameEquals(column: string, value: string): string {
  return `(CASE WHEN @@lower_case_table_names=0 THEN BINARY ${column}=BINARY ${value} ELSE BINARY LOWER(${column})=BINARY LOWER(${value}) END)`;
}
/** DuckDB identifiers fold ASCII letters even when quoted; Unicode remains distinct. */
export function duckdbFold(expression: string): string {
  return `translate(${expression},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`;
}
export function duckdbNameEquals(column: string, value: string): string {
  return `${duckdbFold(column)}=${duckdbFold(value)}`;
}
