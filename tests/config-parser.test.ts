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
});
