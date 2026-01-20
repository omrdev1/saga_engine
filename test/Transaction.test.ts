/**
 * Saga Engine - Transaction Tests
 *
 * Tests for core transaction functionality including:
 * - Step execution
 * - Compensation on failure
 * - Resumability
 * - Idempotency enforcement
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { IdempotencyRequiredError } from '../engine/types/Errors';

describe('Transaction Engine', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  describe('Basic Execution', () => {
    test('should execute all steps successfully', async () => {
      const tx = new Transaction('tx-success', storage, {
        idempotencyKey: 'tx-success-key',
        lock,
      });

      const step1Execute = jest.fn().mockResolvedValue('step1-result');
      const step2Execute = jest.fn().mockResolvedValue('step2-result');

      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: step1Execute,
          compensate: async () => {}
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: step2Execute,
          compensate: async () => {}
        });
      });

      expect(step1Execute).toHaveBeenCalled();
      expect(step2Execute).toHaveBeenCalled();

      // Workflow should be completed
      const workflow = await storage.getWorkflow('tx-success');
      expect(workflow?.status).toBe('completed');
    });

    test('should capture step results in workflow', async () => {
      const tx = new Transaction('tx-return', storage, {
        idempotencyKey: 'tx-return-key',
        lock,
      });

      let r1: string | undefined;
      let r2: string | undefined;

      await tx.run(async (t) => {
        r1 = await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => 'result-1',
          compensate: () => {}
        });

        r2 = await t.step('step-2', {
          idempotencyKey: 's2',
          execute: () => 'result-2',
          compensate: () => {}
        });
      });

      expect(r1).toBe('result-1');
      expect(r2).toBe('result-2');
    });
  });

  describe('Compensation', () => {
    test('should compensate in reverse order on failure', async () => {
      const tx = new Transaction('tx-fail', storage, {
        idempotencyKey: 'tx-fail-key',
        lock,
      });

      const compensationOrder: string[] = [];

      const step1Execute = jest.fn().mockResolvedValue('res-1');
      const step1Compensate = jest.fn().mockImplementation(() => {
        compensationOrder.push('step-1');
      });

      const step2Execute = jest.fn().mockResolvedValue('res-2');
      const step2Compensate = jest.fn().mockImplementation(() => {
        compensationOrder.push('step-2');
      });

      const step3Execute = jest.fn().mockRejectedValue(new Error('Boom!'));

      await expect(tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: step1Execute,
          compensate: step1Compensate
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: step2Execute,
          compensate: step2Compensate
        });

        await t.step('step-3', {
          idempotencyKey: 's3',
          execute: step3Execute,
          compensate: () => {}
        });
      })).rejects.toThrow('Boom!');

      // Compensation should be in reverse order
      expect(compensationOrder).toEqual(['step-2', 'step-1']);
    });

    test('should not compensate failed step', async () => {
      const tx = new Transaction('tx-no-comp-failed', storage, {
        idempotencyKey: 'tx-no-comp-failed-key',
        lock,
      });

      const step2Compensate = jest.fn();

      await expect(tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => 'res-1',
          compensate: () => {}
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: () => { throw new Error('Failed'); },
          compensate: step2Compensate
        });
      })).rejects.toThrow('Failed');

      // Step 2 failed during execution, so it should NOT be compensated
      expect(step2Compensate).not.toHaveBeenCalled();
    });
  });

  describe('Resumability', () => {
    test('should skip previously completed steps', async () => {
      // Simulate existing state: Step 1 is already done
      await storage.save('tx-resume', [
        { name: 'step-1', idempotencyKey: 's1', result: 'cached-result', status: 'completed' }
      ], {});

      const tx = new Transaction('tx-resume', storage, {
        idempotencyKey: 'tx-resume-key',
        lock,
      });

      const step1Execute = jest.fn();
      const step2Execute = jest.fn().mockResolvedValue('fresh');

      await tx.run(async (t) => {
        const r1 = await t.step('step-1', {
          idempotencyKey: 's1',
          execute: step1Execute,
          compensate: () => {}
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: step2Execute,
          compensate: () => {}
        });

        // Should return cached result
        expect(r1).toBe('cached-result');
      });

      expect(step1Execute).not.toHaveBeenCalled(); // Skipped!
      expect(step2Execute).toHaveBeenCalled();     // Ran!
    });
  });

  describe('Idempotency Enforcement', () => {
    test('should throw IdempotencyRequiredError if transaction idempotencyKey missing', () => {
      expect(() => {
        new Transaction('tx-no-key', storage, {
          lock,
        } as any);
      }).toThrow(IdempotencyRequiredError);
    });

    test('should throw IdempotencyRequiredError if step idempotencyKey missing', async () => {
      const tx = new Transaction('tx-step-no-key', storage, {
        idempotencyKey: 'tx-step-no-key-key',
        lock,
      });

      await expect(tx.run(async (t) => {
        await t.step('step-1', {
          execute: () => 'result',
          compensate: () => {},
        } as any);
      })).rejects.toThrow(IdempotencyRequiredError);
    });
  });

  describe('Locking', () => {
    test('should release lock after successful completion', async () => {
      const tx = new Transaction('tx-lock-success', storage, {
        idempotencyKey: 'tx-lock-success-key',
        lock,
      });

      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: () => 'result',
          compensate: () => {}
        });
      });

      // Lock should be released
      expect(lock.isLocked('tx-lock-success')).toBe(false);
    });

    test('should release lock after failure', async () => {
      const tx = new Transaction('tx-lock-fail', storage, {
        idempotencyKey: 'tx-lock-fail-key',
        lock,
      });

      try {
        await tx.run(async (t) => {
          await t.step('step-1', {
            idempotencyKey: 's1',
            execute: () => { throw new Error('Fail'); },
            compensate: () => {}
          });
        });
      } catch {
        // Expected
      }

      // Lock should still be released
      expect(lock.isLocked('tx-lock-fail')).toBe(false);
    });
  });
});
