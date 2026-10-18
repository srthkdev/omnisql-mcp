import { parseString } from 'xml2js';
import { sqlDialect } from '../policy/analyzer.js';
import type { ExplainResult, QueryPlanNode } from '../types.js';

/**
 * Build EXPLAIN query based on database driver
 */
export function buildExplainQuery(
  driver: string,
  query: string,
  analyze = false,
  format: 'text' | 'json' = 'text'
): string {
  const dialect = sqlDialect(driver);
  const driverLower =
    dialect === 'postgres' ? 'postgresql' : dialect === 'mssql' ? 'mssql' : driver.toLowerCase();

  if (driverLower.includes('postgres')) {
    const options = [];
    if (analyze) options.push('ANALYZE');
    if (format === 'json') options.push('FORMAT JSON');
    const optionStr = options.length > 0 ? `(${options.join(', ')})` : '';
    return `EXPLAIN ${optionStr} ${query}`;
  } else if (driverLower.includes('mariadb')) {
    return `${analyze ? 'ANALYZE' : 'EXPLAIN'}${format === 'json' ? ' FORMAT=JSON' : ''} ${query}`;
  } else if (driverLower.includes('mysql')) {
    if (analyze && format === 'json')
      throw new Error('MySQL EXPLAIN ANALYZE uses text output; choose format text');
    if (format === 'json') {
      return `EXPLAIN FORMAT=JSON ${query}`;
    }
    return analyze ? `EXPLAIN ANALYZE ${query}` : `EXPLAIN ${query}`;
  } else if (driverLower.includes('mssql') || driverLower.includes('sqlserver')) {
    throw new Error('SQL Server plans require the dedicated pinned-session execution path');
  } else if (driverLower.includes('sqlite')) {
    return `EXPLAIN QUERY PLAN ${query}`;
  } else if (driverLower.includes('duckdb')) {
    return `EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT ${format === 'json' ? 'JSON' : 'TEXT'}) ${query}`;
  } else {
    // Generic fallback
    return `EXPLAIN ${query}`;
  }
}

/**
 * Parse EXPLAIN output into structured format
 */
