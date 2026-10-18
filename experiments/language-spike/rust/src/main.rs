use futures_util::StreamExt;
use rmcp::{
    ErrorData, ServerHandler, ServiceExt, handler::server::wrapper::Parameters, model::*, tool,
    tool_handler, tool_router,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    sync::Arc,
};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls};

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Echo,
    Aggregate,
    Copy,
    Json,
    Cancel,
}
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: Mode,
}
#[derive(Clone)]
struct Bench {
    database: Arc<Mutex<Option<Client>>>,
}
impl Bench {
    fn new() -> Self {
        Self {
            database: Arc::new(Mutex::new(None)),
        }
    }
    async fn execute(&self, mode: Mode) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        if matches!(mode, Mode::Echo) {
            return Ok(json!({"value":"omnisql"}));
        }
        if matches!(mode, Mode::Json) {
            let file = File::open(std::env::var("OMNISQL_BENCH_FILE")?)?;
            let mut counts = [0u64; 10];
            let mut sums = [0i64; 10];
            for line in BufReader::new(file).lines() {
                let row: Value = serde_json::from_str(&line?)?;
                let region = row["region"].as_u64().ok_or("region")? as usize;
                counts[region] += 1;
                sums[region] += row["cents"].as_str().ok_or("cents")?.parse::<i64>()?;
            }
            return Ok(json!({"counts":counts,"sums":sums}));
        }
        let mut database = self.database.lock().await;
        if database.is_none() {
            let mut config = tokio_postgres::Config::new();
            config
                .host(&std::env::var("PGHOST")?)
                .port(std::env::var("PGPORT")?.parse()?)
                .user(&std::env::var("PGUSER")?)
                .password(std::env::var("PGPASSWORD")?)
                .dbname(&std::env::var("PGDATABASE")?);
            let (client, connection) = config.connect(NoTls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            *database = Some(client);
        }
        let client = database.as_ref().unwrap();
        match mode {
            Mode::Aggregate => {
                let rows = client.query("SELECT region,count(*)::text AS count,sum(cents)::text AS total FROM bench GROUP BY region ORDER BY region", &[]).await?;
                let output: Vec<Value> = rows
                    .iter()
                    .map(|r| {
                        json!([
                            r.get::<_, i32>(0),
                            r.get::<_, String>(1),
                            r.get::<_, String>(2)
                        ])
                    })
                    .collect();
                Ok(json!({"rows":output}))
            }
            Mode::Copy => {
                let stream = client.copy_out("COPY (SELECT id,region,cents,payload FROM bench ORDER BY id) TO STDOUT (FORMAT csv)").await?;
                tokio::pin!(stream);
                let mut hash = Sha256::new();
                let mut bytes = 0usize;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk?;
                    bytes += chunk.len();
                    hash.update(&chunk);
                }
                let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
                Ok(json!({"bytes":bytes,"sha256":digest}))
            }
            Mode::Cancel => {
                client
                    .batch_execute("SET statement_timeout='150ms'")
                    .await?;
                let result = client.query("SELECT pg_sleep(5)", &[]).await;
                client.batch_execute("SET statement_timeout='5s'").await?;
                let cancelled =
                    matches!(result, Err(ref e) if e.code().is_some_and(|c| c.code()=="57014"));
                let recovered = client
                    .query_one("SELECT 1 AS value", &[])
                    .await?
                    .get::<_, i32>(0)
                    == 1;
                Ok(json!({"cancelled":cancelled,"recovered":recovered}))
            }
            _ => unreachable!(),
        }
    }
}
#[tool_router]
impl Bench {
    #[tool(description = "Run a fixed benchmark workload")]
    async fn bench(
        &self,
        Parameters(input): Parameters<Input>,
    ) -> Result<CallToolResult, ErrorData> {
        let value = self
            .execute(input.mode)
            .await
            .map_err(|_| ErrorData::internal_error("Benchmark failed", None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(
            value.to_string(),
        )]))
    }
}
#[tool_handler]
impl ServerHandler for Bench {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    Bench::new()
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
