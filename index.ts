/**
 * Saga Engine
 *
 * Crash-resilient, Postgres-backed Saga executor for Node.js.
 *
 * GUARANTEES:
 * - Step persistence before proceeding (Postgres atomic)
 * - Compensation triggered on failure (reverse order)
 * - Resumption skips completed steps
 * - 15-minute wall-clock limit enforced
 * - Idempotency keys required (Transaction + Step level)
 *
 * DOES NOT GUARANTEE:
 * - Compensation success (best-effort)
 * - External consistency (use idempotency keys with external APIs)
 * - Atomicity (we're a saga, not XA)
 * - Exactly-once delivery across process boundary
 *
 * PRODUCTION RULE: Only PostgresStorage is safe for production.
 * MemoryStorage and FileStorage are available via 'saga-engine/testing' only.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { Transaction, PostgresStorage, PostgresLock } from 'saga-engine';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const storage = new PostgresStorage(pool);
 * const lock = new PostgresLock(pool);
 *
 * const tx = new Transaction('order-123', storage, {
 *   idempotencyKey: 'order-123',
 *   input: { orderId: '123', amount: 100 },
 *   lock,
 * });
 *
 * await tx.run(async (t) => {
 *   await t.step('reserve-inventory', {
 *     idempotencyKey: 'order-123:reserve',
 *     execute: () => inventory.reserve(items),
 *     compensate: (r) => inventory.release(r.id),
 *   });
 *
 *   await t.step('charge-payment', {
 *     idempotencyKey: 'order-123:charge',
 *     execute: () => stripe.charge(amount, { idempotency_key: 'order-123:charge' }),
 *     compensate: (charge) => stripe.refund(charge.id),
 *   });
 * });
 * ```
 */

// === Core Engine ===
export { Transaction } from './engine/Transaction';
export type {
  StepContext,
  StepDefinition,
  RetryPolicy,
  CompensationPolicy,
  TransactionOptions,
} from './engine/Transaction';

// === Storage (Postgres ONLY for production) ===
export { StorageAdapter } from './engine/Storage';
export type {
  WorkflowStatus,
  WorkflowRecord,
  WorkflowFilter,
  WorkflowQueryResult,
  WorkflowError,
} from './engine/Storage';
export { PostgresStorage } from './engine/PostgresStorage';

// === Locking ===
export {
  LockAdapter,
  TransactionLockedError,
  NoOpLock,
  PostgresLock,
} from './engine/Lock';

// === Errors ===
export {
  SagaError,
  ExecutionTimeoutError,
  IdempotencyRequiredError,
  UnsafeStorageError,
  CompensationFailedError,
  RetryCapExceededError,
  DeadLetterError,
  StepExecutionError,
  StepTimeoutError,
} from './engine/types/Errors';

// === Events ===
export type { TransactionEvents } from './engine/Events';

// === Constants ===
export {
  MAX_EXECUTION_MS,
  MAX_ERROR_LENGTH,
  MAX_RETRY_COUNT,
} from './engine/types/WorkflowState';

// ============================================================================
// Testing utilities available via 'saga-engine/testing':
// - MemoryStorage, MockLock, FileStorage, createEventSpy
// ============================================================================