export function parseExplainOutput(
  driver: string,
  output: unknown[][],
  query: string,
  format: 'text' | 'json'
): ExplainResult {
  const dialect = sqlDialect(driver);
  const driverLower =
    dialect === 'postgres' ? 'postgresql' : dialect === 'mssql' ? 'mssql' : driver.toLowerCase();

  if (driverLower.includes('postgres')) {
    return parsePostgresExplain(output, query, format);
  } else if (driverLower.includes('mysql') || driverLower.includes('mariadb')) {
    return parseMysqlExplain(output, query, format);
  } else if (driverLower.includes('mssql') && format === 'json') {
    let document: Record<string, unknown> = {};
    let error: Error | undefined;
    parseString(
      String(output[0]?.[0] ?? ''),
      { explicitArray: false },
      (e: Error | null, result: Record<string, unknown>) => {
        error = e ?? undefined;
        document = result;
      }
    );
    if (error) throw new Error('SQL Server returned an invalid XML execution plan');
    return {
      query,
      format: 'json',
      plan: [{ operation: 'SQL Server estimated plan', details: document }],
    };
  } else if (driverLower.includes('sqlite')) {
    return parseSqliteExplain(output, query);
  } else if (driverLower.includes('duckdb')) {
    if (format === 'json')
      return {
        query,
        format,
        plan: output.map((row) => ({
          operation: String(row[0]),
          details: JSON.parse(String(row[1]).replace(/^[^[{]*/, '')),
        })),
      };
    return {
      query,
      format,
      plan: output.map((row) => ({ operation: String(row[0]), details: { text: String(row[1]) } })),
    };
  } else {
    return parseGenericExplain(output, query);
  }
}

function parsePostgresExplain(
  output: unknown[][],
  query: string,
  format: 'text' | 'json'
): ExplainResult {
  const plan: QueryPlanNode[] = [];

  if (format === 'json' && output.length > 0 && output[0][0]) {
    try {
      const jsonPlan = typeof output[0][0] === 'string' ? JSON.parse(output[0][0]) : output[0][0];

      if (Array.isArray(jsonPlan) && jsonPlan[0]?.Plan) {
        const rootPlan = jsonPlan[0].Plan;
        plan.push(convertPostgresPlanNode(rootPlan));
        return {
          query,
          plan,
          planningTime: jsonPlan[0]['Planning Time'],
          executionTime: jsonPlan[0]['Execution Time'],
          format,
        };
      }
    } catch {
      // Fall through to text parsing
    }
  }

  // Text format parsing
  for (const row of output) {
    if (row[0]) {
      plan.push({
        operation: String(row[0]),
        details: {},
      });
    }
  }

  return { query, plan, format };
}

function convertPostgresPlanNode(node: Record<string, unknown>): QueryPlanNode {
  const result: QueryPlanNode = {
    operation: String(node['Node Type'] || 'Unknown'),
    object: node['Relation Name'] as string | undefined,
    cost: node['Total Cost'] as number | undefined,
    rows: node['Plan Rows'] as number | undefined,
    width: node['Plan Width'] as number | undefined,
    actualTime: node['Actual Total Time'] as number | undefined,
    actualRows: node['Actual Rows'] as number | undefined,
    details: {},
  };

  // Add additional details
  const excludeKeys = [
    'Node Type',
    'Relation Name',
    'Total Cost',
    'Plan Rows',
    'Plan Width',
    'Actual Total Time',
    'Actual Rows',
    'Plans',
  ];
  for (const [key, value] of Object.entries(node)) {
    if (!excludeKeys.includes(key) && value !== undefined) {
      result.details![key] = value;
    }
  }

  // Process child plans
  if (Array.isArray(node['Plans'])) {
    result.children = (node['Plans'] as Record<string, unknown>[]).map(convertPostgresPlanNode);
  }

  return result;
}

function parseMysqlExplain(
  output: unknown[][],
  query: string,
  format: 'text' | 'json'
): ExplainResult {
  const plan: QueryPlanNode[] = [];

  if (format === 'json' && output.length > 0 && output[0][0]) {
    try {
      const jsonPlan = typeof output[0][0] === 'string' ? JSON.parse(output[0][0]) : output[0][0];

      // MySQL JSON explain format
      if (jsonPlan.query_block) {
        plan.push({
          operation: 'Query Block',
          cost: jsonPlan.query_block.cost_info?.query_cost,
          details: jsonPlan.query_block,
        });
      }
      return { query, plan, format };
    } catch {
      // Fall through
    }
  }

  // Text format - each row is a step in the plan
  for (const row of output) {
    plan.push({
      operation: String(row[3] || 'Unknown'), // type column
      object: String(row[2] || ''), // table column
      rows: row[9] ? Number(row[9]) : undefined,
      details: {
        id: row[0],
        selectType: row[1],
        possibleKeys: row[5],
        key: row[6],
        keyLen: row[7],
        ref: row[8],
        filtered: row[10],
        extra: row[11],
      },
    });
  }

  return { query, plan, format: 'text' };
}

function parseSqliteExplain(output: unknown[][], query: string): ExplainResult {
  const plan: QueryPlanNode[] = [];

  for (const row of output) {
    plan.push({
      operation: String(row[3] || row[0] || 'Unknown'),
      details: {
        id: row[0],
        parent: row[1],
        notused: row[2],
        detail: row[3],
      },
    });
  }

  return { query, plan, format: 'text' };
}

function parseGenericExplain(output: unknown[][], query: string): ExplainResult {
  const plan: QueryPlanNode[] = output.map((row) => ({
    operation: row.map(String).join(' | '),
    details: {},
  }));

  return { query, plan, format: 'text' };
}
