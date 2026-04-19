import type { ToolDefinition, ToolCategory } from './base.js';
import type { ToolContext, ToolResult, ServerConfig } from '../types.js';
import { connectionTools } from './connection-tools.js';
import { queryTools } from './query-tools.js';
import { schemaTools } from './schema-tools.js';
import { transactionTools } from './transaction-tools.js';
import { analysisTools } from './analysis-tools.js';
import { insightTools } from './insight-tools.js';

// Categories that are disabled in read-only mode
const WRITE_CATEGORIES: ToolCategory[] = ['write', 'ddl', 'admin'];

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor(config: ServerConfig) {
    // Collect all tools
    const allTools: ToolDefinition[] = [
      ...connectionTools,
      ...queryTools,
      ...schemaTools,
      ...transactionTools,
      ...analysisTools,
      ...insightTools,
    ];

    // Register tools, filtering by config
    for (const tool of allTools) {
      // Skip write/ddl/admin tools in read-only mode
      if (config.readOnly && WRITE_CATEGORIES.includes(tool.category)) {
        continue;
      }

      // Skip explicitly disabled tools
      if (config.disabledTools.includes(tool.name)) {
        continue;
      }

      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Get all registered tools for MCP ListToolsResponse.
   */
  listTools(): Array<{ name: string; description: string; inputSchema: any }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Execute a tool by name with the given arguments and context.
   * Validates input with Zod before calling the handler.
   */
  async executeTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Validate input with Zod
    const parsed = tool.zodSchema.parse(args || {});

    // Execute handler
    return tool.handler(parsed, ctx);
  }

  /**
   * Check if a tool is registered (not disabled/filtered out).
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}
