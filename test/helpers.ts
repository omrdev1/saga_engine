/**
 * Saga Engine - Test Helpers (Backward Compatibility)
 *
 * This file re-exports from the new internal/testing module
 * to maintain backward compatibility with existing tests.
 *
 * For new tests, import directly from 'saga-engine/testing':
 *   import { MemoryStorage, MockLock } from 'saga-engine/testing';
 */

export { MemoryStorage } from '../internal/testing/MemoryStorage';
export { MockLock } from '../internal/testing/MockLock';
export { createEventSpy, EventSpy } from '../internal/testing/EventSpy';

// Legacy type export for backward compatibility
export interface DryRunResult {
  steps: string[];
  estimatedDuration: number;
  transactionId: string;
}
