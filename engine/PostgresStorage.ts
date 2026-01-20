/**
 * Saga Engine - PostgreSQL Storage
 *
 * The ONLY production-safe storage adapter.
 * Provides ACID guarantees, atomic operations, and durable persistence.
 */

import { Pool, PoolClient } from 'pg';
import { StorageAdapter } from './Storage';
import {
  StepContext,
  WorkflowStatus,
  WorkflowRecord,
  WorkflowFilter,
  WorkflowQueryResult,
  WorkflowError,
} from './types/WorkflowState';

/**
 * PostgreSQL storage adapter for production use.
 *
 * Features:
 * - ACID guarantees for all operations
 * - Atomic step persistence
 * - Query API for workflow status
 * - Atomic retry for dead_letter recovery
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { PostgresStorage, PostgresLock, Transaction } from 'saga-engine';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const storage = new PostgresStorage(pool);
 * const lock = new PostgresLock(pool);
 *
 * const tx = new Transaction('order-123', storage, {
 *   idempotencyKey: 'order-123',
 *   lock,
 * });
 * ```
 */
export class PostgresStorage implements StorageAdapter {
  /**
   * PostgresStorage is SAFE for production use.
   */
  readonly isProductionSafe = true as const;

  private pool: Pool;
  private tableName: string;

  /**
   * Create a PostgresStorage instance.
   *
   * @param poolOrConnectionString - Pg Pool instance or connection string
   * @param tableName - Table name (default: 'transactions')
   */
  constructor(poolOrConnectionString: Pool | string, tableName = 'transactions') {
    // Validate table name to prevent SQL injection
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(
        `Invalid table name: "${tableName}". ` +
        `Must contain only letters, numbers, and underscores, and start with a letter or underscore.`
      );
    }
    this.tableName = tableName;

    if (typeof poolOrConnectionString === 'string') {
      this.pool = new Pool({ connectionString: poolOrConnectionString });
    } else {
      this.pool = poolOrConnectionString;
    }
  }

  /**
   * Safely escape identifier for PostgreSQL
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Get escaped table name
   */
  private get table(): string {
    return this.escapeIdentifier(this.tableName);
  }

  // === Core Step Operations ===

  async save(transactionId: string, state: StepContext[], input?: any): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check if workflow exists
      const existing = await client.query(
        `SELECT input FROM ${this.table} WHERE id = $1`,
        [transactionId]
      );

      if (existing.rows.length === 0) {
        // Insert new workflow
        await client.query(
          `INSERT INTO ${this.table} (id, status, step_stack, input, retry_count, created_at, updated_at)
           VALUES ($1, 'pending', $2, $3, 0, NOW(), NOW())`,
          [transactionId, JSON.stringify(state), JSON.stringify(input || {})]
        );
      } else {
        // Update existing - preserve original input
        await client.query(
          `UPDATE ${this.table}
           SET step_stack = $2, updated_at = NOW()
           WHERE id = $1`,
          [transactionId, JSON.stringify(state)]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async load(transactionId: string): Promise<StepContext[] | null> {
    const result = await this.pool.query(
      `SELECT step_stack FROM ${this.table} WHERE id = $1`,
      [transactionId]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].step_stack as StepContext[];
  }

  async clear(transactionId: string): Promise<void> {
    // On success, mark as completed rather than delete (for audit trail)
    await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [transactionId]
    );
  }

  // === Workflow Status Operations ===

  async updateStatus(
    transactionId: string,
    status: WorkflowStatus,
    error?: WorkflowError
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check if workflow exists
      const existing = await client.query(
        `SELECT id FROM ${this.table} WHERE id = $1`,
        [transactionId]
      );

      if (existing.rows.length === 0) {
        // Create workflow with status
        await client.query(
          `INSERT INTO ${this.table} (id, status, step_stack, input, error, retry_count, created_at, updated_at)
           VALUES ($1, $2, '[]', '{}', $3, 0, NOW(), NOW())`,
          [transactionId, status, error ? JSON.stringify(error) : null]
        );
      } else {
        // Update existing
        await client.query(
          `UPDATE ${this.table}
           SET status = $2, error = $3, updated_at = NOW()
           WHERE id = $1`,
          [transactionId, status, error ? JSON.stringify(error) : null]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getWorkflow(transactionId: string): Promise<WorkflowRecord | null> {
    const result = await this.pool.query(
      `SELECT id, status, step_stack, input, retry_count, error, created_at, updated_at
       FROM ${this.table}
       WHERE id = $1`,
      [transactionId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      status: row.status as WorkflowStatus,
      stepStack: row.step_stack as StepContext[],
      input: row.input,
      retryCount: row.retry_count,
      error: row.error as WorkflowError | null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // === Query Operations (READ-ONLY) ===

  async query(filter: WorkflowFilter): Promise<WorkflowQueryResult> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Build WHERE conditions
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      conditions.push(`status = ANY($${paramIndex})`);
      params.push(statuses);
      paramIndex++;
    }

    if (filter.createdAfter) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(filter.createdAfter);
      paramIndex++;
    }

    if (filter.createdBefore) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(filter.createdBefore);
      paramIndex++;
    }

    if (filter.updatedAfter) {
      conditions.push(`updated_at >= $${paramIndex}`);
      params.push(filter.updatedAfter);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM ${this.table} ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch with pagination
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    const dataResult = await this.pool.query(
      `SELECT id, status, step_stack, input, retry_count, error, created_at, updated_at
       FROM ${this.table}
       ${whereClause}
       ORDER BY updated_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const workflows: WorkflowRecord[] = dataResult.rows.map(row => ({
      id: row.id,
      status: row.status as WorkflowStatus,
      stepStack: row.step_stack as StepContext[],
      input: row.input,
      retryCount: row.retry_count,
      error: row.error as WorkflowError | null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));

    return { workflows, total };
  }

  async countByStatus(status: WorkflowStatus | WorkflowStatus[]): Promise<number> {
    const statuses = Array.isArray(status) ? status : [status];
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.table} WHERE status = ANY($1)`,
      [statuses]
    );
    return parseInt(result.rows[0].count, 10);
  }

  // === Admin Operations ===

  /**
   * Atomic retry operation for dead_letter recovery.
   *
   * Uses UPDATE ... WHERE status = 'dead_letter' to prevent race conditions.
   * Two concurrent CLI retries will result in only one increment.
   *
   * @returns New retry count, or null if not in dead_letter state
   */
  async atomicRetry(transactionId: string): Promise<number | null> {
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'pending',
           retry_count = retry_count + 1,
           error = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'dead_letter'
       RETURNING retry_count`,
      [transactionId]
    );

    if (result.rows.length === 0) {
      return null; // Not in dead_letter state (or doesn't exist)
    }

    return result.rows[0].retry_count;
  }

  // === Lifecycle ===

  /**
   * Close the connection pool.
   * Call this when shutting down your application.
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Get the underlying pool (for advanced use cases)
   */
  getPool(): Pool {
    return this.pool;
  }
}
