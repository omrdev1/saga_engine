/**
 * Real-World Example: Legacy System Data Sync
 *
 * This demonstrates syncing data to a legacy SOAP/FTP system that has
 * no idempotency support. If the connection drops halfway through,
 * we need to know exactly where we stopped and be able to resume.
 *
 * Workflow:
 * 1. Fetch records from modern API
 * 2. Transform data for legacy format
 * 3. Upload to legacy FTP server
 * 4. Update legacy SOAP service
 * 5. Mark sync complete in local database
 *
 * If ANY step fails, previous steps are automatically rolled back:
 * - FTP files deleted
 * - SOAP records reverted
 * - Local state reset
 *
 * Usage:
 *   npm run example:legacy-sync
 */

import { Transaction, FileStorage } from '../index';

// Simulated legacy system clients
class MockFTPClient {
  private uploadedFiles: string[] = [];

  async upload(filename: string, content: string): Promise<string> {
    console.log(`  [FTP] Uploading ${filename}...`);
    await this.delay(500);

    // Simulate occasional connection issues
    if (Math.random() < 0.1) {
      throw new Error('FTP connection timeout');
    }

    const remoteId = `ftp_${Date.now()}_${filename}`;
    this.uploadedFiles.push(remoteId);
    console.log(`  [FTP] Upload complete: ${remoteId}`);
    return remoteId;
  }

