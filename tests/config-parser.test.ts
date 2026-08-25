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
