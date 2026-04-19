import { DBeaverConfigParser } from '../config-parser.js';
import type { DBeaverConnection } from '../types.js';

/**
 * Wraps the DBeaverConfigParser to provide a uniform connection source interface.
 *
 * A "source" represents a single DBeaver workspace from which connections can
 * be discovered. Multiple sources can be aggregated by the ConnectionRegistry
 * to support multi-workspace setups in the future.
 */
export class DBeaverConnectionSource {
  private parser: DBeaverConfigParser;

  constructor(parser: DBeaverConfigParser) {
    this.parser = parser;
  }

  /**
   * Retrieve every connection defined in this DBeaver workspace.
   * Credentials are decrypted and merged automatically by the parser.
   */
  async getConnections(): Promise<DBeaverConnection[]> {
    return this.parser.parseConnections();
  }

  /**
   * Look up a single connection by its ID or display name.
   * Returns `null` when no match is found.
   */
  async getConnection(id: string): Promise<DBeaverConnection | null> {
    return this.parser.getConnection(id);
  }

  /**
   * Check whether the underlying DBeaver workspace directory structure
   * exists and looks valid (i.e. the expected metadata paths are present).
   */
  isValid(): boolean {
    return this.parser.isWorkspaceValid();
  }

  /**
   * Return diagnostic information about the workspace for troubleshooting.
   */
  getDebugInfo(): object {
    return this.parser.getDebugInfo();
  }

  /**
   * Return the resolved workspace path used by this source.
   */
  getWorkspacePath(): string {
    return this.parser.getWorkspacePath();
  }
}
