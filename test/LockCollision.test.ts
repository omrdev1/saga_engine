/**
 * Saga Engine - Lock Collision Test
 *
 * REQUIREMENT: Generate 50,000 UUIDs -> Hash to BigInt -> Assert 0 collisions
 *
 * This test validates that our SHA-256 -> 64-bit BigInt truncation
 * does not produce collisions in practical usage scenarios.
 *
 * Mathematical expectation:
 * - 64-bit keyspace = 2^64 = ~18 quintillion possible values
 * - Birthday paradox collision probability for 50k items: ~6.8e-11 (negligible)
 * - If this test fails, something is fundamentally broken
 */

import { createHash } from 'crypto';
import { randomUUID } from 'crypto';

/**
 * Hash function identical to PostgresLock.hashToLockKey()
 */
function hashToLockKey(transactionId: string): bigint {
  const hash = createHash('sha256').update(transactionId).digest();
  return hash.readBigInt64BE(0);
}

describe('Lock Collision Test', () => {
  it('should produce 0 collisions for 50,000 unique UUIDs', () => {
    const SAMPLE_SIZE = 50_000;
    const seen = new Set<string>();
    const collisions: Array<{ uuid1: string; uuid2: string; hash: string }> = [];

    // Map to track which UUID produced each hash (for collision reporting)
    const hashToUuid = new Map<string, string>();

    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const uuid = randomUUID();
      const lockKey = hashToLockKey(uuid);
      const keyStr = lockKey.toString();

      if (seen.has(keyStr)) {
        // Collision detected!
        const previousUuid = hashToUuid.get(keyStr)!;
        collisions.push({
          uuid1: previousUuid,
          uuid2: uuid,
          hash: keyStr,
        });
      } else {
        seen.add(keyStr);
        hashToUuid.set(keyStr, uuid);
      }
    }

    // Report any collisions found
    if (collisions.length > 0) {
      console.error('COLLISIONS DETECTED:');
      collisions.forEach((c, i) => {
        console.error(`  ${i + 1}. UUID1: ${c.uuid1}`);
        console.error(`     UUID2: ${c.uuid2}`);
        console.error(`     Hash:  ${c.hash}`);
      });
    }

    // Assert zero collisions
    expect(collisions).toHaveLength(0);
    expect(seen.size).toBe(SAMPLE_SIZE);
  });

  it('should produce deterministic hashes for the same input', () => {
    const testCases = [
      'order-123',
      'workflow-abc-def',
      'a'.repeat(1000), // Long string
      '', // Empty string
      '🎉', // Unicode
    ];

    for (const input of testCases) {
      const hash1 = hashToLockKey(input);
      const hash2 = hashToLockKey(input);
      expect(hash1).toBe(hash2);
    }
  });

  it('should produce different hashes for different inputs', () => {
    const inputs = ['order-1', 'order-2', 'order-3', 'workflow-a', 'workflow-b'];
    const hashes = inputs.map(hashToLockKey);
    const uniqueHashes = new Set(hashes.map(h => h.toString()));

    expect(uniqueHashes.size).toBe(inputs.length);
  });

  it('should handle edge cases without throwing', () => {
    const edgeCases = [
      '', // Empty
      ' ', // Whitespace
      '\n\t\r', // Control characters
      'null',
      'undefined',
      '0',
      '-1',
      String.fromCharCode(0), // Null character
      '\u0000\u0001\u0002', // Low unicode
      '𝕳𝖊𝖑𝖑𝖔', // Fancy unicode
    ];

    for (const input of edgeCases) {
      expect(() => hashToLockKey(input)).not.toThrow();
      const hash = hashToLockKey(input);
      expect(typeof hash).toBe('bigint');
    }
  });

  it('should produce hashes within valid Postgres bigint range', () => {
    // Postgres bigint range: -9223372036854775808 to 9223372036854775807
    const MIN_BIGINT = -9223372036854775808n;
    const MAX_BIGINT = 9223372036854775807n;

    for (let i = 0; i < 1000; i++) {
      const uuid = randomUUID();
      const hash = hashToLockKey(uuid);

      expect(hash).toBeGreaterThanOrEqual(MIN_BIGINT);
      expect(hash).toBeLessThanOrEqual(MAX_BIGINT);
    }
  });
});
