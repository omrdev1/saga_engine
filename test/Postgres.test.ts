/**
 * Saga Engine - PostgreSQL Storage Tests
 */

import { PostgresStorage } from '../engine/PostgresStorage';

describe('PostgresStorage', () => {
  describe('Constructor Validation', () => {
    test('should reject invalid table names (SQL injection prevention)', () => {
      const mockPool = {
        query: jest.fn(),
        end: jest.fn(),
      } as any;

      expect(() => new PostgresStorage(mockPool, 'DROP TABLE users;--'))
        .toThrow('Invalid table name');

      expect(() => new PostgresStorage(mockPool, '123invalid'))
        .toThrow('Invalid table name');

      expect(() => new PostgresStorage(mockPool, 'table with spaces'))
        .toThrow('Invalid table name');

      expect(() => new PostgresStorage(mockPool, 'table-with-dashes'))
        .toThrow('Invalid table name');
    });

    test('should accept valid table names', () => {
      const mockPool = {
        query: jest.fn(),
        end: jest.fn(),
      } as any;

      expect(() => new PostgresStorage(mockPool, 'valid_table_123'))
        .not.toThrow();

      expect(() => new PostgresStorage(mockPool, 'transactions'))
        .not.toThrow();

      expect(() => new PostgresStorage(mockPool, '_private_table'))
        .not.toThrow();
    });
  });

  describe('isProductionSafe', () => {
    test('should be marked as production safe', () => {
      const mockPool = {
        query: jest.fn(),
        end: jest.fn(),
      } as any;

      const storage = new PostgresStorage(mockPool);
      expect(storage.isProductionSafe).toBe(true);
    });
  });

  describe('Query Operations (mocked)', () => {
    let storage: PostgresStorage;
    let mockQuery: jest.Mock;
    let mockClientQuery: jest.Mock;
    let mockPool: any;

    beforeEach(() => {
      mockQuery = jest.fn();
      mockClientQuery = jest.fn();

      // Mock client for transaction operations
      const mockClient = {
        query: mockClientQuery,
        release: jest.fn(),
      };

      mockPool = {
        query: mockQuery,
        connect: jest.fn().mockResolvedValue(mockClient),
        end: jest.fn(),
      };
      storage = new PostgresStorage(mockPool);
    });

    test('save() should execute INSERT for new workflow', async () => {
      const steps = [{ name: 'step1', idempotencyKey: 's1', status: 'completed', result: 'r1' }];

      // First call is BEGIN, second is SELECT (check existing), third is INSERT, fourth is COMMIT
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT - no existing row
        .mockResolvedValueOnce({ rows: [] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await storage.save('tx-123', steps as any, { foo: 'bar' });

      // Verify INSERT was called (3rd call)
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO'),
        expect.arrayContaining(['tx-123'])
      );
    });

    test('load() should return parsed JSON stack', async () => {
      const mockStack = [{ name: 'step1', result: 'foo' }];
      mockQuery.mockResolvedValueOnce({ rows: [{ step_stack: mockStack }] });

      const result = await storage.load('tx-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['tx-123']
      );
      expect(result).toEqual(mockStack);
    });

    test('load() should return null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await storage.load('tx-999');
      expect(result).toBeNull();
    });

    test('getWorkflow() should return full workflow record', async () => {
      const mockWorkflow = {
        id: 'tx-123',
        status: 'completed',
        step_stack: [{ name: 'step1' }],
        input: { foo: 'bar' },
        retry_count: 0,
        error: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockWorkflow] });

      const result = await storage.getWorkflow('tx-123');

      expect(result).toBeDefined();
      expect(result?.status).toBe('completed');
    });

    test('atomicRetry() should return new count on success', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ retry_count: 1 }] });

      const result = await storage.atomicRetry('tx-123');

      expect(result).toBe(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'dead_letter'"),
        ['tx-123']
      );
    });

    test('atomicRetry() should return null if not in dead_letter', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await storage.atomicRetry('tx-123');

      expect(result).toBeNull();
    });
  });
});
