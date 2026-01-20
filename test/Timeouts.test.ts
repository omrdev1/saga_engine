/**
 * Saga Engine - Step Timeout Tests
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { createEventSpy } from '../internal/testing/EventSpy';

describe('Step Timeouts', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  test('should timeout a step that exceeds timeout duration', async () => {
    const eventSpy = createEventSpy();

    const tx = new Transaction('timeout-test-1', storage, {
      idempotencyKey: 'timeout-test-1-key',
      lock,
      events: eventSpy.events
    });

    await expect(
      tx.run(async (t) => {
        await t.step('slow-step', {
          idempotencyKey: 's1',
          execute: async () => {
            // Simulate slow operation
            await new Promise(resolve => setTimeout(resolve, 200));
            return 'should-not-reach';
          },
          compensate: async () => {},
          timeout: 50 // 50ms timeout
        });
      })
    ).rejects.toThrow(/timed out/i);

    // Verify timeout event was emitted
    expect(eventSpy.wasCalled('onStepTimeout')).toBe(true);
  });

  test('should complete successfully if step finishes before timeout', async () => {
    const tx = new Transaction('timeout-test-2', storage, {
      idempotencyKey: 'timeout-test-2-key',
      lock,
    });

    let result: string | undefined;

    await tx.run(async (t) => {
      result = await t.step('fast-step', {
        idempotencyKey: 's1',
        execute: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'success';
        },
        compensate: async () => {},
        timeout: 100 // 100ms timeout
      });
    });

    expect(result).toBe('success');
  });

  test('should work with retry policy and timeout', async () => {
    const tx = new Transaction('timeout-test-3', storage, {
      idempotencyKey: 'timeout-test-3-key',
      lock,
    });

    let attempts = 0;

    await tx.run(async (t) => {
      const result = await t.step('retry-with-timeout', {
        idempotencyKey: 's1',
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Exceeds timeout
            return 'should-timeout';
          }
          return 'success'; // Fast on 3rd attempt
        },
        compensate: async () => {},
        timeout: 50,
        retry: {
          attempts: 3,
          backoffMs: 10
        }
      });

      expect(result).toBe('success');
    });

    expect(attempts).toBe(3); // Should have retried after timeouts
  });

  test('should rollback after timeout and emit compensation events', async () => {
    const eventSpy = createEventSpy();
    let compensateCalled = false;

    const tx = new Transaction('timeout-test-4', storage, {
      idempotencyKey: 'timeout-test-4-key',
      lock,
      events: eventSpy.events
    });

    try {
      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: async () => 'result-1',
          compensate: async () => {
            compensateCalled = true;
          }
        });

        await t.step('step-2-timeout', {
          idempotencyKey: 's2',
          execute: async () => {
            await new Promise(resolve => setTimeout(resolve, 200));
            return 'should-not-complete';
          },
          compensate: async () => {},
          timeout: 50
        });
      });
    } catch {
      // Expected to timeout
    }

    // Verify rollback happened
    expect(compensateCalled).toBe(true);
    expect(eventSpy.wasCalled('onCompensationComplete')).toBe(true);
  });

  test('should handle synchronous functions with timeout', async () => {
    const tx = new Transaction('timeout-test-5', storage, {
      idempotencyKey: 'timeout-test-5-key',
      lock,
    });

    let result: string | undefined;

    await tx.run(async (t) => {
      result = await t.step('sync-step', {
        idempotencyKey: 's1',
        execute: () => 'immediate-result', // Synchronous
        compensate: () => {},
        timeout: 100
      });
    });

    expect(result).toBe('immediate-result');
  });
});
