/**
 * Saga Engine - Event Hooks Tests
 */

import { Transaction } from '../engine/Transaction';
import { MemoryStorage } from '../internal/testing/MemoryStorage';
import { MockLock } from '../internal/testing/MockLock';
import { createEventSpy } from '../internal/testing/EventSpy';

describe('Event Hooks', () => {
  let storage: MemoryStorage;
  let lock: MockLock;

  beforeEach(() => {
    storage = new MemoryStorage();
    lock = new MockLock();
  });

  test('should emit step lifecycle events', async () => {
    const eventSpy = createEventSpy();

    const tx = new Transaction('event-test-1', storage, {
      idempotencyKey: 'event-test-1-key',
      lock,
      events: eventSpy.events
    });

    await tx.run(async (t) => {
      await t.step('step-1', {
        idempotencyKey: 's1',
        execute: async () => 'result-1',
        compensate: async () => {}
      });
    });

    // Verify events were called
    expect(eventSpy.wasCalled('onTransactionStart')).toBe(true);
    expect(eventSpy.wasCalled('onStepStart')).toBe(true);
    expect(eventSpy.wasCalled('onStepComplete')).toBe(true);
    expect(eventSpy.wasCalled('onTransactionComplete')).toBe(true);
  });

  test('should emit failure and compensation events', async () => {
    const eventSpy = createEventSpy();

    const tx = new Transaction('event-test-2', storage, {
      idempotencyKey: 'event-test-2-key',
      lock,
      events: eventSpy.events
    });

    try {
      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: async () => 'result-1',
          compensate: async () => {}
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: async () => {
            throw new Error('Simulated failure');
          },
          compensate: async () => {}
        });
      });
    } catch {
      // Expected to fail
    }

    // Verify failure events
    expect(eventSpy.wasCalled('onStepFailed')).toBe(true);
    expect(eventSpy.wasCalled('onTransactionFailed')).toBe(true);
    expect(eventSpy.wasCalled('onCompensationStart')).toBe(true);
    expect(eventSpy.wasCalled('onCompensationComplete')).toBe(true);
  });

  test('should emit retry events', async () => {
    const eventSpy = createEventSpy();

    const tx = new Transaction('event-test-3', storage, {
      idempotencyKey: 'event-test-3-key',
      lock,
      events: eventSpy.events
    });

    let attempts = 0;

    await tx.run(async (t) => {
      await t.step('flaky-step', {
        idempotencyKey: 's1',
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Temporary failure');
          }
          return 'success';
        },
        compensate: async () => {},
        retry: {
          attempts: 3,
          backoffMs: 10
        }
      });
    });

    // Verify retry events
    expect(eventSpy.wasCalled('onStepRetry')).toBe(true);
    expect(eventSpy.getCallCount('onStepRetry')).toBe(2); // Failed 2 times before success

    // Verify final success
    expect(eventSpy.wasCalled('onStepComplete')).toBe(true);
  });

  test('should emit skip event for resumed steps', async () => {
    // First run: complete step-1
    await storage.save('event-test-4', [
      { name: 'step-1', idempotencyKey: 's1', result: 'result-1', status: 'completed' }
    ], {});

    const eventSpy = createEventSpy();

    // Second run: should skip step-1
    const tx = new Transaction('event-test-4', storage, {
      idempotencyKey: 'event-test-4-key',
      lock,
      events: eventSpy.events
    });

    await tx.run(async (t) => {
      await t.step('step-1', {
        idempotencyKey: 's1',
        execute: async () => 'result-1',
        compensate: async () => {}
      });
    });

    // Verify skip event
    expect(eventSpy.wasCalled('onStepSkipped')).toBe(true);
  });

  test('should emit compensation failed event when compensate throws', async () => {
    const eventSpy = createEventSpy();

    const tx = new Transaction('event-test-5', storage, {
      idempotencyKey: 'event-test-5-key',
      lock,
      events: eventSpy.events
    });

    try {
      await tx.run(async (t) => {
        await t.step('step-1', {
          idempotencyKey: 's1',
          execute: async () => 'result-1',
          compensate: async () => {
            throw new Error('Compensation failed!');
          }
        });

        await t.step('step-2', {
          idempotencyKey: 's2',
          execute: async () => {
            throw new Error('Step 2 failed');
          },
          compensate: async () => {}
        });
      });
    } catch {
      // Expected to fail
    }

    // Verify compensation failed event
    expect(eventSpy.wasCalled('onCompensationFailed')).toBe(true);

    // Verify dead letter event (compensation failed = dead letter)
    expect(eventSpy.wasCalled('onDeadLetter')).toBe(true);
  });
});
