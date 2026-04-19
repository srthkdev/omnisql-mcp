import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BusinessInsight, ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse } from './base.js';
import {
  AppendInsightSchema,
  AppendInsightInput,
  ListInsightsSchema,
  ListInsightsInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Insight state – persisted to a JSON file in the system temp directory.
// ---------------------------------------------------------------------------

const MAX_INSIGHTS = 1000;
const INSIGHTS_FILE = path.join(os.tmpdir(), 'dbeaver-mcp-insights.json');

let insights: BusinessInsight[] = [];

// Load insights from disk on module init
try {
  if (fs.existsSync(INSIGHTS_FILE)) {
    insights = JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf-8'));
  }
} catch {
  insights = [];
}

function saveInsights(): void {
  try {
    if (insights.length > MAX_INSIGHTS) {
      insights = insights.slice(-MAX_INSIGHTS);
    }
    fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(insights, null, 2));
  } catch {
    // Silently fail -- non-critical feature
  }
}

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

type AppendInsightParams = z.infer<typeof AppendInsightInput>;
type ListInsightsParams = z.infer<typeof ListInsightsInput>;

// ═══════════════════════════════════════════════════════════════════════════
// Insight tools – append and list business insights.
// ═══════════════════════════════════════════════════════════════════════════

export const insightTools: ToolDefinition[] = [
  // -----------------------------------------------------------------------
  // append_insight
  // -----------------------------------------------------------------------
  {
    name: 'append_insight',
    description: 'Store a business insight or analysis note for later reference',
    category: 'analysis',
    inputSchema: AppendInsightSchema.jsonSchema,
    zodSchema: AppendInsightSchema.zodSchema,

    async handler(input: AppendInsightParams, _ctx: ToolContext): Promise<ToolResult> {
      const newInsight: BusinessInsight = {
        id: Date.now(),
        insight: input.insight.trim(),
        created_at: new Date().toISOString(),
        connection: input.connection,
        tags: input.tags || [],
      };

      insights.push(newInsight);
      saveInsights();

      return jsonResponse({
        success: true,
        message: 'Insight added successfully',
        id: newInsight.id,
      });
    },
  },

  // -----------------------------------------------------------------------
  // list_insights
  // -----------------------------------------------------------------------
  {
    name: 'list_insights',
    description: 'List stored business insights, optionally filtered by connection or tags',
    category: 'analysis',
    inputSchema: ListInsightsSchema.jsonSchema,
    zodSchema: ListInsightsSchema.zodSchema,

    async handler(input: ListInsightsParams, _ctx: ToolContext): Promise<ToolResult> {
      let filtered = insights;

      if (input.connection) {
        filtered = filtered.filter((i) => i.connection === input.connection);
      }

      if (input.tags && input.tags.length > 0) {
        filtered = filtered.filter(
          (i) => i.tags && i.tags.some((tag) => input.tags!.includes(tag))
        );
      }

      return jsonResponse(filtered);
    },
  },
];
