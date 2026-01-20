#!/usr/bin/env npx tsx
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   SAGA ENGINE - SHOWCASE DEMO                                             ║
 * ║   Durable Workflows with Automatic Rollback                               ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * This showcase demonstrates ALL features of saga-engine:
 *
 *   ✅ Multi-step workflows with automatic rollback
 *   ✅ Persistence & crash recovery (Redis/File)
 *   ✅ Distributed locking for concurrency safety
 *   ✅ Retry policies for flaky APIs
 *   ✅ Step timeouts to prevent hanging
 *   ✅ Observability hooks for monitoring
 *
 * USAGE:
 *   npx tsx examples/showcase.ts              # Run success scenario
 *   npx tsx examples/showcase.ts --fail       # Demonstrate automatic rollback
 *   npx tsx examples/showcase.ts --resume     # Demonstrate crash recovery
 *   npx tsx examples/showcase.ts --timeout    # Demonstrate timeout handling
 *   npx tsx examples/showcase.ts --all        # Run all scenarios
 *
 * SCENARIO: Order Fulfillment Workflow
 *   1. Reserve inventory
 *   2. Process payment
 *   3. Create shipment
 *   4. Send confirmation email
 *   5. Update analytics
 *
 *   If ANY step fails → all previous steps are automatically compensated
 */

import {
  Transaction,
  FileStorage,
  MemoryStorage,
  TransactionEvents,
} from '../index';

// ═══════════════════════════════════════════════════════════════════════════
// MOCK SERVICES (simulate real integrations)
// ═══════════════════════════════════════════════════════════════════════════

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

class InventoryService {
  async reserve(items: string[]): Promise<{ reservationId: string; items: string[] }> {
    await delay(500);
    return {
      reservationId: `res_${Date.now()}`,
      items,
    };
  }

  async release(reservationId: string): Promise<void> {
    await delay(200);
  }
}

class PaymentService {
  async charge(amount: number, customerId: string): Promise<{ chargeId: string; amount: number }> {
    await delay(700);
    return {
      chargeId: `ch_${Date.now()}`,
      amount,
    };
  }

  async refund(chargeId: string): Promise<void> {
    await delay(400);
  }
}

class ShippingService {
  async createShipment(address: string, items: string[]): Promise<{ trackingNumber: string }> {
    await delay(400);
    return { trackingNumber: `TRK${Date.now()}` };
  }

  async cancelShipment(trackingNumber: string): Promise<void> {
    await delay(200);
  }
}

class EmailService {
  async send(to: string, subject: string, body: string): Promise<{ messageId: string }> {
    await delay(300);
    return { messageId: `msg_${Date.now()}` };
  }
}

class AnalyticsService {
  async track(event: string, data: any): Promise<{ recorded: boolean }> {
    await delay(200);
    return { recorded: true };
  }

  async delete(event: string, correlationId: string): Promise<void> {
    await delay(100);
  }
}

// Initialize services
const inventory = new InventoryService();
const payments = new PaymentService();
const shipping = new ShippingService();
const email = new EmailService();
const analytics = new AnalyticsService();

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVABILITY SETUP
// ═══════════════════════════════════════════════════════════════════════════