  async delete(remoteId: string): Promise<void> {
    console.log(`  [FTP] Deleting ${remoteId}...`);
    await this.delay(200);
    this.uploadedFiles = this.uploadedFiles.filter((f) => f !== remoteId);
    console.log(`  [FTP] Deleted successfully`);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class MockSOAPClient {
  async createRecord(data: Record<string, unknown>): Promise<string> {
    console.log(`  [SOAP] Creating record...`);
    await this.delay(600);

    // Simulate legacy system being flaky
    if (Math.random() < 0.1) {
      throw new Error('SOAP service unavailable');
    }

    const recordId = `SOAP_REC_${Date.now()}`;
    console.log(`  [SOAP] Record created: ${recordId}`);
    return recordId;
  }

  async deleteRecord(recordId: string): Promise<void> {
    console.log(`  [SOAP] Deleting record ${recordId}...`);
    await this.delay(400);
    console.log(`  [SOAP] Record deleted`);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class MockDatabase {
  private syncs: Map<string, { status: string; timestamp: number }> = new Map();

  async markSyncStarted(syncId: string): Promise<void> {
    console.log(`  [DB] Marking sync ${syncId} as started...`);
    await this.delay(100);
    this.syncs.set(syncId, { status: 'in_progress', timestamp: Date.now() });
  }

  async markSyncComplete(syncId: string): Promise<void> {
    console.log(`  [DB] Marking sync ${syncId} as complete...`);
    await this.delay(100);
    this.syncs.set(syncId, { status: 'completed', timestamp: Date.now() });
  }

  async revertSync(syncId: string): Promise<void> {
    console.log(`  [DB] Reverting sync ${syncId}...`);
    await this.delay(100);
    this.syncs.delete(syncId);
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Initialize mock clients
const ftpClient = new MockFTPClient();
const soapClient = new MockSOAPClient();
const database = new MockDatabase();

/**
 * Main workflow: Sync customer data to legacy systems
 */
async function syncToLegacySystem(customerId: string, data: Record<string, unknown>) {
  const storage = new FileStorage();
  const syncId = `legacy-sync-${customerId}-${Date.now()}`;
  const tx = new Transaction(syncId, storage);

  console.log(`\nStarting legacy sync: ${syncId}`);
  console.log(`Customer: ${customerId}\n`);

  await tx.run(async (t) => {
    // Step 1: Mark sync as started in local DB
    console.log(`Step 1: Initialize sync tracking...`);
    await t.step('init-sync', {
      do: async () => {
        await database.markSyncStarted(syncId);
        return { syncId };
      },
      undo: async () => {
        console.log(`  Compensating: Reverting sync status`);
        await database.revertSync(syncId);
      },
    });

    // Step 2: Transform and upload data file to FTP
    console.log(`\nStep 2: Upload data to FTP server...`);
    const ftpResult = await t.step('upload-ftp', {
      do: async () => {
        // Transform data to legacy CSV format
        const csvContent = Object.entries(data)
          .map(([k, v]) => `${k},${v}`)
          .join('\n');

        const filename = `customer_${customerId}.csv`;
        const remoteId = await ftpClient.upload(filename, csvContent);
        return { remoteId, filename };
      },
      undo: async (result) => {
        console.log(`  Compensating: Deleting FTP file`);
        await ftpClient.delete(result.remoteId);
      },
      retry: {
        attempts: 3,
        backoffMs: 2000,
      },
    });

    // Step 3: Create record in legacy SOAP service
    console.log(`\nStep 3: Create record in SOAP service...`);
    const soapResult = await t.step('create-soap-record', {
      do: async () => {
        const recordId = await soapClient.createRecord({
          customerId,
          ftpFile: ftpResult.remoteId,
          ...data,
        });
        return { recordId };
      },
      undo: async (result) => {
        console.log(`  Compensating: Deleting SOAP record`);
        await soapClient.deleteRecord(result.recordId);
      },
      retry: {
        attempts: 3,
        backoffMs: 1500,
      },
    });

    // Step 4: Mark sync as complete
    console.log(`\nStep 4: Finalize sync...`);
    await t.step('complete-sync', {
      do: async () => {
        await database.markSyncComplete(syncId);
        return {
          syncId,
          ftpFile: ftpResult.remoteId,
          soapRecord: soapResult.recordId,
        };
      },
      undo: async () => {
        console.log(`  Compensating: Reverting sync completion`);
        await database.revertSync(syncId);
      },
    });
  });

  console.log(`\nSync completed successfully!`);
  console.log(`  Sync ID: ${syncId}`);
  console.log(`  Customer data synced to legacy FTP and SOAP systems.\n`);
}

/**
 * Demo with intentional failure to show rollback
 */
async function demoFailureScenario() {
  console.log(`\n--- FAILURE SCENARIO ---`);
  console.log(`Demonstrating automatic rollback on failure...\n`);

  const storage = new FileStorage();
  const tx = new Transaction(`failure-demo-${Date.now()}`, storage);

  try {
    await tx.run(async (t) => {
      console.log(`Step 1: Upload to FTP...`);
      await t.step('upload-ftp', {
        do: async () => {
          console.log(`  FTP upload successful`);
          return { remoteId: 'ftp_123' };
        },
        undo: async (result) => {
          console.log(`  Compensating: Deleting FTP file ${result.remoteId}`);
        },
      });

      console.log(`\nStep 2: Create SOAP record...`);
      await t.step('create-soap', {
        do: async () => {
          console.log(`  SOAP record created`);
          return { recordId: 'SOAP_456' };
        },
        undo: async (result) => {
          console.log(`  Compensating: Deleting SOAP record ${result.recordId}`);
        },
      });

      console.log(`\nStep 3: Simulating network failure...`);
      await t.step('final-step', {
        do: async () => {
          throw new Error('Network connection lost');
        },
        undo: async () => {},
      });
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`\nTransaction failed: ${errorMessage}`);
    console.log(`All completed steps have been automatically rolled back!\n`);
  }
}

// Main execution
(async () => {
  console.log('========================================================');
  console.log('  Saga Engine - Legacy System Sync Example');
  console.log('  FTP + SOAP Integration with Crash Recovery');
  console.log('========================================================');

  // Success scenario
  await syncToLegacySystem('CUST_12345', {
    name: 'Acme Corp',
    contact: 'john@acme.com',
    contract_value: 50000,
    region: 'EMEA',
  });

  // Uncomment to see failure scenario with automatic rollback:
  // await demoFailureScenario();

  console.log('========================================================\n');
})().catch((error) => {
  console.error('\nFatal error:', error.message);
  process.exit(1);
});
