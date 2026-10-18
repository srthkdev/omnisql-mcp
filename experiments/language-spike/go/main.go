package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"strconv"
	"sync"
)

type Input struct {
	Mode string `json:"mode"`
}
type Bench struct {
	mu       sync.Mutex
	database *pgx.Conn
}
type copyHash struct {
	bytes  int64
	digest interface {
		Write([]byte) (int, error)
		Sum([]byte) []byte
	}
}

func (w *copyHash) Write(p []byte) (int, error) { w.bytes += int64(len(p)); return w.digest.Write(p) }
func (b *Bench) execute(ctx context.Context, mode string) (any, error) {
	if mode == "echo" {
		return map[string]any{"value": "omnisql"}, nil
	}
	if mode == "json" {
		file, err := os.Open(os.Getenv("OMNISQL_BENCH_FILE"))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		counts := make([]int64, 10)
		sums := make([]int64, 10)
		lines := bufio.NewScanner(file)
		lines.Buffer(make([]byte, 65536), 2*1024*1024)
		for lines.Scan() {
			var row map[string]any
			if err := json.Unmarshal(lines.Bytes(), &row); err != nil {
				return nil, err
			}
			region := int(row["region"].(float64))
			cents := row["cents"].(string)
			amount, err := strconv.ParseInt(cents, 10, 64)
			if err != nil {
				return nil, err
			}
			counts[region]++
			sums[region] += amount
		}
		return map[string]any{"counts": counts, "sums": sums}, lines.Err()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.database == nil {
		var err error
		b.database, err = pgx.Connect(ctx, "")
		if err != nil {
			return nil, err
		}
	}
	switch mode {
	case "aggregate":
		rows, err := b.database.Query(ctx, "SELECT region,count(*)::text AS count,sum(cents)::text AS total FROM bench GROUP BY region ORDER BY region")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		result := make([][]any, 0, 10)
		for rows.Next() {
			var region int32
			var count, total string
			if err := rows.Scan(&region, &count, &total); err != nil {
				return nil, err
			}
			result = append(result, []any{region, count, total})
		}
		return map[string]any{"rows": result}, rows.Err()
	case "copy":
		writer := &copyHash{digest: sha256.New()}
		_, err := b.database.PgConn().CopyTo(ctx, writer, "COPY (SELECT id,region,cents,payload FROM bench ORDER BY id) TO STDOUT (FORMAT csv)")
		return map[string]any{"bytes": writer.bytes, "sha256": hex.EncodeToString(writer.digest.Sum(nil))}, err
	case "cancel":
		if _, err := b.database.Exec(ctx, "SET statement_timeout='150ms'"); err != nil {
			return nil, err
		}
		_, err := b.database.Exec(ctx, "SELECT pg_sleep(5)")
		var pgerr *pgconn.PgError
		cancelled := errors.As(err, &pgerr) && pgerr.Code == "57014"
		if _, err := b.database.Exec(ctx, "SET statement_timeout='5s'"); err != nil {
			return nil, err
		}
		var value int
		err = b.database.QueryRow(ctx, "SELECT 1 AS value").Scan(&value)
		return map[string]any{"cancelled": cancelled, "recovered": value == 1}, err
	}
	return nil, fmt.Errorf("unknown benchmark mode")
}
func main() {
	b := &Bench{}
	defer func() {
		if b.database != nil {
			_ = b.database.Close(context.Background())
		}
	}()
	server := mcp.NewServer(&mcp.Implementation{Name: "omnisql-language-spike", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "bench", Description: "Run a fixed benchmark workload"}, func(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
		value, err := b.execute(ctx, in.Mode)
		if err != nil {
			return nil, nil, fmt.Errorf("benchmark failed")
		}
		data, err := json.Marshal(value)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil, nil
	})
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		os.Exit(1)
	}
}
