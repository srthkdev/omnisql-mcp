import type { ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse } from './base.js';
import { sanitizeConnectionId } from '../utils.js';
import {
  BeginTransactionSchema,
  BeginTransactionInput,
  CommitTransactionSchema,
  CommitTransactionInput,
  RollbackTransactionSchema,
  RollbackTransactionInput,
  ExecuteInTransactionSchema,
  ExecuteInTransactionInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

type BeginTransactionParams = z.infer<typeof BeginTransactionInput>;
type CommitTransactionParams = z.infer<typeof CommitTransactionInput>;
type RollbackTransactionParams = z.infer<typeof RollbackTransactionInput>;
type ExecuteInTransactionParams = z.infer<typeof ExecuteInTransactionInput>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleBeginTransaction(
  input: BeginTransactionParams,
  ctx: ToolContext
): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);
  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const result = await ctx.transactionManager.beginTransaction(connection);
  return jsonResponse(result);
}

async function handleCommitTransaction(
  input: CommitTransactionParams,
  ctx: ToolContext
): Promise<ToolResult> {
  const result = await ctx.transactionManager.commitTransaction(input.transactionId);
  return jsonResponse(result);
}

async function handleRollbackTransaction(
  input: RollbackTransactionParams,
  ctx: ToolContext
): Promise<ToolResult> {
  const result = await ctx.transactionManager.rollbackTransaction(input.transactionId);
  return jsonResponse(result);
}

async function handleExecuteInTransaction(
  input: ExecuteInTransactionParams,
  ctx: ToolContext
): Promise<ToolResult> {
  // Validate the query through the safety layer (allow all DML/DDL within transactions)
  const validationError = ctx.safetyLayer.validateQuery(input.query, {
    readOnly: false,
    allowInsert: true,
    allowUpdate: true,
    allowDelete: true,
    allowDDL: true,
  });
  if (validationError) {
    throw new Error(validationError);
  }

  const result = await ctx.transactionManager.executeInTransaction(
    input.transactionId,
    input.query
  );
  return jsonResponse(result);
}

// ═══════════════════════════════════════════════════════════════════════════
// Exported tool definitions
// ═══════════════════════════════════════════════════════════════════════════

export const transactionTools: ToolDefinition[] = [
  {
    name: 'begin_transaction',
    description: 'Start a new database transaction',
    category: 'admin',
    inputSchema: BeginTransactionSchema.jsonSchema,
    zodSchema: BeginTransactionSchema.zodSchema,
    handler: handleBeginTransaction,
  },
  {
    name: 'commit_transaction',
    description: 'Commit an active transaction',
    category: 'admin',
    inputSchema: CommitTransactionSchema.jsonSchema,
    zodSchema: CommitTransactionSchema.zodSchema,
    handler: handleCommitTransaction,
  },
  {
    name: 'rollback_transaction',
    description: 'Rollback an active transaction',
    category: 'admin',
    inputSchema: RollbackTransactionSchema.jsonSchema,
    zodSchema: RollbackTransactionSchema.zodSchema,
    handler: handleRollbackTransaction,
  },
  {
    name: 'execute_in_transaction',
    description: 'Execute a query within an active transaction',
    category: 'admin',
    inputSchema: ExecuteInTransactionSchema.jsonSchema,
    zodSchema: ExecuteInTransactionSchema.zodSchema,
    handler: handleExecuteInTransaction,
  },
];
