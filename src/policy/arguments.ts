import { Tool } from '@modelcontextprotocol/sdk/types.js';

/** MCP tool schemas are advertised to clients, but arguments still need server-side validation. */
export function validateToolArguments(tool: Tool, input: unknown): Record<string, unknown> {
  const value = input ?? {};
  const check = (schema: any, data: unknown, path: string): void => {
    const fail = (reason: string): never => {
      throw new Error(`${path}: ${reason}`);
    };
    if (schema.type === 'object') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('expected an object');
      const object = data as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in object)) fail(`missing ${key}`);
      for (const [key, entry] of Object.entries(object)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) fail(`unknown argument ${key}`);
        check(schema.properties[key], entry, `${path}.${key}`);
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) fail('expected an array');
      if ((data as unknown[]).length > 100) fail('too many items');
      for (const item of data as unknown[]) check(schema.items, item, path);
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof data !== 'number' || !Number.isFinite(data)) fail('expected a finite number');
      if (schema.type === 'integer' && !Number.isInteger(data)) fail('expected an integer');
      if (schema.minimum !== undefined && (data as number) < schema.minimum)
        fail(`must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && (data as number) > schema.maximum)
        fail(`must be at most ${schema.maximum}`);
    } else if (schema.type === 'boolean') {
      if (typeof data !== 'boolean') fail('expected a boolean');
    } else if (schema.type === 'string') {
      if (typeof data !== 'string') fail('expected a string');
      if (Buffer.byteLength(data as string) > (schema.maxLength ?? 1_000_000))
        fail('value is too long');
      if ((data as string).length < (schema.minLength ?? 0)) fail('value is too short');
    }
    if (schema.enum && !schema.enum.includes(data)) fail(`expected ${schema.enum.join(', ')}`);
  };
  check(tool.inputSchema, value, tool.name);
  return value as Record<string, unknown>;
}
