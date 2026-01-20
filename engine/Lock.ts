/**
 * Saga Engine - Locking Primitives
 *
 * Provides distributed locking to ensure only one worker executes a transaction at a time.
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';

/**
 * Thrown when attempting to run a transaction that is already locked.
 */
export class TransactionLockedError extends Error {
  public readonly transactionId: string;

  constructor(transactionId: string) {
    super(`Transaction '${transactionId}' is currently running elsewhere.`);
    this.name = 'TransactionLockedError';
    this.transactionId = transactionId;
  }
}

/**
 * Lock adapter interface for distributed locking.
 */
export interface LockAdapter {
  /**
   * Attempts to acquire a lock for the given transaction ID.
   * @param id The transaction ID to lock
   * @param ttlMs How long (in ms) to hold the lock before auto-expiring (safety)
   * @returns A "lock token" if successful, or null if the lock is busy.
   */
  acquire(id: string, ttlMs: number): Promise<string | null>;

  /**
   * Releases the lock using the token received during acquire.
   * @param id The transaction ID
   * @param token The token received from acquire
   */
  release(id: string, token: string): Promise<void>;
}

/**
 * Default "No Operation" lock for single-process usage.
 * It never blocks. Use only for development/testing.
 */
export class NoOpLock implements LockAdapter {
  async acquire(id: string, ttlMs: number): Promise<string> {
    return 'noop-token';
  }

  async release(id: string, token: string): Promise<void> {
    // Do nothing
  }
}

/**
 * PostgreSQL Advisory Lock implementation using SHA-256 hashing.
 *
 * Uses pg_try_advisory_lock/pg_advisory_unlock with a 64-bit key derived
 * from SHA-256 hash of the transaction ID. This provides:
 *
 * - Zero collisions in practice (64-bit from SHA-256)
 * - Automatic release on connection close
 * - No separate lock table needed
 *
 * DISCLAIMER: This mechanism is a practical mutex for concurrency safety.
 * It is NOT an adversarially secure cryptographic primitive.
 *
 * @example
 * ```typescript
 * const lock = new PostgresLock(pool);
 * const tx = new Transaction('order-123', storage, { lock });
 * ```
 */
export class PostgresLock implements LockAdapter {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Convert transaction ID to 64-bit BigInt using SHA-256.
   *
   * Algorithm:
   * 1. SHA-256 hash of transaction ID (32 bytes)
   * 2. Take first 8 bytes
   * 3. Convert to signed 64-bit BigInt (Postgres advisory lock key format)
   *
   * This provides ~18 quintillion possible keys with uniform distribution.
   * Collision probability for 50k transactions: ~1.4e-10 (negligible).
   */
  private hashToLockKey(transactionId: string): bigint {
    const hash = createHash('sha256').update(transactionId).digest();
    // Read first 8 bytes as signed 64-bit BigInt (big-endian)
    // Postgres advisory locks use bigint (-9223372036854775808 to 9223372036854775807)
    return hash.readBigInt64BE(0);
  }

  async acquire(transactionId: string, ttlMs: number): Promise<string | null> {
    const lockKey = this.hashToLockKey(transactionId);

    // pg_try_advisory_lock returns true if lock acquired, false if already held
    const result = await this.pool.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockKey.toString()]
    );

    if (result.rows[0]?.acquired === true) {
      // Return the lock key as the token (needed for release)
      return lockKey.toString();
    }

    return null; // Lock already held
  }

  async release(transactionId: string, token: string): Promise<void> {
    // Token is the lock key
    const lockKey = BigInt(token);

    // pg_advisory_unlock returns true if lock was held and released
    await this.pool.query('SELECT pg_advisory_unlock($1)', [lockKey.toString()]);
  }

  /**
   * Check if a transaction is currently locked (for debugging).
   * Note: This is a point-in-time check and may be stale.
   */
  async isLocked(transactionId: string): Promise<boolean> {
    const lockKey = this.hashToLockKey(transactionId);

    // Query pg_locks to check if this advisory lock is held
    const result = await this.pool.query(
      `SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
       AND classid = ($1::bigint >> 32)::int
       AND objid = ($1::bigint & 4294967295)::int`,
      [lockKey.toString()]
    );

    return result.rows.length > 0;
  }
}
