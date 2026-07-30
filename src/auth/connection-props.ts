import { DatabaseConnection } from '../types.js';

/**
 * Read a connection property, looking through both levels the workspace uses.
 *
 * The JSON workspace format keeps engine/driver properties nested under a
 * `properties` key inside the connection configuration, while the legacy XML
 * format keeps everything flat. Nested values win, since that is where
 * driver-specific configuration lives.
 *
 * Names are matched case-insensitively because casing varies by driver
 * (Postgres uses `sslmode`, MySQL uses `sslMode`). Nested objects are skipped
 * so a container never masks a scalar of the same name.
 */
export function readConnectionProp(
  connection: DatabaseConnection,
  ...names: string[]
): string | undefined {
  const props = (connection.properties ?? {}) as Record<string, unknown>;
  const nested = (props['properties'] as Record<string, unknown> | undefined) ?? {};

  for (const name of names) {
    const wanted = name.toLowerCase();
    for (const source of [nested, props]) {
      const key = Object.keys(source).find((k) => k.toLowerCase() === wanted);
      if (key === undefined) {
        continue;
      }
      const value = source[key];
      if (value === undefined || value === null || typeof value === 'object') {
        continue;
      }
      const str = String(value);
      if (str.length > 0) {
        return str;
      }
    }
  }

  return undefined;
}
