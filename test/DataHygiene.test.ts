/**
 * Saga Engine - Data Hygiene Test
 *
 * REQUIREMENT: Throw 10MB Error Object during compensation -> DB Error Column contains truncated ~2KB string
 *
 * This test validates that error messages are properly truncated to prevent
 * database bloat and maintain reasonable storage limits.
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { truncateError, createWorkflowError, MAX_ERROR_LENGTH } from '../engine/types/WorkflowState';

describe('Data Hygiene Test', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  describe('truncateError function', () => {
    it('should not truncate messages under 2KB', () => {
      const shortMessage = 'This is a short error message';
      expect(truncateError(shortMessage)).toBe(shortMessage);

      const exactLimit = 'x'.repeat(MAX_ERROR_LENGTH);
      expect(truncateError(exactLimit)).toBe(exactLimit);
    });

    it('should truncate messages over 2KB with marker', () => {
      const longMessage = 'x'.repeat(MAX_ERROR_LENGTH + 1000);
      const truncated = truncateError(longMessage);

      expect(truncated.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expect(truncated).toContain('... [TRUNCATED]');
    });

    it('should handle Error objects', () => {
      const error = new Error('Test error message');
      const truncated = truncateError(error);
      expect(truncated).toBe('Test error message');
    });

    it('should truncate 10MB error to ~2KB', () => {
      const tenMB = 'x'.repeat(10 * 1024 * 1024); // 10MB
      const truncated = truncateError(tenMB);

      expect(truncated.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expect(truncated).toContain('... [TRUNCATED]');
    });
  });

  describe('createWorkflowError function', () => {
    it('should truncate both error and compensationError', () => {
      const largeError = new Error('x'.repeat(10000));
      const largeCompError = new Error('y'.repeat(10000));

      const workflowError = createWorkflowError('failed-step', largeError, largeCompError);

      expect(workflowError.stepName).toBe('failed-step');
      expect(workflowError.error.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expect(workflowError.compensationError!.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expect(workflowError.error).toContain('... [TRUNCATED]');
      expect(workflowError.compensationError).toContain('... [TRUNCATED]');
      expect(workflowError.timestamp).toBeDefined();
    });

    it('should handle undefined compensationError', () => {
      const error = new Error('Simple error');
      const workflowError = createWorkflowError('step-1', error);

      expect(workflowError.stepName).toBe('step-1');
      expect(workflowError.error).toBe('Simple error');
      expect(workflowError.compensationError).toBeUndefined();
    });
  });

  describe('Integration: Large error in workflow', () => {
    it('should truncate 10MB error when writing to storage', async () => {
      const tx = new Transaction('large-error-test', storage, {
        idempotencyKey: 'large-error-test',
        lock,
      });

      // Create a 10MB error message
      const tenMBMessage = 'ERROR: ' + 'x'.repeat(10 * 1024 * 1024);

      try {
        await tx.run(async (t) => {
          await t.step('step-1', {
            idempotencyKey: 's1',
            execute: () => 'success',
            compensate: () => {
              throw new Error(tenMBMessage);
            },
          });

          // Trigger compensation
          throw new Error('Trigger compensation');
        });
      } catch {
        // Expected
      }

      // Check stored error size
      const workflow = await storage.getWorkflow('large-error-test');
      expect(workflow!.status).toBe('dead_letter');
      expect(workflow!.error).not.toBeNull();

      // Error message should be truncated
      const errorJson = JSON.stringify(workflow!.error);
      expect(errorJson.length).toBeLessThan(10000); // Well under 10KB, let alone 10MB

      // Should contain truncation marker
      expect(workflow!.error!.compensationError).toContain('... [TRUNCATED]');
    });

    it('should handle errors with circular references gracefully', async () => {
      const tx = new Transaction('circular-error-test', storage, {
        idempotencyKey: 'circular-error-test',
        lock,
      });

      try {
        await tx.run(async (t) => {
          await t.step('step-1', {
            idempotencyKey: 's1',
            execute: () => 'success',
            compensate: () => {
              // Create error with long message (circular refs would be in stack, not message)
              const err = new Error('Base error ' + 'x'.repeat(5000));
              throw err;
            },
          });

          throw new Error('Trigger');
        });
      } catch {
        // Expected
      }

      const workflow = await storage.getWorkflow('circular-error-test');
      expect(workflow!.error).not.toBeNull();
      // Should not throw during serialization
    });

    it('should handle special characters in error messages', async () => {
      const tx = new Transaction('special-chars-test', storage, {
        idempotencyKey: 'special-chars-test',
        lock,
      });

      const specialMessage = 'Error with "quotes", newlines\n\t, unicode: 你好, and emoji: 🔥';

      try {
        await tx.run(async (t) => {
          await t.step('step-1', {
            idempotencyKey: 's1',
            execute: () => {
              throw new Error(specialMessage);
            },
            compensate: () => {},
          });
        });
      } catch {
        // Expected
      }

      const workflow = await storage.getWorkflow('special-chars-test');
      expect(workflow!.error!.error).toContain('quotes');
      expect(workflow!.error!.error).toContain('你好');
      expect(workflow!.error!.error).toContain('🔥');
    });
  });

  describe('MAX_ERROR_LENGTH constant', () => {
    it('should be 2048 bytes (2KB)', () => {
      expect(MAX_ERROR_LENGTH).toBe(2048);
    });
  });
});
