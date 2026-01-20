/**
 * Saga Engine - Workflow State Types
 *
 * These types define the workflow lifecycle and persistence model.
 */

/**
 * Workflow status enum - these are the ONLY valid states.
 *
 * State transitions:
 *   pending -> completed (success)
 *   pending -> failed (step failed, compensation succeeded)
 *   pending -> dead_letter (step failed, compensation failed OR timeout)
 *
 * TERMINAL states: completed, failed, dead_letter
 * dead_letter has NO API recovery path - use saga-admin CLI only.
 */
export type WorkflowStatus = 'pending' | 'completed' | 'failed' | 'dead_letter';

/**
 * Step execution context - what gets persisted to step_stack
 */
export interface StepContext<T = any> {
  /** Step name (unique within transaction) */
  name: string;
  /** Step idempotency key */
  idempotencyKey: string;
  /** Result of step execution (if completed) */
  result?: T;
  /** Step status */
  status: 'completed' | 'pending';
}

/**
 * Error context stored in the error column
 * Truncated to 2KB for data hygiene
 */
export interface WorkflowError {
  /** Step that caused the failure */
  stepName: string;
  /** Original execution error (truncated) */
  error: string;
  /** Compensation error if compensation also failed (truncated) */
  compensationError?: string;
  /** ISO timestamp of when error occurred */
  timestamp: string;
}

/**
 * Full workflow record as stored in Postgres
 */
export interface WorkflowRecord {
  /** Transaction ID (primary key) */
  id: string;
  /** Current workflow status */
  status: WorkflowStatus;
  /** Array of completed steps with results */
  stepStack: StepContext[];
  /** Immutable original input (for replay/debugging) */
  input: any;
  /** Number of retry attempts from dead_letter (safety cap: 10) */
  retryCount: number;
  /** Error context if status is failed or dead_letter */
  error: WorkflowError | null;
  /** When workflow was created */
  createdAt: Date;
  /** When workflow was last updated */
  updatedAt: Date;
}

/**
 * Query filter for listing workflows
 * All queries are READ-ONLY. No mutation methods.
 */
export interface WorkflowFilter {
  /** Filter by status */
  status?: WorkflowStatus | WorkflowStatus[];
  /** Filter by creation date (after) */
  createdAfter?: Date;
  /** Filter by creation date (before) */
  createdBefore?: Date;
  /** Filter by update date (after) */
  updatedAfter?: Date;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Query result with pagination info
 */
export interface WorkflowQueryResult {
  /** Matching workflows */
  workflows: WorkflowRecord[];
  /** Total count (before limit/offset) */
  total: number;
}

/**
 * Constants
 */
export const MAX_EXECUTION_MS = 15 * 60 * 1000; // 15 minutes wall-clock
export const MAX_ERROR_LENGTH = 2048; // 2KB error truncation
export const MAX_RETRY_COUNT = 10; // Safety cap for dead_letter retries

/**
 * Truncate error message to 2KB for data hygiene
 */
const TRUNCATION_MARKER = '... [TRUNCATED]';

export function truncateError(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;
  if (message.length <= MAX_ERROR_LENGTH) {
    return message;
  }
  return message.slice(0, MAX_ERROR_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Create a WorkflowError object with proper truncation
 */
export function createWorkflowError(
  stepName: string,
  error: Error,
  compensationError?: Error
): WorkflowError {
  return {
    stepName,
    error: truncateError(error),
    compensationError: compensationError ? truncateError(compensationError) : undefined,
    timestamp: new Date().toISOString(),
  };
}
