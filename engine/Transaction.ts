/**
 * Saga Engine - Transaction Engine
 *
 * Crash-resilient, Postgres-backed Saga executor with:
 * - 15-minute wall-clock execution limit
 * - Required idempotency keys (Transaction + Step level)
 * - Best-effort compensation (not "undo")
 * - Terminal dead_letter state on compensation failure
 */

import { StorageAdapter } from './Storage';
import { LockAdapter, NoOpLock, TransactionLockedError } from './Lock';
import { TransactionEvents, emitEvent } from './Events';
import {
  StepContext,
  WorkflowError,
  MAX_EXECUTION_MS,
  createWorkflowError,
} from './types/WorkflowState';
import {
  ExecutionTimeoutError,
  IdempotencyRequiredError,
  CompensationFailedError,
  StepTimeoutError,
} from './types/Errors';

// Re-export StepContext for convenience
export type { StepContext };

/**
 * Retry policy configuration
 */
export type RetryPolicy = {
  /** Number of retry attempts (default: 1 = no retry) */
  attempts: number;
  /** Backoff between retries in ms (default: 0) */
  backoffMs?: number;
};

/**
 * Compensation policy for step rollback
 */
export type CompensationPolicy = {
  /** Retry config for compensation */
  retry?: RetryPolicy;
  /** Timeout for compensation step in ms */
  timeout?: number;
};

/**
 * Step definition with required idempotency key
 *
 * API Change from v1: `undo` is now `compensate`
 * - "compensate" = attempt to reverse side effects (best-effort)
 * - NOT "undo" (implies guaranteed reversal)
 * - NOT "rollback" (implies atomicity)
 */
export type StepDefinition<T> = {
  /** Idempotency key for this step (REQUIRED) */
  idempotencyKey: string;
  /** Execute function */
  execute: () => Promise<T> | T;
  /** Compensation function (best-effort reversal) */
  compensate: (result: T) => Promise<void> | void;
  /** Retry policy for execute */
  retry?: RetryPolicy;
  /** Timeout for execute in ms */
  timeout?: number;
  /** Compensation policy */
  compensationPolicy?: CompensationPolicy;
};

/**
 * Recorded step with compensation function
 */
type RecordedStep = {
  name: string;
  idempotencyKey: string;
  compensate: () => Promise<void> | void;
  compensationPolicy?: CompensationPolicy;
};

/**
 * Transaction options
 */
export type TransactionOptions = {
  /** Idempotency key for this transaction (REQUIRED) */
  idempotencyKey: string;
  /** Workflow input data (stored for debugging/replay) */
  input?: any;
  /** Whether to mark as completed on success (default: true) */
  cleanupOnSuccess?: boolean;
  /** Lock adapter (default: NoOpLock) */
  lock?: LockAdapter;
  /** Lock TTL in ms (default: 30000) */
  lockTTL?: number;
  /** Event hooks for observability */
  events?: TransactionEvents;
};

