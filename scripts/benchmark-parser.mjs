import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const queries = [
  'SELECT 1',
  'SELECT id,name FROM public.customers WHERE id=42',
  "SELECT c.name,SUM(o.total) AS revenue FROM public.customers c JOIN public.orders o ON c.id=o.customer_id WHERE o.status='paid' GROUP BY c.name ORDER BY revenue DESC LIMIT 50",
  'WITH report AS (SELECT customer_id,SUM(total) AS total FROM public.orders GROUP BY customer_id) SELECT * FROM report WHERE total>100',
  'SELECT * FROM public.orders WHERE customer_id IN (SELECT id FROM public.customers WHERE active=true)',
  'SELECT id FROM public.orders UNION ALL SELECT id FROM public.archived_orders',
];
const kind = process.argv[2] ?? 'rust';
const start = performance.now();
let parse;
if (kind === 'javascript') {
  const { Parser } = require(process.argv[3] ?? 'node-sql-parser');
  const p = new Parser();
  parse = (q) => p.astify(q, { database: 'Postgresql' });
} else {
  const m = require(
    process.argv[3] ? resolve(process.argv[3]) : '../src/native/omnisql_sql_policy.js'
  );
  parse = (q) => JSON.parse(m.analyze_sql(q, 'postgres'));
}
for (const q of queries) parse(q);
const cold = performance.now() - start;
for (let i = 0; i < 300; i++) parse(queries[i % queries.length]);
const samples = [];
for (let i = 0; i < 1000; i++) {
  const s = performance.now();
  for (const q of queries) parse(q);
  samples.push((performance.now() - s) / queries.length);
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    kind,
    node: process.version,
    queries,
    iterations: 6000,
    moduleLoadAndFirstSixMs: cold,
    perQueryMsP50: samples[499],
    perQueryMsP95: samples[949],
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  })
);
