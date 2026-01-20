/**
 * Saga Engine - Storage Interface
 *
 * PRODUCTION RULE: Only PostgresStorage is safe for production.
 * MemoryStorage and FileStorage are available via 'saga-engine/testing' only.
 */

import {
  StepContext,
  WorkflowStatus,
  WorkflowRecord,
  WorkflowFilter,
  WorkflowQueryResult,
  WorkflowError,
} from './types/WorkflowState';

/**
 * Storage adapter interface for persisting workflow state.
 *
 * Implementations must set isProductionSafe to indicate whether
 * they provide durability guarantees suitable for production use.
 */
export interface StorageAdapter {
  /**
   * Whether this storage adapter is safe for production use.
   *
   * - PostgresStorage: true (ACID guarantees)
   * - MemoryStorage: false (data lost on restart)
   * - FileStorage: false (no durability guarantees)
   */
  readonly isProductionSafe: boolean;

  // === Core Step Operations (Atomic) ===

  /**
   * Save workflow state atomically.
   * This MUST be a single atomic operation (e.g., SQL transaction).
   *
   * @param transactionId - Unique transaction identifier
   * @param state - Array of completed steps
   * @param input - Immutable workflow input (stored on first save only)
   */
  save(transactionId: string, state: StepContext[], input?: any): Promise<void>;

  /**
   * Load workflow state.
   *
   * @param transactionId - Unique transaction identifier
   * @returns Step stack if exists, null otherwise
   */
  load(transactionId: string): Promise<StepContext[] | null>;

  /**
   * Clear workflow state (on successful completion).
   *
   * @param transactionId - Unique transaction identifier
   */
  clear(transactionId: string): Promise<void>;

  // === Workflow Status Operations ===

  /**
   * Update workflow status.
   * Required for dead_letter transitions and completion tracking.
   *
   * @param transactionId - Unique transaction identifier
   * @param status - New workflow status
   * @param error - Error context if status is failed or dead_letter
   */
  updateStatus(
    transactionId: string,
    status: WorkflowStatus,
    error?: WorkflowError
  ): Promise<void>;

  /**
   * Get full workflow record.
   *
   * @param transactionId - Unique transaction identifier
   * @returns Full workflow record or null
   */
  getWorkflow(transactionId: string): Promise<WorkflowRecord | null>;

  // === Query Operations (READ-ONLY) ===

  /**
   * Query workflows by filter.
   * This is READ-ONLY. No mutation methods.
   *
   * @param filter - Query filter
   * @returns Matching workflows with pagination info
   */
  query(filter: WorkflowFilter): Promise<WorkflowQueryResult>;

  /**
   * Count workflows by status.
   * Useful for monitoring dashboards.
   *
   * @param status - Status to count (or array of statuses)
   * @returns Count of matching workflows
   */
  countByStatus(status: WorkflowStatus | WorkflowStatus[]): Promise<number>;

  // === Admin Operations (CLI Only) ===

  /**
   * Atomic retry operation for dead_letter recovery.
   * This should use an atomic UPDATE ... WHERE status = 'dead_letter'
   * to prevent race conditions.
   *
   * @param transactionId - Transaction to retry
   * @returns New retry count, or null if not in dead_letter state
   */
  atomicRetry(transactionId: string): Promise<number | null>;
}

// Re-export types for convenience
export type {
  StepContext,
  WorkflowStatus,
  WorkflowRecord,
  WorkflowFilter,
  WorkflowQueryResult,
  WorkflowError,
} from './types/WorkflowState';
