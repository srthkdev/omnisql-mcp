# ClickHouse query and compression costs

Measured on 2026-10-18, macOS ARM64, ClickHouse 26.8.30.8 in a local Docker container limited to two CPUs and 2 GiB. Clients use Bun 1.4.3 or Node 24.7.0. These are synthetic local measurements, not production throughput claims.

Thirty warm pairs alternate unrestricted and table-restricted MCP `SUM(total)` calls over 10,001 seeded rows. Both paths use the same account, table, HTTP keep-alive, and default zstd transport. Client initialization, first parser loading, and three warmup pairs are excluded. A table policy requires one additional batched native catalog request.

| Runtime | Unrestricted p50 / p95 | Table policy p50 / p95 |
| --- | ---: | ---: |
| Bun | 4.11 / 5.86 ms | 7.54 / 10.87 ms |
| Node | 3.81 / 6.17 ms | 6.54 / 9.22 ms |

Three native HTTP transfers read the same sorted 10,000-row result containing a repeated 100-character payload. Each response decodes to 1,108,933 bytes with an identical SHA-256 digest. Wire bytes count response bodies, excluding headers. Compression settings use the fixture's server defaults.

| Encoding | Wire bytes | Reduction against identity |
| --- | ---: | ---: |
| Identity | 1,108,933 | — |
| gzip | 28,640 | 97.42% |
| zstd | 12,262 | 98.89% |

Repeated text compresses particularly well. These figures measure transfer size; they do not establish a query latency improvement or a general speedup. The adapter uses native asynchronous codecs for larger SQL bodies and streaming response decompression, with byte limits applied to decoded data. Users can select zstd, gzip, or no compression. Zstd response windows are limited to 8 MiB.

The adapter adds no npm dependency or database binary. The accompanying [package report](2026-10-18-clickhouse-package.json) compares the preceding DuckDB build with this build using the same dependency lock and Rust binary. The separately running ClickHouse service is outside the npm package.

The real SDK fixture checks two databases, multiple instances, strict mode-1 and mode-2 reader accounts, exact decimals and large integers, repeated map keys, native table identity policies, optional catalog permission failures, physical key expressions, skipping indexes, estimated plans, bounded results, compressed exports, and writes. Deadline tests verify that the server stops the original query, including for accounts without access to other users' process metadata. A separate transport fixture checks TLS and mutual TLS, original-host certificate validation, compressed requests and responses, decompression limits, malformed UTF-8, truncated responses, late errors, and redirects without credential forwarding. Both fixtures run under Bun and Node in CI.

```sh
bun run build
OMNISQL_BENCHMARK_REPORT_DIR=docs/benchmarks bun scripts/check-clickhouse.mjs
OMNISQL_BENCHMARK_REPORT_DIR=docs/benchmarks node scripts/check-clickhouse.mjs
bun scripts/check-http-transport.mjs
node scripts/check-http-transport.mjs
```

The database fixture requires Docker and cleans up its own containers. Raw reports: [Bun queries](2026-10-18-clickhouse-bun.json), [Node queries](2026-10-18-clickhouse-node.json), [Bun transfers](2026-10-18-clickhouse-http-bun.json), [Node transfers](2026-10-18-clickhouse-http-node.json).
