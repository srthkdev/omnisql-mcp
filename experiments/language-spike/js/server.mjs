import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { to as copyTo } from 'pg-copy-streams';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Disposable benchmark only: fixed SQL, one lazy connection, no production policy claims.
let database;
async function connection() {
  if (!database) {
    const next = new pg.Client({ connectionTimeoutMillis: 5000 });
    await next.connect();
    database = next;
  }
  return database;
}
async function execute(mode) {
  if (mode === 'echo') return { value: 'omnisql' };
  if (mode === 'json') {
    const counts = Array(10).fill(0),
      sums = Array(10).fill(0);
    const lines = createInterface({
      input: createReadStream(process.env.OMNISQL_BENCH_FILE),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const row = JSON.parse(line);
      counts[row.region]++;
      sums[row.region] += Number(row.cents);
    }
    return { counts, sums };
  }
  const client = await connection();
  if (mode === 'aggregate') {
    const result = await client.query(
      'SELECT region,count(*)::text AS count,sum(cents)::text AS total FROM bench GROUP BY region ORDER BY region'
    );
    return { rows: result.rows.map((r) => [r.region, r.count, r.total]) };
  }
  if (mode === 'copy') {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of client.query(
      copyTo('COPY (SELECT id,region,cents,payload FROM bench ORDER BY id) TO STDOUT (FORMAT csv)')
    )) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
  }
  if (mode === 'cancel') {
    await client.query("SET statement_timeout='150ms'");
    let cancelled = false;
    try {
      await client.query('SELECT pg_sleep(5)');
    } catch (error) {
      if (error.code !== '57014') throw error;
      cancelled = true;
    } finally {
      await client.query("SET statement_timeout='5s'");
    }
    const result = await client.query('SELECT 1 AS value');
    return { cancelled, recovered: result.rows[0].value === 1 };
  }
  throw new Error('Unknown benchmark mode');
}
const modes = ['echo', 'aggregate', 'copy', 'json', 'cancel'];
const server = new Server(
  { name: 'omnisql-language-spike', version: '1' },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bench',
      description: 'Run a fixed benchmark workload',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: modes } },
        required: ['mode'],
        additionalProperties: false,
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== 'bench' || !modes.includes(params.arguments?.mode))
    throw new Error('Invalid benchmark request');
  return {
    content: [{ type: 'text', text: JSON.stringify(await execute(params.arguments.mode)) }],
  };
});
process.stdin.on('end', () => {
  void database?.end();
});
await server.connect(new StdioServerTransport());
