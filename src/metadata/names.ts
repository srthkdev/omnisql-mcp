/** INFORMATION_SCHEMA string collations do not necessarily match MySQL table names. */
export function mysqlNameEquals(column: string, value: string): string {
  return `(CASE WHEN @@lower_case_table_names=0 THEN BINARY ${column}=BINARY ${value} ELSE BINARY LOWER(${column})=BINARY LOWER(${value}) END)`;
}
