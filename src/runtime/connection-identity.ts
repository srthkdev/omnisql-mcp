import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';

/** Private identity for sessions and cached results; never include it in MCP responses. */
export function connectionFingerprint(connection: DatabaseConnection): string {
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}
