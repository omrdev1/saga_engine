/**
 * Saga Engine - Wall Clock Timeout Test
 *
 * REQUIREMENT: Mock Date.now() to jump forward 20 minutes in the middle of a workflow
 *
 * ASSERT:
 * - Immediate transition to dead_letter
 * - ExecutionTimeoutError thrown
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { createEventSpy } from '../internal/testing/EventSpy';
import { ExecutionTimeoutError } from '../engine/types/Errors';
import { MAX_EXECUTION_MS } from '../engine/types/WorkflowState';

describe('Wall Clock Timeout Test', () => {
  let storage: MemoryStorage;
  let lock: MockLock;
  let originalDateNow: () => number;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
    // Save original Date.now
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Restore original Date.now
    Date.now = originalDateNow;
  });

  it('should throw ExecutionTimeoutError when wall clock exceeds 15 minutes', async () => {
    const eventSpy = createEventSpy();
    const executionLog: string[] = [];

    // Start time
    let mockTime = 1700000000000; // Arbitrary start time
    Date.now = () => mockTime;

    const tx = new Transaction('timeout-test', storage, {
      idempotencyKey: 'timeout-test',
      input: { testId: 'wall-clock-timeout' },
      lock,
      events: eventSpy.events,
    });

    let caughtError: Error | undefined;

    try {
      await tx.run(async (t) => {
        // Step 1: Succeeds (time: 0 min)
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => {
            executionLog.push('step-1:execute');
            return 'result-1';
          },
          compensate: () => {
            executionLog.push('step-1:compensate');
          },
        });

        // Step 2: Succeeds (time: 5 min)
        mockTime += 5 * 60 * 1000; // Advance 5 minutes
        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: () => {
            executionLog.push('step-2:execute');
            return 'result-2';
          },
          compensate: () => {
            executionLog.push('step-2:compensate');
          },
        });

        // === TIME JUMP: +20 minutes (total: 25 min > 15 min limit) ===
        mockTime += 20 * 60 * 1000;

        // Step 3: Should fail BEFORE execution due to timeout check
        await t.step('step-3', {
          idempotencyKey: 's3',
          execute: () => {
            executionLog.push('step-3:execute'); // Should NOT be called
            return 'result-3';
          },
          compensate: () => {
            executionLog.push('step-3:compensate');
          },
        });
      });
    } catch (err) {
      caughtError = err as Error;
    }

    // === ASSERTIONS ===

    // 1. Should throw ExecutionTimeoutError
    expect(caughtError).toBeInstanceOf(ExecutionTimeoutError);
    const timeoutError = caughtError as ExecutionTimeoutError;
    expect(timeoutError.code).toBe('EXECUTION_TIMEOUT');
    expect(timeoutError.transactionId).toBe('timeout-test');
    expect(timeoutError.deadlineMs).toBe(MAX_EXECUTION_MS);
    expect(timeoutError.elapsedMs).toBeGreaterThan(MAX_EXECUTION_MS);

    // 2. Step 3 should NOT have executed (timeout check happens BEFORE step)
    expect(executionLog).toContain('step-1:execute');
    expect(executionLog).toContain('step-2:execute');
    expect(executionLog).not.toContain('step-3:execute');

    // 3. Compensation should have been triggered for completed steps
    // Note: compensation happens in reverse order
    expect(executionLog).toContain('step-2:compensate');
    expect(executionLog).toContain('step-1:compensate');

    // 4. Lock should be released
    expect(lock.isLocked('timeout-test')).toBe(false);

    // 5. Events should be emitted
    expect(eventSpy.wasCalled('onTransactionStart')).toBe(true);
    expect(eventSpy.wasCalled('onTransactionFailed')).toBe(true);
  });

  it('should check deadline on resume and fail immediately if past 15 minutes', async () => {
    // Simulate a workflow that was started, crashed, and is now resuming after 20 minutes

    // Step 1: Create a "crashed" workflow state
    const crashedTime = 1700000000000;
    await storage.save('resume-timeout-test', [
      { name: 'step-1', idempotencyKey: 's1', result: 'result-1', status: 'completed' },
    ], { testId: 'resume-timeout' });

    // Manually set the workflow's createdAt to the crashed time
    const workflowRecord = storage.getRaw('resume-timeout-test');
    if (workflowRecord) {
      workflowRecord.createdAt = new Date(crashedTime);
    }

    // Step 2: Resume 20 minutes later
    const resumeTime = crashedTime + 20 * 60 * 1000;
    Date.now = () => resumeTime;

    const tx = new Transaction('resume-timeout-test', storage, {
      idempotencyKey: 'resume-timeout-test',
      lock,
    });

    // Step 3: Attempt to run - should fail immediately on deadline check
    let caughtError: Error | undefined;
    try {
      await tx.run(async (t) => {
        // This step should never execute
        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: () => 'should-not-run',
          compensate: () => {},
        });
      });
    } catch (err) {
      caughtError = err as Error;
    }

    // Should fail with ExecutionTimeoutError
    expect(caughtError).toBeInstanceOf(ExecutionTimeoutError);

    // Should be in dead_letter state
    const workflow = await storage.getWorkflow('resume-timeout-test');
    expect(workflow!.status).toBe('dead_letter');
  });

  it('should succeed if workflow completes within 15 minutes', async () => {
    let mockTime = 1700000000000;
    Date.now = () => mockTime;

    const tx = new Transaction('within-limit', storage, {
      idempotencyKey: 'within-limit',
      lock,
    });

    await tx.run(async (t) => {
      await t.step('step-1', {
        idempotencyKey: 's1',
        execute: () => {
          mockTime += 5 * 60 * 1000; // 5 minutes
          return 'result-1';
        },
        compensate: () => {},
      });

      await t.step('step-2', {
        idempotencyKey: 's2',
        execute: () => {
          mockTime += 5 * 60 * 1000; // 10 minutes total
          return 'result-2';
        },
        compensate: () => {},
      });

      await t.step('step-3', {
        idempotencyKey: 's3',
        execute: () => {
          mockTime += 4 * 60 * 1000; // 14 minutes total (within limit)
          return 'result-3';
        },
        compensate: () => {},
      });
    });

    // Should succeed
    const workflow = await storage.getWorkflow('within-limit');
    expect(workflow!.status).toBe('completed');
  });

  it('should check deadline before each retry attempt', async () => {
    let mockTime = 1700000000000;
    Date.now = () => mockTime;
    let attempts = 0;

    const tx = new Transaction('retry-timeout', storage, {
      idempotencyKey: 'retry-timeout',
      lock,
    });

    let caughtError: Error | undefined;
    try {
      await tx.run(async (t) => {
        await t.step('flaky-step', {
          idempotencyKey: 'flaky',
          execute: () => {
            attempts++;
            // First attempt: advance time past deadline
            if (attempts === 1) {
              mockTime += 20 * 60 * 1000; // Jump 20 minutes
              throw new Error('First attempt failed');
            }
            return 'success';
          },
          compensate: () => {},
          retry: { attempts: 3, backoffMs: 10 },
        });
      });
    } catch (err) {
      caughtError = err as Error;
    }

    // Should fail with timeout on the second attempt's deadline check
    expect(caughtError).toBeInstanceOf(ExecutionTimeoutError);

    // Should have only attempted once before timeout was detected
    expect(attempts).toBe(1);
  });

  it('should validate MAX_EXECUTION_MS constant is 15 minutes', () => {
    expect(MAX_EXECUTION_MS).toBe(15 * 60 * 1000);
  });
});
