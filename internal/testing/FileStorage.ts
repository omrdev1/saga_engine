/**
 * Saga Engine - File Storage (TESTING ONLY)
 *
 * WARNING: This storage adapter is NOT safe for production use.
 * It provides NO durability guarantees and is intended for local development only.
 *
 * For production, use PostgresStorage.
 */

import fs from 'fs/promises';
import path from 'path';
import { StorageAdapter } from '../../engine/Storage';
import {
  StepContext,
  WorkflowStatus,
  WorkflowRecord,
  WorkflowFilter,
  WorkflowQueryResult,
  WorkflowError,
} from '../../engine/types/WorkflowState';

/**
 * File-based storage adapter for local development and testing.
 *
 * NOT SAFE FOR PRODUCTION:
 * - No durability guarantees
 * - No atomic operations
 * - Data can be corrupted on crash
 * - No concurrency safety
 *
 * @internal This class is only available via 'saga-engine/testing'
 */
export class FileStorage implements StorageAdapter {
  /**
   * This storage is NOT safe for production use.
   */
  readonly isProductionSafe = false as const;

  private dir: string;
  private workflows = new Map<string, WorkflowRecord>();

  constructor(directory?: string) {
    this.dir = directory || path.join(process.cwd(), '.transaction-logs');
  }

  private async init(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {
      // Directory exists
    }
  }

  private getFilePath(txId: string): string {
    return path.join(this.dir, `${txId}.json`);
  }

  async save(transactionId: string, state: StepContext[], input?: any): Promise<void> {
    await this.init();

    // Load existing or create new
    let workflow = this.workflows.get(transactionId);
    if (!workflow) {
      workflow = {
        id: transactionId,
        status: 'pending',
        stepStack: [],
        input: input || {},
        retryCount: 0,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    workflow.stepStack = state;
    workflow.updatedAt = new Date();
    this.workflows.set(transactionId, workflow);

    await fs.writeFile(
      this.getFilePath(transactionId),
      JSON.stringify(workflow, null, 2)
    );
  }

  async load(transactionId: string): Promise<StepContext[] | null> {
    try {
      const data = await fs.readFile(this.getFilePath(transactionId), 'utf-8');
      const workflow = JSON.parse(data) as WorkflowRecord;
      this.workflows.set(transactionId, workflow);
      return workflow.stepStack;
    } catch {
      return null;
    }
  }

  async clear(transactionId: string): Promise<void> {
    this.workflows.delete(transactionId);
    try {
      await fs.unlink(this.getFilePath(transactionId));
    } catch {
      // File doesn't exist
    }
  }

  async updateStatus(
    transactionId: string,
    status: WorkflowStatus,
    error?: WorkflowError
  ): Promise<void> {
    await this.init();

    let workflow = this.workflows.get(transactionId);
    if (!workflow) {
      // Try to load from disk
      await this.load(transactionId);
      workflow = this.workflows.get(transactionId);
    }

    if (!workflow) {
      workflow = {
        id: transactionId,
        status,
        stepStack: [],
        input: {},
        retryCount: 0,
        error: error || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } else {
      workflow.status = status;
      workflow.error = error || null;
      workflow.updatedAt = new Date();
    }

    this.workflows.set(transactionId, workflow);
    await fs.writeFile(
      this.getFilePath(transactionId),
      JSON.stringify(workflow, null, 2)
    );
  }

  async getWorkflow(transactionId: string): Promise<WorkflowRecord | null> {
    const cached = this.workflows.get(transactionId);
    if (cached) return cached;

    try {
      const data = await fs.readFile(this.getFilePath(transactionId), 'utf-8');
      const workflow = JSON.parse(data) as WorkflowRecord;
      workflow.createdAt = new Date(workflow.createdAt);
      workflow.updatedAt = new Date(workflow.updatedAt);
      this.workflows.set(transactionId, workflow);
      return workflow;
    } catch {
      return null;
    }
  }

  async query(filter: WorkflowFilter): Promise<WorkflowQueryResult> {
    // Load all files
    await this.init();
    const files = await fs.readdir(this.dir);
    const workflows: WorkflowRecord[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const txId = file.replace('.json', '');
      const workflow = await this.getWorkflow(txId);
      if (workflow) workflows.push(workflow);
    }

    // Apply filters
    let filtered = workflows;

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      filtered = filtered.filter(w => statuses.includes(w.status));
    }

    if (filter.createdAfter) {
      filtered = filtered.filter(w => w.createdAt >= filter.createdAfter!);
    }

    if (filter.createdBefore) {
      filtered = filtered.filter(w => w.createdAt <= filter.createdBefore!);
    }

    const total = filtered.length;

    // Apply pagination
    const offset = filter.offset || 0;
    const limit = filter.limit || 100;
    filtered = filtered.slice(offset, offset + limit);

    return { workflows: filtered, total };
  }

  async countByStatus(status: WorkflowStatus | WorkflowStatus[]): Promise<number> {
    const result = await this.query({ status });
    return result.total;
  }

  async atomicRetry(transactionId: string): Promise<number | null> {
    const workflow = await this.getWorkflow(transactionId);
    if (!workflow || workflow.status !== 'dead_letter') {
      return null;
    }

    workflow.status = 'pending';
    workflow.retryCount += 1;
    workflow.error = null;
    workflow.updatedAt = new Date();

    this.workflows.set(transactionId, workflow);
    await fs.writeFile(
      this.getFilePath(transactionId),
      JSON.stringify(workflow, null, 2)
    );

    return workflow.retryCount;
  }
}
