import { describe, it, expect, vi } from 'vitest';
import { WorkspaceClient } from '../src/workspace-client.js';
import { DatabaseConnection } from '../src/types.js';

describe('listDatabases', () => {
  it.each([
    ['postgresql', /has_database_privilege/],
    ['cockroachdb', /pg_database/],
    ['mysql8', /SHOW DATABASES/],
    ['mariadb', /SHOW DATABASES/],
    ['sqlserver', /HAS_DBACCESS/],
  ])('discovers accessible databases for %s', async (driver, expected) => {
    const client = new WorkspaceClient();
    const connection: DatabaseConnection = { id: 'saved', name: 'saved', driver, url: '' };
    const execute = vi.spyOn(client, 'executeQuery').mockResolvedValue({
      columns: ['name'],
      rows: [['app'], ['reports']],
      rowCount: 2,
      executionTime: 0,
    });
    expect(await client.listDatabases(connection)).toEqual(['app', 'reports']);
    expect(execute).toHaveBeenCalledWith(connection, expect.stringMatching(expected));
  });

  it('reports unsupported engines without calling the CLI', async () => {
    const client = new WorkspaceClient();
    const execute = vi.spyOn(client, 'executeQuery');
    await expect(
      client.listDatabases({ id: 'file', name: 'file', driver: 'sqlite', url: '' })
    ).rejects.toThrow(/supports PostgreSQL/);
    expect(execute).not.toHaveBeenCalled();
  });
});
