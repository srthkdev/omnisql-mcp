import type { DatabaseConnection, QueryResult } from '../types.js';
export interface QueryOptions {
  maxRows?: number;
  readOnly: boolean;
}
export interface SqlAdapter {
  id: string;
  capabilities: {
    databaseOverride: boolean;
    readOnly: 'transaction' | 'file' | 'permissions';
    transactions: boolean;
  };
  execute(
    connection: DatabaseConnection,
    query: string,
    options: QueryOptions
  ): Promise<QueryResult>;
}
export class AdapterRegistry {
  private adapters = new Map<string, SqlAdapter>();
  constructor(adapters: SqlAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error('Duplicate database adapter');
      this.adapters.set(adapter.id, adapter);
    }
  }
  get(id: string): SqlAdapter | undefined {
    return this.adapters.get(id);
  }
}
