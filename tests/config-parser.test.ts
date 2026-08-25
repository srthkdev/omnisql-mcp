import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';

// Mock fs module
vi.mock('fs');
vi.mock('os');

describe('WorkspaceConfigParser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.platform).mockReturnValue('darwin');
    vi.mocked(os.homedir).mockReturnValue('/Users/test');
  });

  describe('getDefaultWorkspacePath', () => {
    it('should return macOS path on darwin', async () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Dynamic import to get fresh instance
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});

      expect(parser.getWorkspacePath()).toContain('Library/DBeaverData');
    });
  });

  describe('parseConnections', () => {
    it('should return empty array when no config exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});

      const connections = await parser.parseConnections();
      expect(connections).toEqual([]);
    });
  });

  describe('URL-mode connections (#26)', () => {
    /** Stand up a parser over a synthetic data-sources.json. */
    async function parseWith(connections: Record<string, unknown>) {
      const dataSources = '/Users/test/workspace6/General/.dbeaver/data-sources.json';
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === dataSources);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ connections }) as never);

      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({ workspacePath: '/Users/test/workspace6' });
      return parser.parseConnections();
    }

    it('should use the JDBC URL host, not the localhost placeholder', async () => {
      // Exactly the shape DBeaver writes for a URL-mode connection: host and
      // port are placeholders it never reads, the URL is the connection.
      const [conn] = await parseWith({
        'mysql-1': {
          name: 'Aliyun RDS',
          provider: 'mysql',
          driver: 'mysql8',
          configuration: {
            host: 'localhost',
            port: '3306',
            url: 'jdbc:mysql://rm-xxxxx.mysql.rds.aliyuncs.com:3306/orders',
            configurationType: 'URL',
          },
        },
      });

      expect(conn.host).toBe('rm-xxxxx.mysql.rds.aliyuncs.com');
      expect(conn.port).toBe(3306);
      expect(conn.database).toBe('orders');
      // The properties bag feeds the direct-query path, so it has to agree.
      expect(conn.properties?.host).toBe('rm-xxxxx.mysql.rds.aliyuncs.com');
    });

    it('should keep recorded fields the URL does not carry', async () => {
      const [conn] = await parseWith({
        'pg-1': {
          name: 'Reporting',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: {
            host: 'localhost',
            port: '5432',
            database: 'reporting',
            url: 'jdbc:postgresql://pg.example.com',
            configurationType: 'URL',
          },
        },
      });

      expect(conn.host).toBe('pg.example.com');
      expect(conn.database).toBe('reporting');
    });

    it('should leave the endpoint alone when a URL-mode URL cannot be parsed', async () => {
      const [conn] = await parseWith({
        'ora-1': {
          name: 'Legacy',
          provider: 'oracle',
          driver: 'oracle_thin',
          configuration: {
            host: 'ora.internal',
            port: '1521',
            url: 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=ora.internal)))',
            configurationType: 'URL',
          },
        },
      });

      expect(conn.host).toBe('ora.internal');
      expect(conn.port).toBe(1521);
    });

    it('should not let a generated URL override a MANUAL connection', async () => {
      // In MANUAL mode the typed host wins; the URL is derived from it and can
      // lag behind an edit. Nothing here may point at the stale value.
      const [conn] = await parseWith({
        'pg-2': {
          name: 'Primary',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: {
            host: 'pg-new.example.com',
            port: '5432',
            database: 'app',
            url: 'jdbc:postgresql://pg-old.example.com:5432/app',
            configurationType: 'MANUAL',
          },
        },
      });

      expect(conn.host).toBe('pg-new.example.com');
    });

    it('should still backfill from the URL when the config omits a field', async () => {
      const [conn] = await parseWith({
        'pg-3': {
          name: 'Custom driver',
          provider: 'postgresql',
          driver: 'a1db2f3c-9e4d-4a1b-8c7e-000000000000',
          configuration: {
            url: 'jdbc:postgresql://pg.example.com:5433/analytics',
          },
        },
      });

      expect(conn.host).toBe('pg.example.com');
      expect(conn.port).toBe(5433);
      expect(conn.database).toBe('analytics');
      // And the UUID driver id resolves through the provider.
      expect(conn.driver).toBe('postgresql');
    });
  });

  describe('SSH tunnel connections (#28)', () => {
    it('should carry the tunnel handler onto the connection', async () => {
      const dataSources = '/Users/test/workspace6/General/.dbeaver/data-sources.json';
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === dataSources);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          connections: {
            'pg-tunnel': {
              name: 'Behind bastion',
              provider: 'postgresql',
              driver: 'postgres-jdbc',
              configuration: {
                // The target as the SSH server sees it - not an address this
                // machine can use.
                host: 'localhost',
                port: 5432,
                database: 'mydb',
                handlers: {
                  ssh_tunnel: {
                    type: 'TUNNEL',
                    enabled: true,
                    properties: {
                      host: 'db-host.internal.example.com',
                      port: 22,
                      authType: 'AGENT',
                    },
                  },
                },
              },
            },
          },
        }) as never
      );

      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({ workspacePath: '/Users/test/workspace6' });
      const [conn] = await parser.parseConnections();

      expect(conn.sshTunnel).toMatchObject({
        enabled: true,
        host: 'db-host.internal.example.com',
        port: 22,
        authType: 'AGENT',
      });
      // The recorded host stays as-is; it is the forward's destination.
      expect(conn.host).toBe('localhost');
    });
  });

  describe('projectName', () => {
    it('should default to General when projectName is not provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({ workspacePath: '/Users/test/workspace6' });

      const debugInfo = parser.getDebugInfo() as { connectionsFile: string };
      expect(debugInfo.connectionsFile).toBe(
        '/Users/test/workspace6/General/.dbeaver/data-sources.json'
      );
    });

    it('should use a custom projectName when provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({
        workspacePath: '/Users/test/workspace6',
        projectName: 'DataPlatform',
      });

      const debugInfo = parser.getDebugInfo() as { connectionsFile: string };
      expect(debugInfo.connectionsFile).toBe(
        '/Users/test/workspace6/DataPlatform/.dbeaver/data-sources.json'
      );
    });
  });

  describe('getConnection database-override syntax', () => {
    const baseConnection = {
      id: 'conn-1',
      name: 'my-conn',
      driver: 'postgres-jdbc',
      url: 'jdbc:postgresql://host:5432/postgres',
      host: 'host',
      port: 5432,
      database: 'postgres',
      user: 'app',
      properties: { user: 'app', host: 'host', database: 'postgres', sslmode: 'require' },
    };

    it('should look up by base id when no slash is present', async () => {
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});
      vi.spyOn(parser, 'parseConnections').mockResolvedValue([baseConnection]);

      const result = await parser.getConnection('conn-1');
      expect(result).toEqual(baseConnection);
    });

    it('should look up by name when no slash is present', async () => {
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});
      vi.spyOn(parser, 'parseConnections').mockResolvedValue([baseConnection]);

      const result = await parser.getConnection('my-conn');
      expect(result).toEqual(baseConnection);
    });

    it('should override database when "<id>/<database>" syntax is used', async () => {
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});
      vi.spyOn(parser, 'parseConnections').mockResolvedValue([baseConnection]);

      const result = await parser.getConnection('conn-1/analytics');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('conn-1/analytics');
      expect(result!.database).toBe('analytics');
      expect(result!.properties?.database).toBe('analytics');
      // Other fields remain intact
      expect(result!.host).toBe('host');
      expect(result!.user).toBe('app');
      expect(result!.properties?.sslmode).toBe('require');
    });

    it('should not mutate the cached connection when overriding', async () => {
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});
      vi.spyOn(parser, 'parseConnections').mockResolvedValue([baseConnection]);

      await parser.getConnection('conn-1/analytics');
      expect(baseConnection.id).toBe('conn-1');
      expect(baseConnection.database).toBe('postgres');
      expect(baseConnection.properties.database).toBe('postgres');
    });

    it('should return null when the base id does not match', async () => {
      const { WorkspaceConfigParser } = await import('../src/config-parser.js');
      const parser = new WorkspaceConfigParser({});
      vi.spyOn(parser, 'parseConnections').mockResolvedValue([baseConnection]);

      const result = await parser.getConnection('does-not-exist/analytics');
      expect(result).toBeNull();
    });
  });
});
