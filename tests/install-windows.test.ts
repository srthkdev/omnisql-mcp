import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clientInvocation } from '../src/install.js';

it.skipIf(process.platform !== 'win32')(
  'runs real Windows client cmd shims with literal special characters',
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'omnisql windows '));
    try {
      fs.writeFileSync(
        join(directory, 'capture.cjs'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
      );
      const shim = join(directory, 'client.cmd');
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`);
      const values = [
        'mcp',
        'add',
        '--env',
        'OMNISQL_CONFIG_FILE=C:\\My Databases\\a & b%done!.json',
        '--env',
        'OMNISQL_ALLOWED_CONNECTIONS=dev,analytics',
      ];
      const invocation = clientInvocation(shim, values);
      const result = spawnSync(invocation.command, invocation.args, {
        env: invocation.env,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(values);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
