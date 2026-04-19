import { DBeaverConnection, ConnectionRegistryInterface } from '../types.js';
import { DBeaverConnectionSource } from './dbeaver-source.js';
import { redactConnection, sanitizeConnectionId } from '../utils.js';

/**
 * Central registry that aggregates connections from one or more
 * {@link DBeaverConnectionSource} instances and applies an optional whitelist
 * filter so that only explicitly allowed connections are visible to tools.
 *
 * Implements {@link ConnectionRegistryInterface} for dependency injection.
 */
export class ConnectionRegistry implements ConnectionRegistryInterface {
  private sources: DBeaverConnectionSource[];
  private allowedConnections: Set<string> | null;

  /**
   * @param sources - One or more DBeaver workspace sources to aggregate.
   * @param allowedConnections - Optional whitelist of connection IDs / names.
   *   When `null` (the default), every connection discovered by the sources
   *   is accessible.
   */
  constructor(sources: DBeaverConnectionSource[], allowedConnections: Set<string> | null = null) {
    this.sources = sources;
    this.allowedConnections = allowedConnections;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Test whether a connection passes the whitelist filter.
   * Matches on either the connection's ID or its display name.
   */
  private isAllowed(conn: { id: string; name: string }): boolean {
    if (!this.allowedConnections) return true;
    return this.allowedConnections.has(conn.id) || this.allowedConnections.has(conn.name);
  }

  // ── Public API (ConnectionRegistryInterface) ─────────────────────

  /**
   * Return every connection across all sources, filtered by the whitelist.
   */
  async getAllConnections(): Promise<DBeaverConnection[]> {
    const all: DBeaverConnection[] = [];
    for (const source of this.sources) {
      const conns = await source.getConnections();
      all.push(...conns);
    }
    return this.allowedConnections ? all.filter((c) => this.isAllowed(c)) : all;
  }

  /**
   * Find a single connection by ID or display name.
   *
   * The lookup strategy is:
   * 1. Sanitize the provided id and ask each source directly (fast path).
   * 2. If not found, fall back to a linear scan over all (filtered) connections
   *    matching by either `id` or `name` (handles cases where the raw id
   *    differs from the sanitized form, e.g. display-name lookups).
   *
   * Returns `null` when no allowed connection matches.
   */
  async getConnection(id: string): Promise<DBeaverConnection | null> {
    const safeId = sanitizeConnectionId(id);

    // Fast path: ask each source directly with the sanitized ID.
    for (const source of this.sources) {
      const conn = await source.getConnection(safeId);
      if (conn && this.isAllowed(conn)) return conn;
    }

    // Slow path: linear scan (supports display-name lookups that may contain
    // characters stripped by sanitizeConnectionId).
    const all = await this.getAllConnections();
    return all.find((c) => c.name === id || c.id === id) || null;
  }

  /**
   * Return a redacted copy of a connection suitable for returning to clients.
   * Passwords and other sensitive properties are replaced with placeholder text.
   */
  getRedactedConnection(conn: DBeaverConnection): Record<string, any> {
    return redactConnection(conn);
  }
}
