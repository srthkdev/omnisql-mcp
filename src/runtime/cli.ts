import { spawn } from 'node:child_process';
import type { DatabaseConnection, QueryResult } from '../types.js';
import { ResultCollector, JsonRowStream, ResultTextDecoder } from './results.js';

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
    let failure: Error | undefined;
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      proc.kill('SIGKILL');
    };
    const deadline = setTimeout(() => {
      stop(new Error(`${label} query timed out after ${timeout}ms`));
    }, timeout);
    const fail = (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT'
          ? `${command} CLI not found on PATH - install it to query ${label} connections`
          : err.code === 'EACCES'
            ? `${command} CLI is not executable`
            : `Failed to run ${command} CLI`;
      stop(new Error(`${hint}: ${err.message}`));
    };

    proc.on('error', fail);
    proc.stdin.on('error', fail);

    const collector = new ResultCollector(connection, maxRows);
    const stream = new JsonRowStream(collector, options.decimalText);
    const decoder = new ResultTextDecoder();
    let text = '';
    let error = '';
    proc.stdout.on('data', (bytes: Buffer) => {
      if (settled || capped || failure) return;
      try {
        const data = decoder.decode(bytes);
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
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proc.stderr.on('data', (data) => {
      if (error.length < 65536) error += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      if ((!capped && code !== 0) || error.trim()) {
        reject(new Error(`${label} error: ${error}`));
        return;
      }

      try {
        if (!capped) {
          const tail = decoder.decode();
          if (options.output === 'text') text += tail;
          else {
            if (tail) stream.write(tail);
            stream.finish();
          }
        }
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
