import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfiguredConnections } from './connections-config.js';

/** Setup never follows a symlink while writing configuration or asking a client to do so. */
export function assertNoSymlinks(file: string): void {
  let current = resolve(file);
  while (true) {
    try {
      if (
        fs.lstatSync(current).isSymbolicLink() &&
        !(process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(current))
      )
        throw new Error(
          'Setup will not use a symlink configuration destination. Choose a regular path.'
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function validateSetupConfig(file: string): string[] {
  assertNoSymlinks(file);
  if (!fs.statSync(file).isFile())
    throw new Error('Connection configuration must be a regular file.');
  let connections;
  try {
    connections = loadConfiguredConnections(file);
  } catch {
    throw new Error(
      'Invalid connection configuration. Check its version, settings and credential environment references.'
    );
  }
  if (!connections.length)
    throw new Error('Add at least one connection before registering the server.');
  // Commas delimit the runtime allowlist. Restrict setup IDs to unambiguous logical names.
  if (connections.some(({ id }) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)))
    throw new Error(
      'Setup connection IDs must use letters, numbers, dots, underscores or hyphens.'
    );
  return connections.map(({ id }) => id);
}

/** Exclusive creation preserves existing files, including broken symlinks. */
export function writeSetupConfig(file: string, config: unknown): string[] {
  assertNoSymlinks(file);
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    fs.closeSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  try {
    return validateSetupConfig(file);
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  }
}