/**
 * Saga Transaction Engine
 *
 * The core orchestration class for executing multi-step workflows with
 * crash recovery and best-effort compensation.
 *
 * @example
 * ```typescript
 * const tx = new Transaction('order-123', storage, {
 *   idempotencyKey: 'order-123',
 *   input: { orderId: '123', amount: 100 },
 * });
 *
 * await tx.run(async (t) => {
 *   const reservation = await t.step('reserve-inventory', {
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
export class Transaction {
  private stepStack: RecordedStep[] = [];
  private history: Map<string, any> = new Map();
  private id: string;
  private storage: StorageAdapter;
  private cleanupOnSuccess: boolean;
  private idempotencyKey: string;
  private input: any;

  // Locking
  private lock: LockAdapter;
  private lockTTL: number;

  // Events
  private events?: TransactionEvents;

  // Timing
  private startTime?: number;
  private deadline?: number;

  constructor(id: string, storage: StorageAdapter, options: TransactionOptions) {
    // Validate required idempotency key
    if (!options.idempotencyKey) {
      throw new IdempotencyRequiredError('transaction', id);
    }

    this.id = id;
    this.storage = storage;
    this.idempotencyKey = options.idempotencyKey;
    this.input = options.input ?? {};
    this.cleanupOnSuccess = options.cleanupOnSuccess ?? true;
    this.events = options.events;

    // Default to NoOpLock
    this.lock = options.lock ?? new NoOpLock();
    this.lockTTL = options.lockTTL ?? 30000;
  }

  /**
   * Execute the workflow with automatic compensation on failure.
   *
   * GUARANTEES:
   * - Steps persist before proceeding (Postgres atomic)
   * - Compensation triggered on failure (reverse order)
   * - Resumption skips completed steps
   * - 15-minute wall-clock limit enforced
   *
   * DOES NOT GUARANTEE:
   * - Compensation success (best-effort)
   * - External consistency (use idempotency keys)
   * - Atomicity (we're a saga, not XA)
   */
  async run(workflow: (tx: Transaction) => Promise<void>): Promise<void> {
    // Track execution time
    this.startTime = Date.now();
    this.deadline = this.startTime + MAX_EXECUTION_MS;

    // Emit transaction start event
    emitEvent(this.events, 'onTransactionStart', this.id);

    // 1. Acquire Lock
    const lockToken = await this.lock.acquire(this.id, this.lockTTL);

    if (!lockToken) {
      throw new TransactionLockedError(this.id);
    }

    try {
      // 2. Load previous state (for resumption)
      const savedState = await this.storage.load(this.id);
      if (savedState) {
        // Check if we're past deadline (including downtime)
        const workflow = await this.storage.getWorkflow(this.id);
        if (workflow && workflow.createdAt) {
          const elapsed = Date.now() - workflow.createdAt.getTime();
          if (elapsed > MAX_EXECUTION_MS) {
            // Past deadline - move to dead_letter
            await this.transitionToDeadLetter(
              new ExecutionTimeoutError(this.id, MAX_EXECUTION_MS, elapsed),
              'timeout-check'
            );
            throw new ExecutionTimeoutError(this.id, MAX_EXECUTION_MS, elapsed);
          }
        }

        // Resume from saved state
        savedState.forEach(s => this.history.set(s.name, s.result));
      }

      // 3. Execute Workflow
      try {
        await workflow(this);

        // Emit transaction complete event
        const duration = Date.now() - this.startTime;
        emitEvent(this.events, 'onTransactionComplete', this.id, duration);

        // 4. Mark as completed on success
        if (this.cleanupOnSuccess) {
          await this.storage.clear(this.id);
        }
      } catch (error) {
        // Emit transaction failed event
        emitEvent(this.events, 'onTransactionFailed', this.id, error as Error);

        // 5. Compensate on failure
        await this.compensateAll(error as Error);
        throw error;
      }

    } finally {
      // 6. ALWAYS Release Lock
      await this.lock.release(this.id, lockToken);
    }
  }

  /**
   * Execute a step with idempotency, retry, timeout, and compensation.
   *
   * @param name - Unique step name within this transaction
   * @param definition - Step definition with required idempotencyKey
   */
  async step<T>(name: string, definition: StepDefinition<T>): Promise<T> {
    // Validate required idempotency key
    if (!definition.idempotencyKey) {
      throw new IdempotencyRequiredError('step', this.id, name);
    }

    // Check wall-clock deadline BEFORE each step
    this.checkDeadline();

    // 1. Check Resumability (skip if already completed)
    if (this.history.has(name)) {
      const result = this.history.get(name) as T;

      // Emit step skipped event
      emitEvent(this.events, 'onStepSkipped', name, result);

      // Re-register compensation for this step
      this.stepStack.push({
        name,
        idempotencyKey: definition.idempotencyKey,
        compensate: () => definition.compensate(result),
        compensationPolicy: definition.compensationPolicy,
      });

      return result;
    }

    // Track step duration
    const stepStartTime = Date.now();

    // Emit step start event
    emitEvent(this.events, 'onStepStart', name, this.id);

    // 2. Execute with Retry and Timeout
    const result = await this.executeWithRetry(name, definition);

    // Emit step complete event
    const stepDuration = Date.now() - stepStartTime;
    emitEvent(this.events, 'onStepComplete', name, result, stepDuration);

    // 3. Store result in history for future steps to reference
    this.history.set(name, result);

    // 4. Register compensation
    this.stepStack.push({
      name,
      idempotencyKey: definition.idempotencyKey,
      compensate: () => definition.compensate(result),
      compensationPolicy: definition.compensationPolicy,
    });

    // 5. Persist state ATOMICALLY before returning
    const currentHistory: StepContext[] = this.stepStack.map(s => ({
      name: s.name,
      idempotencyKey: s.idempotencyKey,
      result: this.history.get(s.name),
      status: 'completed' as const,
    }));

    await this.storage.save(this.id, currentHistory, this.input);

    return result;
  }

  /**
   * Check if wall-clock deadline has been exceeded.
   * Called BEFORE each step.
   */
  private checkDeadline(): void {
    if (!this.deadline) return;

    const now = Date.now();
    if (now > this.deadline) {
      const elapsed = now - (this.startTime || now);
      throw new ExecutionTimeoutError(this.id, MAX_EXECUTION_MS, elapsed);
    }
  }

  /**
   * Execute step with retry policy and timeout
   */
  private async executeWithRetry<T>(name: string, def: StepDefinition<T>): Promise<T> {
    const attempts = def.retry?.attempts || 1;
    const backoff = def.retry?.backoffMs || 0;

    for (let i = 1; i <= attempts; i++) {
      try {
        // Check deadline before each attempt
        this.checkDeadline();

        // Execute the function
        const resultOrPromise = def.execute();

        // Wrap with timeout if specified
        if (def.timeout) {
          return await this.withTimeout(Promise.resolve(resultOrPromise), def.timeout, name);
        } else {
          return await resultOrPromise;
        }
      } catch (err) {
        const error = err as Error;

        // Emit step failed event
        emitEvent(this.events, 'onStepFailed', name, error, i);

        if (i < attempts) {
          // Emit step retry event
          emitEvent(this.events, 'onStepRetry', name, i, attempts);

          if (backoff > 0) {
            await new Promise(r => setTimeout(r, backoff));
          }
        } else {
          throw err; // Final failure
        }
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Timeout wrapper using Promise.race
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, stepName: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => {
          // Emit timeout event
          emitEvent(this.events, 'onStepTimeout', stepName, timeoutMs);
          reject(new StepTimeoutError(this.id, stepName, timeoutMs));
        }, timeoutMs)
      )
    ]);
  }

  /**
   * Compensate all completed steps in reverse order.
   *
   * This is BEST-EFFORT:
   * - Compensation may fail
   * - If compensation fails, workflow moves to dead_letter state
   * - dead_letter is TERMINAL - requires CLI recovery
   */
  private async compensateAll(originalError: Error): Promise<void> {
    const stepsToCompensate = [...this.stepStack].reverse();

    for (const step of stepsToCompensate) {
      const compensationStartTime = Date.now();

      // Emit compensation start event
      emitEvent(this.events, 'onCompensationStart', step.name, this.id);

      try {
        // Execute compensation with policy (retry/timeout)
        await this.executeCompensation(step);

        // Emit compensation complete event
        const compensationDuration = Date.now() - compensationStartTime;
        emitEvent(this.events, 'onCompensationComplete', step.name, compensationDuration);

      } catch (compensationError) {
        // Emit compensation failed event
        emitEvent(this.events, 'onCompensationFailed', step.name, compensationError as Error);

        // Compensation failed - move to dead_letter
        // DO NOT remove step from step_stack (preserves evidence)
        await this.transitionToDeadLetter(originalError, step.name, compensationError as Error);

        // Throw to stop further compensation and signal failure
        throw new CompensationFailedError(
          this.id,
          step.name,
          originalError,
          compensationError as Error
        );
      }
    }

    // All compensation succeeded - mark as failed (not dead_letter)
    await this.storage.updateStatus(
      this.id,
      'failed',
      createWorkflowError(stepsToCompensate[0]?.name || 'unknown', originalError)
    );

    this.stepStack = [];
  }

  /**
   * Execute compensation with retry policy and timeout
   */
  private async executeCompensation(step: RecordedStep): Promise<void> {
    const policy = step.compensationPolicy;
    const attempts = policy?.retry?.attempts || 1;
    const backoff = policy?.retry?.backoffMs || 0;
    const timeout = policy?.timeout;

    for (let i = 1; i <= attempts; i++) {
      try {
        const compensatePromise = Promise.resolve(step.compensate());

        if (timeout) {
          await this.withTimeout(compensatePromise, timeout, `compensate:${step.name}`);
        } else {
          await compensatePromise;
        }

        return; // Success
      } catch (err) {
        if (i < attempts) {
          if (backoff > 0) {
            await new Promise(r => setTimeout(r, backoff));
          }
        } else {
          throw err; // Final failure
        }
      }
    }
  }

  /**
   * Transition workflow to dead_letter state.
   *
   * dead_letter is TERMINAL:
   * - No API methods can resume it
   * - Requires saga-admin CLI for recovery
   * - Step stack is preserved (evidence)
   */
  private async transitionToDeadLetter(
    originalError: Error,
    stepName: string,
    compensationError?: Error
  ): Promise<void> {
    const workflowError = createWorkflowError(stepName, originalError, compensationError);

    await this.storage.updateStatus(this.id, 'dead_letter', workflowError);

    // Emit dead letter event
    emitEvent(this.events, 'onDeadLetter', this.id, workflowError);
  }

  // === Public Accessors ===

  /** Get transaction ID */
  getId(): string {
    return this.id;
  }

  /** Get idempotency key */
  getIdempotencyKey(): string {
    return this.idempotencyKey;
  }

  /** Get elapsed time in ms */
  getElapsedMs(): number {
    return this.startTime ? Date.now() - this.startTime : 0;
  }

  /** Get remaining time before deadline in ms */
  getRemainingMs(): number {
    return this.deadline ? Math.max(0, this.deadline - Date.now()) : MAX_EXECUTION_MS;
  }
}
