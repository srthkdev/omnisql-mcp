import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrivateNotes } from '../src/runtime/notes.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-notes-test-'));
afterEach(() => {
  for (const d of fs.readdirSync(root))
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
});
const note = {
  id: 1,
  insight: 'Synthetic note',
  created_at: new Date().toISOString(),
  connection: 'reports',
  tags: ['fixture'],
};
describe('private scoped notes', () => {
  it('separates workspace/access scopes and preserves notes in the same scope', () => {
    new PrivateNotes('workspace-a|reports', root).save([note]);
    expect(new PrivateNotes('workspace-a|reports', root).load()).toEqual([note]);
    expect(new PrivateNotes('workspace-a|restricted', root).load()).toEqual([]);
    expect(new PrivateNotes('workspace-b|reports', root).load()).toEqual([]);
    for (const dir of fs.readdirSync(root)) {
      const directory = path.join(root, dir);
      if (process.platform !== 'win32') expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      if (fs.existsSync(path.join(directory, 'insights.json')) && process.platform !== 'win32')
        expect(fs.statSync(path.join(directory, 'insights.json')).mode & 0o777).toBe(0o600);
    }
  });
  it('bounds persisted and in-memory notes together', () => {
    const notes = new PrivateNotes('limit', root);
    const retained = notes.save(
      Array.from({ length: 100 }, (_, id) => ({ ...note, id, insight: 'x'.repeat(16384) }))
    );
    expect(retained.length).toBeLessThan(100);
    expect(notes.load()).toEqual(retained);
  });
  it('rejects symlinked note files', () => {
    if (process.platform === 'win32') return;
    const notes = new PrivateNotes('link', root);
    notes.save([note]);
    const dir = fs.readdirSync(root)[0];
    const file = path.join(root, dir, 'insights.json');
    fs.unlinkSync(file);
    fs.symlinkSync('/etc/passwd', file);
    expect(() => notes.load()).toThrow();
  });
});
