# Rust, Go, Bun and Node: database MCP language experiment

Measured 18 October 2026 on macOS ARM64. The [raw timing report](2026-10-18-language-spike.json) records the CPU/OS, exact toolchains, dependency versions, source revision/hashes and every timing sample. The [size report](2026-10-18-language-size.json) records a fresh production install and the matched prototypes. Sources and reproduction commands are in [the experiment](../../experiments/language-spike/README.md).

## Decision

Use Rust as the leading candidate for OmniSQL's native server core, with a staged migration gated by production feature/security parity. This experiment removes the concern that a Rust server must inherently be larger than our JavaScript installation. It does not establish the size or correctness of a complete multi-engine replacement.

Rust had the smallest standalone prototype, lowest measured peak RSS and fastest process startup. Bun processed JSON faster in this workload. PostgreSQL aggregation and streaming transfer times were close across candidates; the database and network remain major costs. Go worked correctly but offered no compelling advantage over Rust for this experiment's size/memory/startup goals.

Keep shipping the existing Bun/Node implementation while proving the Rust core and adapters. Do not replace a working engine with a smaller implementation that loses TLS, authentication, exact values, deadlines, cancellation or policy enforcement. The next migration gate is a production-quality PostgreSQL path plus a driver-feasibility check for Oracle and SQL Server, followed by the existing all-engine contract tests.

## Matched workload

Each prototype uses its official MCP SDK, one `bench` tool and one lazy persistent PostgreSQL connection. The TypeScript SDK implementation runs unchanged on Node and Bun. Rust uses a single-thread Tokio runtime with server/stdio SDK features; Go uses its SDK defaults. Native binaries use optimized stripped builds. These are runtime/SDK/driver configuration comparisons, not language-intrinsic speed rankings.

PostgreSQL 17 runs in an owned Docker container limited to two CPUs and 768 MiB, with a synthetic 100,000-row table and a separately granted read-only account. The harness checks that writes fail. It independently calculates the expected group counts/totals and compares them with native SQL and all four MCP implementations.

| Operation | Method |
| --- | --- |
| Startup | 16 fresh processes each; MCP initialization + tool listing, warm filesystem, no DB connection |
| Echo | 200 warm MCP calls after 30 warmups |
| Aggregate | Same grouped count/sum over 100,000 rows; 30 calls after three warmups |
| Stream | PostgreSQL COPY CSV, 13,277,785 bytes; incremental SHA-256 without retaining rows; 15 calls after two warmups |
| JSON analytics | Same 21,327,785-byte JSONL file; parse 100,000 generic objects with Unicode/nested fields and aggregate ten groups; 15 calls after two warmups |
| Deadline recovery | Native 150 ms statement timeout on `pg_sleep(5)`, verify timeout code and subsequent query recovery |

Candidate order rotates between rounds. Only one request runs globally at a time. Full dataset contents do not cross the MCP interface. The COPY SHA-256 digest is identical for every measured call. The account's timed-out queries are absent from active server queries after the checks.

## Results

Milliseconds below are medians; memory uses decimal MB. RSS is one process peak over all warm workloads, not an idle-memory measurement or a distribution. Raw reports retain p95 and samples; with only 16 startup observations, nearest-rank p95 is the slowest sample.

| Candidate | Startup | SQL aggregate | 13.28 MB stream + hash | 21.33 MB JSON analytics | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 24.7.0 | 74.86 ms | 9.14 ms | 52.79 ms | 83.99 ms | 172.79 MB |
| Bun 1.4.3 | 42.09 ms | 9.20 ms | 54.80 ms | 44.51 ms | 149.45 MB |
| Rust 1.99.0 | 2.96 ms | 8.73 ms | 52.63 ms | 52.38 ms | 7.42 MB |
| Go 1.27.2 | 4.28 ms | 8.45 ms | 55.93 ms | 153.39 ms | 21.53 MB |

The differences between roughly 8–9 ms aggregate calls and 53–56 ms stream calls do not establish a practically important database execution speedup. Rust's startup and memory advantages are much larger in this prototype. Bun is about 15% lower-latency than Rust on this generic line-by-line JSON processing task. Rust's generic serde JSON path was not replaced with a typed struct or SIMD parser to manufacture a preferred result.

Timeout recovery passed in all four candidates, around the requested native deadline plus overhead. One sample per candidate is a correctness observation, not a cancellation benchmark. This does not test client-request cancellation or a broken network.

An initial validation run overlapped executable compression/size measurement and is excluded. Published timings were collected after installation, builds and size/compression jobs completed. First-ever OS binary verification and cold-disk startup are not measured.

## Size: include the dependencies and runtime

| Matched PostgreSQL prototype | Installed application bytes | Runtime executable bytes | Combined lower bound |
| --- | ---: | ---: | ---: |
| Node | 17.84 MB dependencies + small script | 86.10 MB | About 103.94 MB |
| Bun | 17.84 MB dependencies + small script | 70.47 MB | About 88.31 MB |
| Rust | 2.56 MB executable | Included | 2.56 MB |
| Go | 11.49 MB executable | Included | 11.49 MB |

The native executables include their MCP SDK, PostgreSQL driver, JSON and hashing code. Their gzip-9 file sizes are 1.11 MB for Rust and 3.96 MB for Go. Compression of one executable is not a complete release archive. All rows exclude dynamically linked system libraries; a preinstalled runtime may have no incremental download cost. SDK feature selection and build flags matter to these figures.

The actual multi-engine OmniSQL installation is measured separately: 0.735 MB npm tarball, 2.824 MB unpacked application and **81.994 MB of production dependency files**. Dependencies come from a fresh frozen Bun production installation with lifecycle scripts disabled, counting regular-file lengths and deduplicating hardlinks. Application plus dependencies is about 84.82 MB before the runtime, approximately 155.29 MB including the measured Bun executable or 170.92 MB with Node. These are apparent file sizes, not filesystem allocation or container-image sizes.

It would be misleading to call the prototype's 2.56 MB the final replacement for that application. The prototypes omit production policy analysis, other database engines, advanced authentication/TLS, metadata, transactions, result artifacts and the planned analysis/memory/pipeline features. The completed Rust package needs a new measurement as those capabilities land. Optional heavyweight analysis components and adapters remain useful even with a Rust core.

## Driver feasibility and rollout

The PostgreSQL prototype proves that a small real Rust MCP/database path is practical. It does not prove all-engine driver parity. In particular, Oracle now publishes a [pure Rust Thin driver](https://github.com/oracle/rust-oracledb) requiring no Oracle Client libraries; its documented dependency is currently `26.0.0-beta.4`. This is a candidate to test, not an already validated OmniSQL dependency. Oracle's LOB/JSON fidelity, pooling, authentication, TLS and timeout behavior must pass the existing fixtures before migration.

Proceed in this order:

1. Establish private public-DTO/error contracts and shared adapter acceptance tests.
2. Build the Rust core with PostgreSQL, bounded output, native cancellation, configuration and MCP compatibility.
3. Verify Oracle/SQL Server driver feasibility early; migrate existing engines one at a time with cross-platform tests.
4. Keep Bun/Node distribution working during migration; remove each superseded implementation after parity passes.
5. Add richer analytical context, scoped memory, resumable jobs and additional databases behind those same contracts.
6. Publish complete package/RSS/startup and task-level performance reports at each milestone. Do not extrapolate this single-engine spike to every workload.

Production language selection remains conditional on preserving security and support. The current evidence supports investing in Rust; it does not justify a blind full rewrite or a claim of universally faster SQL.
