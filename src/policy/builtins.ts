import { sqlDialect, type SqlNamePart } from './analyzer.js';

// These are candidates, not proof of a trusted catalog identity on engines with overloads.
const COMMON =
  'count sum avg min max coalesce nullif abs round floor lower upper trim ltrim rtrim replace';
const FUNCTIONS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    postgres:
      'ceil ceiling length char_length character_length concat concat_ws substring substr left right position cast extract date_trunc date_part now current_date current_timestamp version current_database current_schema pg_typeof row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddev stddev_pop stddev_samp variance var_pop var_samp greatest least to_char to_date to_timestamp json_build_object json_agg array_agg string_agg',
    mysql:
      'ceil ceiling length char_length character_length concat concat_ws substring substr left right position cast convert extract now current_date current_timestamp version row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddev stddev_pop stddev_samp variance var_pop var_samp greatest least if ifnull isnull date format json_extract json_type json_valid group_concat',
    mssql:
      'ceiling concat concat_ws substring left right cast convert try_cast try_convert current_timestamp row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist iif isnull dateadd datediff datename datepart format db_name schema_name object_name serverproperty string_agg len datalength charindex stuff patindex replicate reverse space choose count_big quotename isnumeric isdate eomonth datediff_big str sign power sqrt exp log getdate sysdatetime getutcdate sysutcdatetime hashbytes newid checksum suser_sname system_user day month year datefromparts parsename',
    oracle:
      'ceil length concat substr cast extract current_date current_timestamp row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddev stddev_pop stddev_samp variance var_pop var_samp greatest least nvl nvl2 to_char to_date to_timestamp',
    sqlite:
      'ceil ceiling length char_length concat concat_ws substring substr cast current_date current_timestamp strftime date datetime julianday unixepoch typeof row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist iif if ifnull json_extract json_array_length json_type json_valid group_concat string_agg sqlite_version',
    duckdb:
      'ceil ceiling length char_length character_length concat concat_ws substring substr left right position cast try_cast extract date_trunc date_part now current_date current_timestamp version current_database current_schema typeof row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddev stddev_pop stddev_samp variance var_pop var_samp greatest least if ifnull date strftime json_extract json_array_length json_type json_valid array_agg string_agg group_concat datediff datepart format pg_typeof to_timestamp',
    clickhouse:
      'ceil ceiling length concat substring substr left right position cast extract now row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddevpop stddevsamp varpop varsamp greatest least if ifnull version',
  }).map(([dialect, names]) => [dialect, new Set((COMMON + ' ' + names).split(' '))])
);

export function isBuiltinFunction(parts: SqlNamePart[], driver: string): boolean {
  return (
    parts.length === 1 &&
    !parts[0].quoted &&
    (FUNCTIONS[sqlDialect(driver)]?.has(parts[0].value.toLowerCase()) ?? false)
  );
}