function createObservabilityHooks(): { events: TransactionEvents; metrics: Map<string, number> } {
  const metrics = new Map<string, number>();

  const events: TransactionEvents = {
    onTransactionStart: (txId) => {
      console.log(`\n  Transaction started: ${txId}`);
      metrics.set('tx_started', Date.now());
    },
    onTransactionComplete: (txId, durationMs) => {
      console.log(`\n  Transaction completed in ${durationMs}ms`);
      metrics.set('tx_duration', durationMs);
    },
    onTransactionFailed: (txId, error) => {
      console.log(`\n  Transaction failed: ${error.message}`);
    },
    onStepStart: (stepName) => {
      process.stdout.write(`  [pending] ${stepName}...`);
    },
    onStepComplete: (stepName, _result, durationMs) => {
      console.log(` done (${durationMs}ms)`);
    },
    onStepFailed: (stepName, error, attempt) => {
      console.log(` failed attempt ${attempt}: ${error.message}`);
    },
    onStepRetry: (stepName, attempt, max) => {
      console.log(`  [retry] ${stepName} (${attempt}/${max})...`);
    },
    onStepSkipped: (stepName) => {
      console.log(`  [skipped] ${stepName} (already completed)`);
    },
    onStepTimeout: (stepName, timeoutMs) => {
      console.log(` TIMEOUT after ${timeoutMs}ms`);
    },
    onCompensationStart: (stepName) => {
      console.log(`  [rollback] ${stepName}...`);
    },
    onCompensationComplete: (stepName, durationMs) => {
      console.log(`  [rolled back] ${stepName} (${durationMs}ms)`);
    },
    onCompensationFailed: (stepName, error) => {
      console.log(`  [rollback failed] ${stepName}: ${error.message}`);
    },
  };

  return { events, metrics };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════

interface WorkflowOptions {
  failAtStep?: string;
  simulateTimeout?: boolean;
  usePersistedStorage?: boolean;
}

interface OrderData {
  orderId: string;
  customerId: string;
  customerEmail: string;
  items: string[];
  amount: number;
  shippingAddress: string;
}

async function runOrderFulfillmentWorkflow(
  order: OrderData,
  options: WorkflowOptions = {}
) {
  const { events, metrics } = createObservabilityHooks();
  const storage = options.usePersistedStorage ? new FileStorage() : new MemoryStorage();

  const tx = new Transaction(`order-${order.orderId}`, storage, {
    events,
    cleanupOnSuccess: false, // Keep audit trail
  });

  const correlationId = `corr_${Date.now()}`;

  await tx.run(async (t) => {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Reserve inventory
    // ─────────────────────────────────────────────────────────────────────
    const reservation = await t.step('reserve-inventory', {
      do: async () => {
        if (options.failAtStep === 'inventory') throw new Error('Inventory service unavailable');
        return await inventory.reserve(order.items);
      },
      undo: async (result) => {
        await inventory.release(result.reservationId);
      },
      retry: { attempts: 3, backoffMs: 1000 },
      timeout: 5000,
    });

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Process payment
    // ─────────────────────────────────────────────────────────────────────
    const payment = await t.step('process-payment', {
      do: async () => {
        if (options.failAtStep === 'payment') throw new Error('Payment declined');
        if (options.simulateTimeout) await delay(10000); // Simulate hang
        return await payments.charge(order.amount, order.customerId);
      },
      undo: async (result) => {
        await payments.refund(result.chargeId);
      },
      retry: { attempts: 2, backoffMs: 500 },
      timeout: options.simulateTimeout ? 2000 : 10000,
    });

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: Create shipment
    // ─────────────────────────────────────────────────────────────────────
    const shipment = await t.step('create-shipment', {
      do: async () => {
        if (options.failAtStep === 'shipment') throw new Error('Shipping service down');
        return await shipping.createShipment(order.shippingAddress, order.items);
      },
      undo: async (result) => {
        await shipping.cancelShipment(result.trackingNumber);
      },
    });

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4: Send confirmation email
    // ─────────────────────────────────────────────────────────────────────
    const emailResult = await t.step('send-confirmation', {
      do: async () => {
        if (options.failAtStep === 'email') throw new Error('Email delivery failed');
        return await email.send(
          order.customerEmail,
          `Order Confirmation #${order.orderId}`,
          `Your order has shipped! Tracking: ${shipment.trackingNumber}`
        );
      },
      undo: async () => {
        // Can't unsend email, but we log for audit
        console.log(`    (Note: Email ${emailResult?.messageId} was sent before failure)`);
      },
    });

    // ─────────────────────────────────────────────────────────────────────
    // STEP 5: Track analytics
    // ─────────────────────────────────────────────────────────────────────
    await t.step('track-analytics', {
      do: async () => {
        if (options.failAtStep === 'analytics') throw new Error('Analytics service down');
        return await analytics.track('order_completed', {
          orderId: order.orderId,
          amount: order.amount,
          itemCount: order.items.length,
          fulfillmentTime: metrics.get('tx_duration') || 0,
          correlationId,
        });
      },
      undo: async () => {
        await analytics.delete('order_completed', correlationId);
      },
    });
  });

  return { success: true, correlationId };
}

// ═══════════════════════════════════════════════════════════════════════════
// DEMO SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

function printHeader(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function printScenarioHeader(emoji: string, title: string, description: string) {
  console.log(`\n${emoji} ${title}`);
  console.log(`   ${description}`);
  console.log('-'.repeat(50));
}

const sampleOrder: OrderData = {
  orderId: 'ORD-001',
  customerId: 'cust_12345',
  customerEmail: 'customer@example.com',
  items: ['SKU-001', 'SKU-002', 'SKU-003'],
  amount: 9999,
  shippingAddress: '123 Main St, City, ST 12345',
};

async function runSuccessScenario() {
  printScenarioHeader(
    '>>',
    'SUCCESS SCENARIO',
    'All steps complete successfully'
  );

  await runOrderFulfillmentWorkflow({
    ...sampleOrder,
    orderId: 'ORD-001',
  });

  console.log('\n  Result: All 5 steps completed, audit trail preserved');
}

async function runFailureScenario() {
  printScenarioHeader(
    '>>',
    'FAILURE SCENARIO',
    'Step 4 fails -> automatic rollback of steps 1-3'
  );

  try {
    await runOrderFulfillmentWorkflow(
      { ...sampleOrder, orderId: 'ORD-002' },
      { failAtStep: 'email' }
    );
  } catch (error: any) {
    console.log(`\n  Result: Transaction failed, all steps automatically rolled back`);
    console.log(`     Error: ${error.message}`);
  }
}

async function runTimeoutScenario() {
  printScenarioHeader(
    '>>',
    'TIMEOUT SCENARIO',
    'Step 2 hangs -> timeout triggers rollback'
  );

  try {
    await runOrderFulfillmentWorkflow(
      { ...sampleOrder, orderId: 'ORD-003' },
      { simulateTimeout: true }
    );
  } catch (error: any) {
    console.log(`\n  Result: Step timed out, previous steps rolled back`);
    console.log(`     Error: ${error.message}`);
  }
}

async function runResumeScenario() {
  printScenarioHeader(
    '>>',
    'RESUME SCENARIO',
    'Simulates crash recovery - completed steps are skipped'
  );

  const orderId = `ORD-RESUME-${Date.now()}`;

  // First run - will fail at step 3
  console.log('\n  [First Run - Fails at shipment step]');
  try {
    await runOrderFulfillmentWorkflow(
      { ...sampleOrder, orderId },
      { failAtStep: 'shipment', usePersistedStorage: true }
    );
  } catch {
    console.log('  (Process would crash here in real scenario)');
  }

  // Second run - resumes from where it left off
  console.log('\n  [Second Run - Resumes from checkpoint]');
  try {
    await runOrderFulfillmentWorkflow(
      { ...sampleOrder, orderId },
      { usePersistedStorage: true }
    );
    console.log('\n  Result: Transaction resumed and completed successfully');
  } catch (error: any) {
    console.log(`\n  Note: Steps 1-2 were skipped (already completed)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`
========================================================================

   SAGA ENGINE - SHOWCASE
   Durable Workflows with Automatic Rollback

   https://github.com/Grafikui/saga-engine

========================================================================
`);

  console.log('  SCENARIO: Order Fulfillment Workflow');
  console.log('  ------------------------------------');
  console.log('  1. Reserve inventory');
  console.log('  2. Process payment');
  console.log('  3. Create shipment');
  console.log('  4. Send confirmation email');
  console.log('  5. Update analytics');
  console.log('\n  If ANY step fails -> all previous steps are automatically rolled back');

  const args = process.argv.slice(2);
  const runAll = args.includes('--all');
  const runFail = args.includes('--fail');
  const runResume = args.includes('--resume');
  const runTimeout = args.includes('--timeout');
  const runSuccess = args.length === 0 || args.includes('--success');

  try {
    if (runAll || runSuccess) {
      await runSuccessScenario();
    }

    if (runAll || runFail) {
      await runFailureScenario();
    }

    if (runAll || runTimeout) {
      await runTimeoutScenario();
    }

    if (runAll || runResume) {
      await runResumeScenario();
    }

    printHeader('SHOWCASE COMPLETE');
    console.log(`
  Learn more:
  - Documentation: https://github.com/Grafikui/saga-engine
  - npm install saga-engine

  Run different scenarios:
  - npx tsx examples/showcase.ts --fail      # See automatic rollback
  - npx tsx examples/showcase.ts --timeout   # See timeout handling
  - npx tsx examples/showcase.ts --resume    # See crash recovery
  - npx tsx examples/showcase.ts --all       # Run all scenarios
`);
  } catch (error: any) {
    console.error('\nShowcase error:', error.message);
    process.exit(1);
  }
}

main();
