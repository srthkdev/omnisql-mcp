# Language comparison spike

Four minimal MCP servers exercise the same fixed workloads using the official TypeScript, Rust and Go MCP SDKs. The same JavaScript runs under Node and Bun. This experiment informs a language decision; it is not an alternate production OmniSQL server.

The servers have one `bench` tool and a lazy persistent PostgreSQL connection. Modes cover a trivial response, grouped SQL aggregation, incremental SHA-256 over PostgreSQL COPY output, line-by-line generic JSON processing, and native PostgreSQL timeout/recovery. Unknown modes are rejected. No tool accepts SQL, connection strings or file paths. The harness creates 100,000 synthetic rows and a read-only account, checks that writes fail, verifies independent expected aggregates and identical CSV bytes/checksums, and removes its own container and temporary files.

## Build and verify

Requires Docker, Node, Bun, Rust/Cargo, and Go. Measurements were made with Node 24.7.0, Bun 1.4.3, Rust 1.99.0 and Go 1.27.2 on macOS ARM64. Go's compiler was downloaded to a private temporary directory from go.dev and verified against its published SHA-256; no global toolchain was changed.

Run from the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd experiments/language-spike/js --frozen-lockfile --ignore-scripts
cargo build --release --locked --manifest-path experiments/language-spike/rust/Cargo.toml
mkdir -p experiments/language-spike/bin
cd experiments/language-spike/go
go build -trimpath -ldflags='-s -w' -o ../bin/go-server .
cd ../../..
node experiments/language-spike/run.mjs --verify
```

`OMNISQL_BENCH_BUN` can select an absolute Bun executable. The `--verify` path checks correctness without publishing timing/RSS observations and works without `/usr/bin/time`.

## Measure

Run these sequentially, without builds, installs or compression jobs in parallel:

```sh
bun run build
node experiments/language-spike/measure-size.mjs
node experiments/language-spike/run.mjs
```

Results default to ignored `experiments/language-spike/results/`. Set `OMNISQL_BENCH_REPORT_DIR` for the timing report or pass an output filename to `measure-size.mjs`. Timing memory measurements use macOS `/usr/bin/time -l` or Linux GNU time `-v`. The size report creates and deletes a fresh production dependency installation; it does not modify the checkout's dependencies.

Timing runs rotate candidate order. Startup uses 16 fresh processes per candidate and includes MCP initialization and tool listing, with a warm filesystem and no database connection. Warm calls use one active request globally, one connection per candidate and fixed workloads. RPC echo has 200 measured calls, aggregation 30, COPY and JSON processing 15 each; warmups are separate. One timeout call is a correctness check, not a latency distribution. On 16 startup samples, nearest-rank p95 is the slowest sample.

The JSONL file contains safe-range integer IDs/regions, decimal-string integer cents, Unicode text and nested payloads. Every implementation parses generic JSON values. Only the tiny aggregate crosses MCP; the large input stays local. COPY hashes bytes as they stream without retaining the dataset.

## Limits

- Compare these runtime/SDK/driver configurations, not abstract language performance. Rust uses a single-thread Tokio runtime and the SDK's server/stdio features; Go uses its SDK defaults. Native release binaries are stripped.
- PostgreSQL runs locally in Docker with two CPUs and 768 MiB; the fixture uses no TLS. Database CPU and loopback/container networking can dominate the query timings.
- The Rust/Go binaries omit production SQL policy analysis, multi-engine drivers, TLS/auth integration, metadata, transactions, result handles, installation and memory/pipeline features. Their sizes are not estimates of the completed application.
- Runtime bytes count the executable only, excluding dynamically linked system libraries. A preinstalled runtime may have no incremental download cost for the user. Full production dependency size and minimal matched-prototype dependency size are separate figures.
- PostgreSQL `statement_timeout` proves native timeout recovery here; it does not test application-request cancellation, network failure cleanup or other engines.
- A first validation run overlapped size/compression work and was excluded. The published timing run is performed after those jobs finish. Benchmark results must not be used as a universal speedup claim.

Sources: [official Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk), [official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk), [node-pg-copy-streams](https://github.com/brianc/node-pg-copy-streams), [tokio-postgres](https://docs.rs/tokio-postgres/latest/tokio_postgres/).
