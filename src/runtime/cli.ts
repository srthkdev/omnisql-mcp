import { spawn } from 'node:child_process';
import type { DatabaseConnection, QueryResult } from '../types.js';
import { ResultCollector, JsonRowStream } from './results.js';

/** Bounded, shell-free JSON output for embedded database command line clients. */
export function runJsonCli(
  connection: DatabaseConnection,
  command: string,
  args: string[],
  label: string,
  timeout: number,
  maxRows?: number,
  options: { output?: 'json' | 'text'; decimalText?: boolean } = {}
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A failed spawn surfaces twice: once as 'error' on the child, and again
    // as EPIPE on the stdin we write to below. Both are 'error' events with
    // no listener, which Node turns into an uncaught throw that takes the
    // whole MCP server down instead of failing this one tool call.
    let settled = false;
    let capped = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`${label} query timed out after ${timeout}ms`));
    }, timeout);
    const fail = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const hint =
        err.code === 'ENOENT'
          ? `${command} CLI not found on PATH - install it to query ${label} connections`
          : err.code === 'EACCES'
            ? `${command} CLI is not executable`
            : `Failed to run ${command} CLI`;
      reject(new Error(`${hint}: ${err.message}`));
    };

    proc.on('error', fail);
    proc.stdin.on('error', fail);

    const collector = new ResultCollector(connection, maxRows);
    const stream = new JsonRowStream(collector, options.decimalText);
    let text = '';
    let error = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (data: string) => {
      if (settled || capped) return;
      try {
        if (options.output === 'text') {
          text += data;
          if (Buffer.byteLength(text) > collector.maxBytes)
            throw new Error(`${label} output exceeds its byte limit`);
          return;
        }
        if (!stream.write(data)) {
          capped = true;
          proc.kill('SIGKILL');
        }
      } catch (error) {
        settled = true;
        clearTimeout(deadline);
        proc.kill('SIGKILL');
        reject(error);
      }
    });
    proc.stderr.on('data', (data) => {
      if (error.length < 65536) error += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      if ((!capped && code !== 0) || error.trim()) {
        reject(new Error(`${label} error: ${error}`));
        return;
      }

      try {
        if (options.output === 'text') {
          collector.columns = ['explain_key', 'explain_value'];
          if (!collector.add(['plan', text]))
            throw new Error(`${label} plan exceeds its result limit`);
        }
        resolve(collector.result());
      } catch (error) {
        reject(error);
      }
    });
    proc.stdin.end();
  });
}
