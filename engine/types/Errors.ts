/**
 * Saga Engine - Typed Errors
 *
 * All errors are explicitly typed and provide actionable context.
 * These errors are designed to fail fast and provide clear remediation paths.
 */

/**
 * Base error class for all Saga Engine errors
 */
export abstract class SagaError extends Error {
  public readonly code: string;
  public readonly transactionId?: string;

  constructor(code: string, message: string, transactionId?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.transactionId = transactionId;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Thrown when a transaction exceeds the 15-minute wall-clock limit.
 *
 * This is a hard limit that includes downtime. If your process crashes
 * and restarts after 20 minutes, this error will be thrown immediately.
 *
 * Remediation: Use Temporal for long-running workflows.
 */
export class ExecutionTimeoutError extends SagaError {
  public readonly deadlineMs: number;
  public readonly elapsedMs: number;

  constructor(transactionId: string, deadlineMs: number, elapsedMs: number) {
    super(
      'EXECUTION_TIMEOUT',
      `Transaction '${transactionId}' exceeded 15-minute wall-clock limit. ` +
      `Elapsed: ${Math.round(elapsedMs / 1000)}s. Workflow moved to dead_letter state.`,
      transactionId
    );
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when idempotency key is missing at Transaction or Step level.
 *
 * Idempotency is REQUIRED. This is not optional.
 *
 * Remediation: Provide idempotencyKey in Transaction constructor and every step.
 */
export class IdempotencyRequiredError extends SagaError {
  public readonly location: 'transaction' | 'step';
  public readonly stepName?: string;

  constructor(location: 'transaction' | 'step', transactionId?: string, stepName?: string) {
    const msg = location === 'transaction'
      ? `Transaction '${transactionId || 'unknown'}' requires idempotencyKey in options. ` +
        `Example: new Transaction('id', storage, { idempotencyKey: 'order-123' })`
      : `Step '${stepName}' requires idempotencyKey. ` +
        `Example: tx.step('name', { idempotencyKey: 'step-key', execute: ..., compensate: ... })`;

    super('IDEMPOTENCY_REQUIRED', msg, transactionId);
    this.location = location;
    this.stepName = stepName;
  }
}

/**
 * Thrown when attempting to use unsafe storage in production context.
 *
 * FileStorage and MemoryStorage are NOT safe for production.
 * They are only available via 'saga-engine/testing' import.
 *
 * Remediation: Use PostgresStorage for production.
 */
export class UnsafeStorageError extends SagaError {
  public readonly storageType: string;

  constructor(storageType: string) {
    super(
      'UNSAFE_STORAGE',
      `${storageType} is not safe for production use. ` +
      `Use PostgresStorage instead. ` +
      `For testing, import from 'saga-engine/testing'.`,
    );
    this.storageType = storageType;
  }
}

/**
 * Thrown when attempting to run a transaction that is already locked.
 *
 * This uses Postgres advisory locks with SHA-256 hashing.
 * Only one worker can execute a transaction at a time.
 *
 * Remediation: Wait for the other worker to complete, or check for stale locks.
 */
export class TransactionLockedError extends SagaError {
  constructor(transactionId: string) {
    super(
      'TRANSACTION_LOCKED',
      `Transaction '${transactionId}' is currently running elsewhere. ` +
      `Only one worker can execute a transaction at a time.`,
      transactionId
    );
  }
}

/**
 * Thrown when compensation fails and transaction enters dead_letter state.
 *
 * This is a terminal state. The transaction CANNOT be resumed via API.
 * Manual intervention is required via saga-admin CLI.
 *
 * Remediation: Use `npx saga-admin retry <txId>` after fixing the root cause.
 */
export class CompensationFailedError extends SagaError {
  public readonly failedStep: string;
  public readonly originalError: Error;
  public readonly compensationError: Error;

  constructor(
    transactionId: string,
    failedStep: string,
    originalError: Error,
    compensationError: Error
  ) {
    super(
      'COMPENSATION_FAILED',
      `Transaction '${transactionId}' compensation failed at step '${failedStep}'. ` +
      `Original error: ${originalError.message}. ` +
      `Compensation error: ${compensationError.message}. ` +
      `Transaction moved to dead_letter state. Use saga-admin CLI to retry.`,
      transactionId
    );
    this.failedStep = failedStep;
    this.originalError = originalError;
    this.compensationError = compensationError;
  }
}

/**
 * Thrown when retry cap (10 attempts) is exceeded for dead_letter recovery.
 *
 * This is a safety cap to prevent infinite retry loops.
 *
 * Remediation: Use `npx saga-admin retry --force <txId>` to override.
 */
export class RetryCapExceededError extends SagaError {
  public readonly retryCount: number;
  public readonly maxRetries: number;

  constructor(transactionId: string, retryCount: number, maxRetries: number = 10) {
    super(
      'RETRY_CAP_EXCEEDED',
      `Transaction '${transactionId}' has been retried ${retryCount} times (max: ${maxRetries}). ` +
      `Use --force flag to override: npx saga-admin retry --force ${transactionId}`,
      transactionId
    );
    this.retryCount = retryCount;
    this.maxRetries = maxRetries;
  }
}

/**
 * Thrown when transaction is in dead_letter state and cannot proceed.
 *
 * dead_letter is a TERMINAL state. No API methods can resume it.
 *
 * Remediation: Use saga-admin CLI for recovery operations.
 */
export class DeadLetterError extends SagaError {
  constructor(transactionId: string) {
    super(
      'DEAD_LETTER',
      `Transaction '${transactionId}' is in dead_letter state and cannot be resumed via API. ` +
      `Use saga-admin CLI: npx saga-admin retry ${transactionId}`,
      transactionId
    );
  }
}

/**
 * Thrown when step execution fails after all retry attempts.
 */
export class StepExecutionError extends SagaError {
  public readonly stepName: string;
  public readonly attempt: number;
  public readonly maxAttempts: number;
  public readonly cause: Error;

  constructor(
    transactionId: string,
    stepName: string,
    attempt: number,
    maxAttempts: number,
    cause: Error
  ) {
    super(
      'STEP_EXECUTION_FAILED',
      `Step '${stepName}' failed after ${attempt}/${maxAttempts} attempts: ${cause.message}`,
      transactionId
    );
    this.stepName = stepName;
    this.attempt = attempt;
    this.maxAttempts = maxAttempts;
    this.cause = cause;
  }
}

/**
 * Thrown when step times out.
 */
export class StepTimeoutError extends SagaError {
  public readonly stepName: string;
  public readonly timeoutMs: number;

  constructor(transactionId: string, stepName: string, timeoutMs: number) {
    super(
      'STEP_TIMEOUT',
      `Step '${stepName}' timed out after ${timeoutMs}ms`,
      transactionId
    );
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}
