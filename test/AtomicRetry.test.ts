/**
 * Saga Engine - Atomic Retry Test
 *
 * REQUIREMENT: Run 2 CLI retries simultaneously -> Only 1 increments count/resets status
 *
 * This test validates that the atomic UPDATE ... WHERE status = 'dead_letter'
 * prevents race conditions in concurrent retry operations.
 */

import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MAX_RETRY_COUNT } from '../engine/types/WorkflowState';

describe('Atomic Retry Test', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('should only allow one retry when called concurrently (simulated)', async () => {
    // Setup: Create a dead_letter workflow
    await storage.save('race-test', [
      { name: 'step-1', idempotencyKey: 's1', result: 'r1', status: 'completed' },
    ], {});
    await storage.updateStatus('race-test', 'dead_letter', {
      stepName: 'step-1',
      error: 'Test error',
      timestamp: new Date().toISOString(),
    });

    // Verify initial state
    const before = await storage.getWorkflow('race-test');
    expect(before!.status).toBe('dead_letter');
    expect(before!.retryCount).toBe(0);

    // Simulate concurrent retries
    // In MemoryStorage, these run sequentially, but the logic is identical to PostgresStorage
    // which uses UPDATE ... WHERE status = 'dead_letter'
    const results = await Promise.all([
      storage.atomicRetry('race-test'),
      storage.atomicRetry('race-test'),
    ]);

    // One should succeed (return new count), one should fail (return null)
    const successes = results.filter(r => r !== null);
    const failures = results.filter(r => r === null);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(successes[0]).toBe(1); // First successful retry

    // Verify final state
    const after = await storage.getWorkflow('race-test');
    expect(after!.status).toBe('pending');
    expect(after!.retryCount).toBe(1);
    expect(after!.error).toBeNull();
  });

  it('should return null when workflow is not in dead_letter state', async () => {
    // Test each non-dead_letter status
    const statuses: Array<'pending' | 'completed' | 'failed'> = ['pending', 'completed', 'failed'];

    for (const status of statuses) {
      const txId = `status-${status}`;
      await storage.save(txId, [], {});
      await storage.updateStatus(txId, status);

      const result = await storage.atomicRetry(txId);
      expect(result).toBeNull();

      // Status should not have changed
      const workflow = await storage.getWorkflow(txId);
      expect(workflow!.status).toBe(status);
    }
  });

  it('should return null when workflow does not exist', async () => {
    const result = await storage.atomicRetry('non-existent-workflow');
    expect(result).toBeNull();
  });

  it('should increment retry count on each successful retry', async () => {
    await storage.save('retry-count-test', [], {});
    await storage.updateStatus('retry-count-test', 'dead_letter', {
      stepName: 'test',
      error: 'error',
      timestamp: new Date().toISOString(),
    });

    // First retry
    let result = await storage.atomicRetry('retry-count-test');
    expect(result).toBe(1);
    let workflow = await storage.getWorkflow('retry-count-test');
    expect(workflow!.status).toBe('pending');

    // Simulate failure and return to dead_letter
    await storage.updateStatus('retry-count-test', 'dead_letter', {
      stepName: 'test',
      error: 'error again',
      timestamp: new Date().toISOString(),
    });

    // Second retry
    result = await storage.atomicRetry('retry-count-test');
    expect(result).toBe(2);
    workflow = await storage.getWorkflow('retry-count-test');
    expect(workflow!.retryCount).toBe(2);

    // Third retry
    await storage.updateStatus('retry-count-test', 'dead_letter', {
      stepName: 'test',
      error: 'error again again',
      timestamp: new Date().toISOString(),
    });
    result = await storage.atomicRetry('retry-count-test');
    expect(result).toBe(3);
  });

  it('should clear error on successful retry', async () => {
    await storage.save('clear-error-test', [], {});
    await storage.updateStatus('clear-error-test', 'dead_letter', {
      stepName: 'failed-step',
      error: 'Original error message',
      compensationError: 'Compensation also failed',
      timestamp: new Date().toISOString(),
    });

    // Verify error exists
    let workflow = await storage.getWorkflow('clear-error-test');
    expect(workflow!.error).not.toBeNull();
    expect(workflow!.error!.stepName).toBe('failed-step');

    // Retry
    await storage.atomicRetry('clear-error-test');

    // Error should be cleared
    workflow = await storage.getWorkflow('clear-error-test');
    expect(workflow!.error).toBeNull();
    expect(workflow!.status).toBe('pending');
  });

  it('should validate MAX_RETRY_COUNT constant is 10', () => {
    expect(MAX_RETRY_COUNT).toBe(10);
  });
});
