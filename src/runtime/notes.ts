import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { BusinessInsight } from '../types.js';
import { readPrivateFile } from './private-file.js';
/** Private, bounded notes scoped to the workspace and its access configuration. */
export class PrivateNotes {
  private directory: string;
  private file: string;
  constructor(scope: string, root = join(homedir(), '.cache', 'omnisql-mcp', 'notes')) {
    this.directory = join(root, createHash('sha256').update(scope).digest('hex'));
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Notes directory must be a private directory');
    fs.chmodSync(this.directory, 0o700);
    this.file = join(this.directory, 'insights.json');
  }
  load(): BusinessInsight[] {
    try {
      const parsed: unknown = JSON.parse(readPrivateFile(this.file, 1048576, 'Notes file'));
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (n) =>
            !n ||
            typeof n.insight !== 'string' ||
            typeof n.id !== 'number' ||
            typeof n.created_at !== 'string' ||
            (n.connection !== undefined && typeof n.connection !== 'string') ||
            (n.tags !== undefined &&
              (!Array.isArray(n.tags) || n.tags.some((t: unknown) => typeof t !== 'string')))
        )
      )
        throw new Error('Invalid notes file');
      return parsed.slice(-1000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  save(notes: BusinessInsight[]): BusinessInsight[] {
    let retained = notes.slice(-1000);
    while (Buffer.byteLength(JSON.stringify(retained)) > 1048576) retained = retained.slice(1);
    const temp = join(this.directory, randomBytes(12).toString('hex') + '.tmp');
    const fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(retained));
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return retained;
  }
}
