/**
 * Saga Engine - Event Spy (TESTING ONLY)
 *
 * Utilities for tracking and verifying event emissions in tests.
 */

import { TransactionEvents } from '../../engine/Events';

/**
 * Spy for tracking event calls in tests
 */
export class EventSpy {
  public calls: Map<string, any[][]> = new Map();

  /**
   * Create a spy for a specific event
   */
  spy(eventName: string) {
    return (...args: any[]) => {
      if (!this.calls.has(eventName)) {
        this.calls.set(eventName, []);
      }
      this.calls.get(eventName)!.push(args);
    };
  }

  /**
   * Get all calls for a specific event
   */
  getCalls(eventName: string): any[][] {
    return this.calls.get(eventName) || [];
  }

  /**
   * Check if an event was called
   */
  wasCalled(eventName: string): boolean {
    return this.calls.has(eventName) && this.calls.get(eventName)!.length > 0;
  }

  /**
   * Get the number of times an event was called
   */
  getCallCount(eventName: string): number {
    return this.calls.get(eventName)?.length || 0;
  }

  /**
   * Get the last call arguments for an event
   */
  getLastCall(eventName: string): any[] | undefined {
    const calls = this.calls.get(eventName);
    return calls ? calls[calls.length - 1] : undefined;
  }

  /**
   * Clear all recorded calls
   */
  clear(): void {
    this.calls.clear();
  }
}

/**
 * Create a spy object for all transaction events
 *
 * @example
 * ```typescript
 * const eventSpy = createEventSpy();
 * const tx = new Transaction('test-123', storage, {
 *   events: eventSpy.events
 * });
 *
 * await tx.run(async (t) => {
 *   await t.step('step-1', {
 *     idempotencyKey: 'key-1',
 *     execute: async () => 'result',
 *     compensate: async () => {}
 *   });
 * });
 *
 * expect(eventSpy.wasCalled('onStepComplete')).toBe(true);
 * expect(eventSpy.getCallCount('onStepStart')).toBe(1);
 * ```
 */
export function createEventSpy() {
  const spy = new EventSpy();

  return {
    events: {
      onTransactionStart: spy.spy('onTransactionStart'),
      onTransactionComplete: spy.spy('onTransactionComplete'),
      onTransactionFailed: spy.spy('onTransactionFailed'),
      onStepStart: spy.spy('onStepStart'),
      onStepComplete: spy.spy('onStepComplete'),
      onStepFailed: spy.spy('onStepFailed'),
      onStepRetry: spy.spy('onStepRetry'),
      onStepSkipped: spy.spy('onStepSkipped'),
      onCompensationStart: spy.spy('onCompensationStart'),
      onCompensationComplete: spy.spy('onCompensationComplete'),
      onCompensationFailed: spy.spy('onCompensationFailed'),
      onStepTimeout: spy.spy('onStepTimeout'),
      onDeadLetter: spy.spy('onDeadLetter'),
    } as TransactionEvents,
    wasCalled: (eventName: string) => spy.wasCalled(eventName),
    getCallCount: (eventName: string) => spy.getCallCount(eventName),
    getCalls: (eventName: string) => spy.getCalls(eventName),
    getLastCall: (eventName: string) => spy.getLastCall(eventName),
    clear: () => spy.clear(),
  };
}
