/**
 * Saga Engine - Retry Policy Tests
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';

describe('Retry Policy', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  test('should retry failed steps up to limit', async () => {
    const tx = new Transaction('tx-retry', storage, {
      idempotencyKey: 'tx-retry-key',
      lock,
    });

    const riskyAction = jest.fn();

    // Make it fail twice, then succeed
    riskyAction
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValue('Success');

    await tx.run(async (t) => {
      await t.step('flaky-step', {
        idempotencyKey: 's1',
        execute: riskyAction,
        compensate: async () => {},
        retry: { attempts: 3, backoffMs: 10 } // Fast backoff for test
      });
    });

    // Should have been called 3 times total
    expect(riskyAction).toHaveBeenCalledTimes(3);
  });

  test('should fail if retries exhausted', async () => {
    const tx = new Transaction('tx-exhaust', storage, {
      idempotencyKey: 'tx-exhaust-key',
      lock,
    });

    const alwaysFails = jest.fn().mockRejectedValue(new Error('Forever Broken'));

    await expect(tx.run(async (t) => {
      await t.step('broken', {
        idempotencyKey: 's1',
        execute: alwaysFails,
        compensate: async () => {},
        retry: { attempts: 2, backoffMs: 10 }
      });
    })).rejects.toThrow('Forever Broken');

    // Should have tried exactly 2 times
    expect(alwaysFails).toHaveBeenCalledTimes(2);
  });

  test('should apply fixed backoff between retries', async () => {
    const tx = new Transaction('tx-backoff', storage, {
      idempotencyKey: 'tx-backoff-key',
      lock,
    });

    const timestamps: number[] = [];
    let attempts = 0;

    await tx.run(async (t) => {
      await t.step('backoff-step', {
        idempotencyKey: 's1',
        execute: async () => {
          timestamps.push(Date.now());
          attempts++;
          if (attempts < 3) {
            throw new Error('Retry');
          }
          return 'success';
        },
        compensate: async () => {},
        retry: { attempts: 3, backoffMs: 50 }
      });
    });

    expect(attempts).toBe(3);

    // Check that backoff was applied (at least ~50ms between attempts)
    if (timestamps.length >= 3) {
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];
      // Both delays should be approximately the configured backoffMs
      expect(delay1).toBeGreaterThanOrEqual(45); // Allow some variance
      expect(delay2).toBeGreaterThanOrEqual(45);
    }
  });
});
