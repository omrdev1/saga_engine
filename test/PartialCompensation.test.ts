/**
 * Saga Engine - Partial Compensation Test
 *
 * REQUIREMENT: Step 3 fails -> Step 2 compensates successfully -> Step 1 compensation throws
 *
 * ASSERT:
 * - Status is 'dead_letter'
 * - Error column contains the specific failure context
 * - step_stack is preserved (evidence of what ran)
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { createEventSpy } from '../internal/testing/EventSpy';
import { CompensationFailedError } from '../engine/types/Errors';

describe('Partial Compensation Test', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  it('should enter dead_letter when compensation fails, preserving step_stack', async () => {
    const executionLog: string[] = [];
    const compensationLog: string[] = [];
    const eventSpy = createEventSpy();

    const tx = new Transaction('partial-comp-test', storage, {
      idempotencyKey: 'partial-comp-test',
      input: { testId: 'partial-compensation' },
      lock,
      events: eventSpy.events,
    });

    // Define the workflow
    const workflow = async (t: Transaction) => {
      // Step 1: Will succeed, but compensation will FAIL
      await t.step('step-1-comp-fails', {
        idempotencyKey: 'step-1',
        execute: () => {
          executionLog.push('step-1:execute');
          return { id: 'result-1' };
        },
        compensate: () => {
          compensationLog.push('step-1:compensate');
          throw new Error('COMPENSATION_FAILURE: Step 1 compensation exploded');
        },
      });

      // Step 2: Will succeed, compensation will also succeed
      await t.step('step-2-comp-succeeds', {
        idempotencyKey: 'step-2',
        execute: () => {
          executionLog.push('step-2:execute');
          return { id: 'result-2' };
        },
        compensate: () => {
          compensationLog.push('step-2:compensate');
          // Success - no throw
        },
      });

      // Step 3: Will FAIL during execution
      await t.step('step-3-fails', {
        idempotencyKey: 'step-3',
        execute: () => {
          executionLog.push('step-3:execute');
          throw new Error('EXECUTION_FAILURE: Step 3 execution exploded');
        },
        compensate: () => {
          compensationLog.push('step-3:compensate');
          // This should never be called (step-3 never completed)
        },
      });
    };

    // Execute and expect CompensationFailedError
    let caughtError: Error | undefined;
    try {
      await tx.run(workflow);
    } catch (err) {
      caughtError = err as Error;
    }

    // === ASSERTIONS ===

    // 1. Error should be CompensationFailedError
    expect(caughtError).toBeInstanceOf(CompensationFailedError);
    const compError = caughtError as CompensationFailedError;
    expect(compError.failedStep).toBe('step-1-comp-fails');
    expect(compError.originalError.message).toContain('Step 3 execution exploded');
    expect(compError.compensationError.message).toContain('Step 1 compensation exploded');

    // 2. Execution order should be: step-1, step-2, step-3 (fails)
    expect(executionLog).toEqual([
      'step-1:execute',
      'step-2:execute',
      'step-3:execute',
    ]);

    // 3. Compensation order should be: step-2 (success), step-1 (fails)
    // Note: step-3 never completed, so it's not in compensation
    expect(compensationLog).toEqual([
      'step-2:compensate', // Succeeds
      'step-1:compensate', // Fails
    ]);

    // 4. Workflow should be in dead_letter state
    const workflow_record = await storage.getWorkflow('partial-comp-test');
    expect(workflow_record).not.toBeNull();
    expect(workflow_record!.status).toBe('dead_letter');

    // 5. Error column should contain specific failure context
    expect(workflow_record!.error).not.toBeNull();
    expect(workflow_record!.error!.stepName).toBe('step-1-comp-fails');
    expect(workflow_record!.error!.error).toContain('Step 3 execution exploded');
    expect(workflow_record!.error!.compensationError).toContain('Step 1 compensation exploded');
    expect(workflow_record!.error!.timestamp).toBeDefined();

    // 6. step_stack should be PRESERVED (evidence of what ran)
    expect(workflow_record!.stepStack).toHaveLength(2); // Only step-1 and step-2 completed
    expect(workflow_record!.stepStack[0].name).toBe('step-1-comp-fails');
    expect(workflow_record!.stepStack[0].result).toEqual({ id: 'result-1' });
    expect(workflow_record!.stepStack[1].name).toBe('step-2-comp-succeeds');
    expect(workflow_record!.stepStack[1].result).toEqual({ id: 'result-2' });

    // 7. Events should have been emitted correctly
    expect(eventSpy.wasCalled('onTransactionStart')).toBe(true);
    expect(eventSpy.wasCalled('onTransactionFailed')).toBe(true);
    expect(eventSpy.wasCalled('onCompensationStart')).toBe(true);
    expect(eventSpy.wasCalled('onCompensationComplete')).toBe(true); // step-2
    expect(eventSpy.wasCalled('onCompensationFailed')).toBe(true);  // step-1
    expect(eventSpy.wasCalled('onDeadLetter')).toBe(true);

    // 8. Lock should be released
    expect(lock.isLocked('partial-comp-test')).toBe(false);
  });

  it('should mark as failed (not dead_letter) when all compensations succeed', async () => {
    const tx = new Transaction('all-comp-succeed', storage, {
      idempotencyKey: 'all-comp-succeed',
      lock,
    });

    await expect(
      tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => 'result-1',
          compensate: () => {}, // Success
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: () => {
            throw new Error('Step 2 failed');
          },
          compensate: () => {}, // Never called
        });
      })
    ).rejects.toThrow('Step 2 failed');

    const workflow = await storage.getWorkflow('all-comp-succeed');
    expect(workflow!.status).toBe('failed'); // NOT dead_letter
    expect(workflow!.error).not.toBeNull();
    expect(workflow!.error!.stepName).toBe('step-1'); // Last compensated step
  });

  it('should handle compensation with retry policy before failing to dead_letter', async () => {
    let compensationAttempts = 0;

    const tx = new Transaction('retry-then-dead', storage, {
      idempotencyKey: 'retry-then-dead',
      lock,
    });

    await expect(
      tx.run(async (t) => {
        await t.step('step-with-retry-comp', {
          idempotencyKey: 's1',
          execute: () => 'result',
          compensate: () => {
            compensationAttempts++;
            throw new Error(`Compensation attempt ${compensationAttempts} failed`);
          },
          compensationPolicy: {
            retry: { attempts: 3, backoffMs: 10 },
          },
        });

        throw new Error('Trigger compensation');
      })
    ).rejects.toThrow();

    // Should have retried 3 times
    expect(compensationAttempts).toBe(3);

    // Should be in dead_letter
    const workflow = await storage.getWorkflow('retry-then-dead');
    expect(workflow!.status).toBe('dead_letter');
  });
});
