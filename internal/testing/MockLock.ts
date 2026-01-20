/**
 * Saga Engine - Mock Lock (TESTING ONLY)
 *
 * Simulates distributed locking behavior for unit tests.
 */

import { LockAdapter } from '../../engine/Lock';

/**
 * Mock lock implementation for testing.
 *
 * Simulates distributed locking behavior without requiring Postgres.
 * Tracks active locks and prevents concurrent acquisition.
 *
 * @internal This class is only available via 'saga-engine/testing'
 */
export class MockLock implements LockAdapter {
  private locks = new Map<string, string>();

  /**
   * Acquire a lock for a transaction ID
   * @returns A lock token if successful, null if already locked
   */
  async acquire(transactionId: string, ttlMs: number): Promise<string | null> {
    if (this.locks.has(transactionId)) {
      return null; // Already locked
    }
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.locks.set(transactionId, token);
    return token;
  }

  /**
   * Release a lock for a transaction ID
   */
  async release(transactionId: string, token: string): Promise<void> {
    const storedToken = this.locks.get(transactionId);
    if (storedToken === token) {
      this.locks.delete(transactionId);
    }
  }

  // === Testing Utilities ===

  /**
   * Check if a transaction is currently locked
   */
  isLocked(transactionId: string): boolean {
    return this.locks.has(transactionId);
  }

  /**
   * Get all active locks
   */
  getActiveLocks(): string[] {
    return Array.from(this.locks.keys());
  }

  /**
   * Force release a lock (for testing error scenarios)
   */
  forceRelease(transactionId: string): void {
    this.locks.delete(transactionId);
  }

  /**
   * Clear all locks
   */
  clearAll(): void {
    this.locks.clear();
  }
}
