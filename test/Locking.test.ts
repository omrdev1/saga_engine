/**
 * Saga Engine - Locking Tests
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { TransactionLockedError } from '../engine/Lock';

describe('Concurrency Control', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  test('should execute normally when lock is free', async () => {
    const tx = new Transaction('tx-1', storage, {
      idempotencyKey: 'tx-1-key',
      lock
    });

    const step = jest.fn().mockResolvedValue('result');

    await tx.run(async (t) => {
      await t.step('step-1', {
        idempotencyKey: 's1',
        execute: step,
        compensate: async () => {}
      });
    });

    expect(step).toHaveBeenCalled();
  });

  test('should throw TransactionLockedError if ID is already locked', async () => {
    // Pre-acquire the lock
    await lock.acquire('tx-race', 10000);

    const tx = new Transaction('tx-race', storage, {
      idempotencyKey: 'tx-race-key',
      lock
    });

    await expect(tx.run(async () => {}))
      .rejects
      .toThrow(TransactionLockedError);
  });

  test('should release lock even after a failure', async () => {
    const tx = new Transaction('tx-crash', storage, {
      idempotencyKey: 'tx-crash-key',
      lock
    });

    try {
      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => { throw new Error('Crash!'); },
          compensate: () => {}
        });
      });
    } catch {
      // expected
    }

    // Lock should be released, so we can acquire it again
    expect(lock.isLocked('tx-crash')).toBe(false);
  });

  test('should prevent concurrent execution of same transaction', async () => {
    const results: string[] = [];

    const runWorkflow = async (id: string) => {
      const tx = new Transaction('shared-tx', storage, {
        idempotencyKey: 'shared-tx-key',
        lock
      });

      try {
        await tx.run(async (t) => {
          await t.step('step-1', {
            idempotencyKey: 's1',
            execute: async () => {
              await new Promise(resolve => setTimeout(resolve, 50));
              results.push(id);
              return id;
            },
            compensate: () => {}
          });
        });
      } catch (error) {
        if (error instanceof TransactionLockedError) {
          results.push(`${id}-locked`);
        } else {
          throw error;
        }
      }
    };

    // Run two workflows concurrently
    await Promise.all([
      runWorkflow('worker-1'),
      runWorkflow('worker-2')
    ]);

    // One should succeed, one should be locked
    expect(results).toHaveLength(2);
    expect(results.filter(r => r.includes('locked'))).toHaveLength(1);
    expect(results.filter(r => !r.includes('locked'))).toHaveLength(1);
  });
});
