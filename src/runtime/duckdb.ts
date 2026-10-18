import { integerSetting } from '../runtime-config.js';
import { ReadWriteGate } from './concurrency.js';
import { validateReadStatement, sqlTokens } from '../policy/sql.js';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SqlAdapter } from './adapter.js';
import { runJsonCli } from './cli.js';

let checked: { command: string; until: number; pending: Promise<void> } | undefined;
function checkVersion(command: string): Promise<void> {
  if (checked?.command === command && checked.until > Date.now()) return checked.pending;
  const pending = new Promise<void>((resolveVersion, reject) => {
    execFile(command, ['-version'], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) {
        reject(
          new Error(
            'DuckDB CLI not available; install DuckDB 1.5.6+ or set OMNISQL_DUCKDB_CLI to its executable'
          )
        );
        return;
      }
      const version = String(stdout).match(/^v(\d+)\.(\d+)\.(\d+)/);
      if (
        !version ||
        !(
          Number(version[1]) > 1 ||
          (Number(version[1]) === 1 &&
            (Number(version[2]) > 5 || (Number(version[2]) === 5 && Number(version[3]) >= 6)))
        )
      ) {
        reject(new Error('DuckDB CLI 1.5.6 or newer is required'));
        return;
      }
      resolveVersion();
    });
  });
  checked = { command, until: Date.now() + 300000, pending };
  void pending.catch(() => {
    if (checked?.pending === pending) checked = undefined;
  });
  return pending;
}

/** External access stays disabled for write-enabled connections too. */
export function duckdbAdapter(defaultTimeout: () => number): SqlAdapter {
  const files = new Map<string, { gate: ReadWriteGate; users: number }>();
  return {
    id: 'duckdb',
    capabilities: { databaseOverride: false, readOnly: 'file', transactions: false },
    async execute(connection, query, options) {
      const path = connection.database || connection.properties?.database;
      if (!path || path === ':memory:')
        throw new Error(
          'DuckDB requires an existing local database file; in-memory and remote connections are unsupported'
        );
      const database = await realpath(resolve(path));
      if (!(await stat(database)).isFile())
        throw new Error('DuckDB database must be a regular local file');
      const command = process.env.OMNISQL_DUCKDB_CLI || 'duckdb';
      await checkVersion(command);
      if (query.trimStart().startsWith('.'))
        throw new Error('DuckDB CLI dot commands are not supported');
      // Set limits before safe_mode locks configuration. Never read user startup files.
      const memory = integerSetting(
        connection.properties?.['duckdb.memoryMB'],
        'duckdb.memoryMB',
        256,
        16,
        4096
      );
      const threads = integerSetting(
        connection.properties?.['duckdb.threads'],
        'duckdb.threads',
        2,
        1,
        32
      );
      const setup = `SET autoload_known_extensions=false;SET autoinstall_known_extensions=false;SET allow_community_extensions=false;SET memory_limit='${memory}MB';SET threads=${threads};SET temp_directory='';`;
      const readOnly = options.readOnly || validateReadStatement(query) === null;
      const timeout = connection.limits?.timeoutMs ?? defaultTimeout();
      const entry = files.get(database) ?? { gate: new ReadWriteGate(), users: 0 };
      files.set(database, entry);
      entry.users++;
      let release: (() => void) | undefined;
      try {
        release = await entry.gate.acquire(!readOnly, timeout);
        const result = await runJsonCli(
          connection,
          command,
          [
            '-no-init',
            '-batch',
            '-bail',
            '-json',
            '-cmd',
            setup,
            '-cmd',
            '.safe_mode',
            ...(readOnly ? ['-readonly'] : []),
            database,
            query,
          ],
          'DuckDB',
          timeout,
          options.maxRows,
          {
            output: sqlTokens(query)[0]?.value.toUpperCase() === 'EXPLAIN' ? 'text' : 'json',
            decimalText: true,
          }
        );
        if (!readOnly) result.affectedRows = null;
        return result;
      } finally {
        release?.();
        if (--entry.users === 0) files.delete(database);
      }
    },
  };
}
