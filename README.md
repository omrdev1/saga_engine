# Saga Engine

**Crash-resilient saga executor for Node.js. Postgres-backed. Best-effort compensation. Hard 15-minute limit. No magic.**

[![npm version](https://img.shields.io/npm/v/saga-engine.svg)](https://www.npmjs.com/package/saga-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What Saga Engine Is

A library for multi-step workflows with automatic rollback. When step 3 fails, steps 2 and 1 are compensated in reverse order. State survives process crashes via Postgres.

**Use cases:**
- Order fulfillment: inventory → payment → shipping (rollback on failure)
- Multi-system updates: CRM → billing → email (compensate on partial failure)
- Legacy integrations: SOAP APIs without idempotency (track what succeeded)

## What Saga Engine Is NOT

- A workflow orchestration platform (use Temporal)
- A job queue (use BullMQ)
- A scheduler (use node-cron)
- A distributed transaction coordinator
- An exactly-once delivery system

**If you need workflows longer than 15 minutes, use Temporal. We explicitly refuse to support them.**

---

## Installation

```bash
npm install saga-engine
```

## Quick Start

```typescript
import { Transaction, PostgresStorage, PostgresLock } from 'saga-engine';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorage(pool);
const lock = new PostgresLock(pool);

const tx = new Transaction('order-123', storage, {
  idempotencyKey: 'order-abc-fulfillment',  // REQUIRED
  lock,
  input: { orderId: 'abc', amount: 9999 },
});

await tx.run(async (t) => {
  // Step 1: Reserve inventory
  const reservation = await t.step('reserve-inventory', {
    idempotencyKey: 'order-abc-reserve',  // REQUIRED
    execute: () => inventory.reserve(items),
    compensate: (res) => inventory.release(res.id),
  });

  // Step 2: Charge payment
  const charge = await t.step('charge-payment', {
    idempotencyKey: 'order-abc-charge',
    execute: () => stripe.charge(amount, {
      idempotency_key: 'order-abc-charge'  // Pass to external API too!
    }),
    compensate: (ch) => stripe.refund(ch.id, {
      idempotency_key: 'order-abc-refund'
    }),
  });

  // Step 3: Create shipment
  await t.step('create-shipment', {
    idempotencyKey: 'order-abc-ship',
    execute: () => shipping.create(address),
    compensate: (shipment) => shipping.cancel(shipment.id),
  });

  return { reservation, charge };
});
```

**If `create-shipment` fails:**
1. `charge-payment` compensation runs (refund)
2. `reserve-inventory` compensation runs (release)
3. Original error is thrown

---

## Hard Guarantees

| Guarantee | Enforcement |
|-----------|-------------|
| Step persistence before proceeding | Storage interface |
| Compensation triggered on failure | Transaction.run() |
| Resumption skips completed steps | Step execution logic |
| Idempotency required at Transaction AND Step level | Runtime validation (throws `IdempotencyRequiredError`) |
| Locking prevents concurrent execution | Postgres advisory locks |
| Maximum execution time: 15 minutes | Wall-clock check before each step (throws `ExecutionTimeoutError`) |

## Explicit Refusals

| What We Don't Do | Why |
|------------------|-----|
| Guarantee compensation success | `compensate()` is best-effort. Failures → `dead_letter` state |
| External consistency | If you call Stripe and crash before persisting, Stripe was charged. Use their idempotency keys. |
| Distributed transactions | Single-process, single-database only |
| Long-running workflows | 15-minute hard limit. Use Temporal for hours/days. |
| Auto-recovery from dead_letter | Terminal state. Manual CLI intervention required. |

---

## Database Setup

Run this schema in your Postgres database:

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id VARCHAR(255) PRIMARY KEY,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  step_stack JSONB NOT NULL DEFAULT '[]',
  input JSONB NOT NULL DEFAULT '{}',
  retry_count INT NOT NULL DEFAULT 0,
  error JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_error ON transactions USING GIN (error);
```

---

## Workflow States

```
pending → completed    (success)
pending → failed       (failure + all compensations succeeded)
pending → dead_letter  (failure + compensation failed, OR 15-min timeout)
```

| Status | Meaning | Action |
|--------|---------|--------|
| `pending` | In progress or resumable | Will continue on next run |
| `completed` | All steps succeeded | Done |
| `failed` | Failed but fully compensated | Safe to retry with new workflow |
| `dead_letter` | Compensation failed or timed out | **Manual intervention required** |

---

## CLI Administration

```bash
# Retry a dead_letter workflow (atomic, race-safe)
DATABASE_URL=postgres://... npx saga-admin retry order-123

# Override 10-retry limit
DATABASE_URL=postgres://... npx saga-admin retry --force order-123

# List workflows by status
DATABASE_URL=postgres://... npx saga-admin list dead_letter

# Get workflow statistics
DATABASE_URL=postgres://... npx saga-admin stats
```

---

## Retry Policies

```typescript
await t.step('flaky-api', {
  idempotencyKey: 'order-abc-api',
  execute: () => legacyApi.call(),
  compensate: () => legacyApi.rollback(),
  retry: {
    attempts: 3,
    backoffMs: 1000,
  },
});
```

## Step Timeouts

```typescript
await t.step('slow-operation', {
  idempotencyKey: 'order-abc-slow',
  execute: () => slowService.process(),
  compensate: () => slowService.cancel(),
  timeout: 30000,  // 30 second timeout per attempt
});
```

## Compensation Policies

```typescript
await t.step('critical-step', {
  idempotencyKey: 'order-abc-critical',
  execute: () => criticalService.do(),
  compensate: () => criticalService.undo(),
  compensationPolicy: {
    retry: { attempts: 5, backoffMs: 2000 },
    timeout: 60000,
  },
});
```

---

## Observability Events

```typescript
import { Transaction, TransactionEvents } from 'saga-engine';

const events: TransactionEvents = {
  onTransactionStart: (id, input) => logger.info(`Started: ${id}`),
  onTransactionComplete: (id) => logger.info(`Completed: ${id}`),
  onTransactionFailed: (id, error) => logger.error(`Failed: ${id}`, error),
  onStepComplete: (name, result, durationMs) => metrics.record(name, durationMs),
  onCompensationStart: (name) => logger.warn(`Compensating: ${name}`),
  onCompensationFailed: (name, error) => alerting.page(`Compensation failed: ${name}`),
  onDeadLetter: (id, error) => alerting.critical(`Dead letter: ${id}`),
};

const tx = new Transaction('order-123', storage, {
  idempotencyKey: 'order-abc',
  lock,
  events,
});
```

### Available Events

| Event | When |
|-------|------|
| `onTransactionStart` | Transaction begins |
| `onTransactionComplete` | All steps succeeded |
| `onTransactionFailed` | Failed (with or without compensation) |
| `onStepStart` | Step execution begins |
| `onStepComplete` | Step succeeded |
| `onStepFailed` | Step failed (before retry) |
| `onStepRetry` | Step retrying |
| `onStepSkipped` | Step skipped (already completed) |
| `onStepTimeout` | Step exceeded timeout |
| `onCompensationStart` | Compensation begins |
| `onCompensationComplete` | Compensation succeeded |
| `onCompensationFailed` | Compensation failed |
| `onDeadLetter` | Workflow entered dead_letter state |

---

## Error Types

```typescript
import {
  ExecutionTimeoutError,
  IdempotencyRequiredError,
  CompensationFailedError,
  DeadLetterError,
} from 'saga-engine';

try {
  await tx.run(workflow);
} catch (error) {
  if (error instanceof ExecutionTimeoutError) {
    // Workflow exceeded 15-minute limit
    console.log(`Timed out after ${error.elapsedMs}ms`);
  }
  if (error instanceof IdempotencyRequiredError) {
    // Missing idempotency key
    console.log(`Missing key for ${error.level}: ${error.identifier}`);
  }
  if (error instanceof CompensationFailedError) {
    // Compensation threw during rollback
    console.log(`Step ${error.failedStep} compensation failed`);
    console.log(`Original error: ${error.originalError.message}`);
    console.log(`Compensation error: ${error.compensationError.message}`);
  }
}
```

---

## Testing

Test utilities are available via a separate import:

```typescript
import { MemoryStorage, MockLock, createEventSpy } from 'saga-engine/testing';

describe('Order Workflow', () => {
  it('compensates on failure', async () => {
    const storage = new MemoryStorage();
    const lock = new MockLock();
    const eventSpy = createEventSpy();

    const tx = new Transaction('test-order', storage, {
      idempotencyKey: 'test-order-key',
      lock,
      events: eventSpy.events,
    });

    await expect(tx.run(async (t) => {
      await t.step('step-1', {
        idempotencyKey: 's1',
        execute: () => 'result',
        compensate: () => { /* called on failure */ },
      });
      throw new Error('Trigger compensation');
    })).rejects.toThrow('Trigger compensation');

    expect(eventSpy.wasCalled('onCompensationComplete')).toBe(true);
  });
});
```

---

## Querying Workflows

```typescript
// Read-only queries for observability
const deadLetters = await storage.query({
  status: 'dead_letter',
  limit: 100,
});

const recent = await storage.query({
  status: 'failed',
  createdAfter: new Date(Date.now() - 24 * 60 * 60 * 1000),
});

// Get specific workflow
const workflow = await storage.getWorkflow('order-123');
console.log(workflow?.status);  // 'completed' | 'failed' | 'dead_letter' | 'pending'
console.log(workflow?.error);   // { stepName, error, compensationError?, timestamp }
```

---

## Failure Modes

See [docs/FAILURE_MODES.md](docs/FAILURE_MODES.md) for detailed documentation of:
- What we guarantee
- What we explicitly refuse to handle
- Recovery procedures for each failure mode

---

## When to Use Something Else

| Scenario | Use Instead |
|----------|-------------|
| Workflows > 15 minutes | Temporal |
| Need job queues | BullMQ |
| Need cron scheduling | node-cron |
| Need distributed coordination | Temporal |
| Need managed platform | Inngest |
| Need exactly-once external delivery | Outbox pattern + Debezium |

---

## License

MIT
