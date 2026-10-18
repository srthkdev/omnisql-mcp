import { performance } from 'node:perf_hooks';
import { ConnectionPoolManager } from '../dist/pools/connection-pool.js';

/** Called by the integration fixture so only task-owned databases are benchmarked. */
export async function benchmarkSessionReuse(engine, config, connect) {
  const manager = new ConnectionPoolManager({ min: 0, max: 1 });
  const connection = {
    id: 'benchmark',
    name: 'synthetic benchmark',
    url: '',
    driver: engine,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    properties: {
      password: config.password,
      sslmode: 'disable',
      encrypt: 'true',
      trustServerCertificate: 'true',
    },
  };
  const statement = engine === 'oracle' ? 'SELECT 1 FROM dual' : 'SELECT 1';
  const entry = await manager.getPool(connection);
  async function standalone() {
    const client = await connect(engine, config);
    try {
      await client.query(statement);
    } finally {
      await client.close();
    }
  }
  async function pooled() {
    if (entry.type === 'postgres') {
      const client = await entry.pool.connect();
      try {
        await client.query(statement);
      } finally {
        client.release();
      }
    } else if (entry.type === 'oracle') {
      const client = await entry.pool.getConnection();
      try {
        await client.execute(statement);
      } finally {
        await client.close();
      }
    } else if (entry.type === 'mysql') {
      const client = await entry.pool.getConnection();
      try {
        await client.query(statement);
      } finally {
        client.release();
      }
    } else await entry.pool.request().query(statement);
  }
  const measure = async (operation) => {
    const start = performance.now();
    await operation();
    return performance.now() - start;
  };
  try {
    const firstPoolQueryMs = await measure(pooled);
    for (let i = 0; i < 5; i++) {
      await standalone();
      await pooled();
    }
    const baseline = [],
      updated = [];
    for (let i = 0; i < 40; i++) {
      if (i % 2) {
        updated.push(await measure(pooled));
        baseline.push(await measure(standalone));
      } else {
        baseline.push(await measure(standalone));
        updated.push(await measure(pooled));
      }
    }
    const percentile = (samples, p) =>
      [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
    return {
      engine,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 40,
      warmupPairs: 5,
      firstPoolQueryMs,
      standalone: {
        p50Ms: percentile(baseline, 0.5),
        p95Ms: percentile(baseline, 0.95),
        samplesMs: baseline,
      },
      pooled: {
        p50Ms: percentile(updated, 0.5),
        p95Ms: percentile(updated, 0.95),
        samplesMs: updated,
      },
      scope:
        'Session acquisition, SELECT 1, and release against a local Docker fixture. Excludes MCP, parsing, policy, metadata, and application queries.',
    };
  } finally {
    await manager.closeAllPools();
  }
}
