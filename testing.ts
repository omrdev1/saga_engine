/**
 * Saga Engine - Testing Utilities
 *
 * These utilities are for TESTING and DEVELOPMENT only.
 * DO NOT use in production.
 *
 * @example
 * ```typescript
 * import { MemoryStorage, MockLock, createEventSpy } from 'saga-engine/testing';
 *
 * const storage = new MemoryStorage();
 * const lock = new MockLock();
 * const eventSpy = createEventSpy();
 *
 * const tx = new Transaction('test-123', storage, {
 *   idempotencyKey: 'test-123',
 *   lock,
 *   events: eventSpy.events,
 * });
 * ```
 */

export { MemoryStorage } from './internal/testing/MemoryStorage';
export { FileStorage } from './internal/testing/FileStorage';
export { MockLock } from './internal/testing/MockLock';
export { createEventSpy, EventSpy } from './internal/testing/EventSpy';
