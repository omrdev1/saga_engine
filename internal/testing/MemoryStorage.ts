/**
 * Saga Engine - Memory Storage (TESTING ONLY)
 *
 * WARNING: This storage adapter is NOT safe for production use.
 * All data is lost when the process exits.
 *
 * For production, use PostgresStorage.
 */

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
 * In-memory storage adapter for unit testing.
 *
 * NOT SAFE FOR PRODUCTION:
 * - All data is lost on process restart
 * - No persistence whatsoever
 *
 * @internal This class is only available via 'saga-engine/testing'
 */
export class MemoryStorage implements StorageAdapter {
  /**
   * This storage is NOT safe for production use.
   */
  readonly isProductionSafe = false as const;

  private workflows = new Map<string, WorkflowRecord>();

  async save(transactionId: string, state: StepContext[], input?: any): Promise<void> {
    let workflow = this.workflows.get(transactionId);

    if (!workflow) {
      workflow = {
        id: transactionId,
        status: 'pending',
        stepStack: [],
        input: input !== undefined ? JSON.parse(JSON.stringify(input)) : {},
        retryCount: 0,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    // Deep clone to prevent mutations
    workflow.stepStack = JSON.parse(JSON.stringify(state));
    workflow.updatedAt = new Date();
    this.workflows.set(transactionId, workflow);
  }

  async load(transactionId: string): Promise<StepContext[] | null> {
    const workflow = this.workflows.get(transactionId);
    if (!workflow) return null;
    // Deep clone to prevent mutations
    return JSON.parse(JSON.stringify(workflow.stepStack));
  }

  async clear(transactionId: string): Promise<void> {
    // Mark as completed instead of deleting (matches PostgresStorage behavior for audit trail)
    const workflow = this.workflows.get(transactionId);
    if (workflow) {
      workflow.status = 'completed';
      workflow.updatedAt = new Date();
    }
  }

  async updateStatus(
    transactionId: string,
    status: WorkflowStatus,
    error?: WorkflowError
  ): Promise<void> {
    let workflow = this.workflows.get(transactionId);

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
  }

  async getWorkflow(transactionId: string): Promise<WorkflowRecord | null> {
    const workflow = this.workflows.get(transactionId);
    if (!workflow) return null;
    // Deep clone to prevent mutations, but preserve Date objects
    const cloned = JSON.parse(JSON.stringify(workflow));
    // Restore Date objects that were serialized to strings
    cloned.createdAt = new Date(cloned.createdAt);
    cloned.updatedAt = new Date(cloned.updatedAt);
    return cloned;
  }

  async query(filter: WorkflowFilter): Promise<WorkflowQueryResult> {
    let workflows = Array.from(this.workflows.values());

    // Apply filters
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      workflows = workflows.filter(w => statuses.includes(w.status));
    }

    if (filter.createdAfter) {
      workflows = workflows.filter(w => w.createdAt >= filter.createdAfter!);
    }

    if (filter.createdBefore) {
      workflows = workflows.filter(w => w.createdAt <= filter.createdBefore!);
    }

    if (filter.updatedAfter) {
      workflows = workflows.filter(w => w.updatedAt >= filter.updatedAfter!);
    }

    const total = workflows.length;

    // Sort by createdAt descending
    workflows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply pagination
    const offset = filter.offset || 0;
    const limit = filter.limit || 100;
    workflows = workflows.slice(offset, offset + limit);

    // Deep clone results, restoring Date objects
    const clonedWorkflows = workflows.map(w => {
      const cloned = JSON.parse(JSON.stringify(w));
      cloned.createdAt = new Date(cloned.createdAt);
      cloned.updatedAt = new Date(cloned.updatedAt);
      return cloned;
    });

    return {
      workflows: clonedWorkflows,
      total,
    };
  }

  async countByStatus(status: WorkflowStatus | WorkflowStatus[]): Promise<number> {
    const statuses = Array.isArray(status) ? status : [status];
    return Array.from(this.workflows.values()).filter(w =>
      statuses.includes(w.status)
    ).length;
  }

  async atomicRetry(transactionId: string): Promise<number | null> {
    const workflow = this.workflows.get(transactionId);
    if (!workflow || workflow.status !== 'dead_letter') {
      return null;
    }

    workflow.status = 'pending';
    workflow.retryCount += 1;
    workflow.error = null;
    workflow.updatedAt = new Date();

    return workflow.retryCount;
  }

  // === Testing Utilities ===

  /**
   * Get all stored transaction IDs (useful for testing)
   */
  getAllIds(): string[] {
    return Array.from(this.workflows.keys());
  }

  /**
   * Clear all stored transactions (useful for test cleanup)
   */
  clearAll(): void {
    this.workflows.clear();
  }

  /**
   * Get raw workflow for inspection (testing only)
   */
  getRaw(transactionId: string): WorkflowRecord | undefined {
    return this.workflows.get(transactionId);
  }
}
