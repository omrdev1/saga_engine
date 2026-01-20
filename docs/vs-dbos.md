# Saga Engine vs DBOS Transact: An Honest Comparison

Both libraries solve durable workflows in Node.js with Postgres. Here's when to use each.

---

## TL;DR

| Criteria | Saga Engine | DBOS Transact |
|----------|-------------|---------------|
| Compensation | Native `compensate()` | Manual implementation |
| Idempotency | Required (enforced) | Optional (decorators) |
| Time limit | 15 min (hard) | Unlimited |
| Durable sleep | ❌ | ✅ |
| Scheduling | ❌ | ✅ |
| Runtime | Your process | DBOS runtime |
| Failure state | Explicit `dead_letter` | Implicit |

**Choose Saga Engine if:** You need compensation/rollback semantics.

**Choose DBOS if:** You need long-running workflows or durable timers.

---

## The Fundamental Difference

**DBOS:** Durable execution with replay. If a workflow crashes, it replays from the beginning, skipping completed steps.

**Saga Engine:** Durable execution with compensation. If a step fails, previous steps are rolled back.

```
DBOS Model:
Step 1 → Step 2 → Step 3 (fails) → Replay from start
                                    ↓
                              Step 1 (skip) → Step 2 (skip) → Step 3 (retry)

Saga Engine Model:
Step 1 → Step 2 → Step 3 (fails) → Compensate Step 2 → Compensate Step 1
```

**When this matters:**

| Scenario | DBOS Approach | Saga Engine Approach |
|----------|---------------|---------------------|
| Payment fails | Retry the payment | Refund completed payments, cancel |
| Shipment fails | Retry the shipment | Cancel shipment, refund, release inventory |
| Email fails | Retry the email | No compensation needed (idempotent) |

---

## What DBOS Does Better

### 1. Unlimited Workflow Duration

```typescript
// DBOS - Can run for days
@DBOS.workflow()
async function approvalWorkflow(request: Request) {
  await submitForApproval(request);
  await DBOS.sleep(86400000);  // Sleep for 24 hours
  await checkApprovalStatus(request);
}
```

**Saga Engine:** Hard 15-minute limit. `ExecutionTimeoutError` if exceeded.

### 2. Durable Sleep

```typescript
// DBOS - Sleep survives restarts
@DBOS.workflow()
async function reminderFlow() {
  await DBOS.sleep(3600000);  // 1 hour, survives crash
  await sendReminder();
}
```

**Saga Engine:** No native sleep. Use external scheduling.

### 3. Built-in Scheduling

```typescript
// DBOS - Native cron
@DBOS.scheduled({ cron: '0 9 * * *' })
async function dailyReport() {
  await generateReport();
  await sendToSlack();
}
```

**Saga Engine:** No scheduling. Use node-cron externally.

### 4. Durable Queues

```typescript
// DBOS - Built-in queue
const queue = new DBOS.Queue('email-queue', { concurrency: 5 });
await queue.enqueue(sendEmail, { to: 'user@example.com' });
```

**Saga Engine:** No queues. Use BullMQ externally.

### 5. Decorator Syntax

```typescript
// DBOS - Clean decorators
@DBOS.workflow()
async function checkout(order: Order) {
  await chargePayment(order);
  await shipOrder(order);
}

@DBOS.step()
async function chargePayment(order: Order) {
  return stripe.charge(order.total);
}
```

**Saga Engine:** More verbose explicit API.

### 6. Cloud Platform

DBOS offers DBOS Cloud with:
- Managed infrastructure
- Web dashboard
- Monitoring and alerting
- One-click deployment

**Saga Engine:** Self-hosted only. Query Postgres directly.

---

## What Saga Engine Does Better

### 1. Native Compensation

```typescript
// Saga Engine - Compensation is first-class
await t.step('charge-payment', {
  idempotencyKey: 'order-123-charge',
  execute: () => stripe.charge(amount),
  compensate: (charge) => stripe.refund(charge.id),
});

await t.step('reserve-inventory', {
  idempotencyKey: 'order-123-reserve',
  execute: () => inventory.reserve(items),
  compensate: (reservation) => inventory.release(reservation.id),
});

// If reserve-inventory fails:
// 1. charge-payment.compensate() is called automatically
// 2. Refund is issued
// 3. Clean rollback
```

**DBOS has no native compensation:**

```typescript
// DBOS - Manual compensation
@DBOS.workflow()
async function checkout(order: Order) {
  const charge = await chargePayment(order);

  try {
    await reserveInventory(order);
    await createShipment(order);
  } catch (error) {
    // You must implement this manually
    await refundPayment(charge.id);
    throw error;
  }
}
```

**The difference:**
- Saga Engine: Compensation is automatic, reverse-order, with retry policies
- DBOS: You write compensation logic manually in catch blocks

### 2. Enforced Idempotency

```typescript
// Saga Engine - Required at runtime
const tx = new Transaction('order-123', storage, {
  idempotencyKey: 'order-123-flow',  // REQUIRED - throws if missing
});

await t.step('charge', {
  idempotencyKey: 'order-123-charge',  // REQUIRED - throws if missing
  execute: () => stripe.charge(amount),
  compensate: (ch) => stripe.refund(ch.id),
});
```

**DBOS - Optional:**

```typescript
// DBOS - Optional idempotency
@DBOS.workflow()
async function checkout(order: Order) {
  // Did you remember idempotency_key? No enforcement.
  await chargePayment(order);
}
```

### 3. Explicit Failure States

**Saga Engine:**
```
pending      → In progress
completed    → Success
failed       → Failed, fully compensated
dead_letter  → Failed, compensation failed (TERMINAL)
```

**DBOS:**
```
Running
Completed
Failed
```

**Saga Engine's `dead_letter` state:**
- Explicitly marks workflows requiring human intervention
- Preserves step stack for debugging
- CLI tool for atomic retry
- No silent failures

### 4. Zero Runtime Dependency

**Saga Engine:**
```typescript
import { Transaction, PostgresStorage, PostgresLock } from 'saga-engine';

// Runs in YOUR process, with YOUR Postgres
const tx = new Transaction('order-123', storage, { lock });
await tx.run(workflow);
```

**DBOS:**
```bash
# Requires DBOS runtime
npx dbos start  # Their process wraps yours
```

### 5. Compensation Retry Policies

```typescript
// Saga Engine - Retry policies for compensation
await t.step('critical-step', {
  execute: () => criticalService.do(),
  compensate: () => criticalService.undo(),
  compensationPolicy: {
    retry: { attempts: 5, backoffMs: 2000 },
    timeout: 60000,
  },
});
```

**DBOS:** No compensation-specific retry policies.

### 6. Terminal State with CLI Recovery

```bash
# Saga Engine - Atomic retry with race protection
DATABASE_URL=postgres://... npx saga-admin retry order-123

# List dead letter workflows
DATABASE_URL=postgres://... npx saga-admin list dead_letter

# Check retry counts
DATABASE_URL=postgres://... npx saga-admin stats
```

**DBOS:** No built-in CLI for workflow recovery.

---

## Feature Comparison Matrix

| Feature | Saga Engine | DBOS |
|---------|-------------|------|
| **Core** | | |
| Durable execution | ✅ | ✅ |
| Crash recovery | ✅ | ✅ |
| Step persistence | ✅ | ✅ |
| **Compensation** | | |
| Native compensation | ✅ | ❌ |
| Automatic reverse-order | ✅ | ❌ |
| Compensation retry policies | ✅ | ❌ |
| **Safety** | | |
| Enforced idempotency | ✅ Required | ⚠️ Optional |
| Execution time limit | ✅ 15 min | ❌ None |
| Explicit dead_letter state | ✅ | ❌ |
| **Features** | | |
| Durable sleep | ❌ | ✅ |
| Scheduling/cron | ❌ | ✅ |
| Queues | ❌ | ✅ |
| Cloud platform | ❌ | ✅ |
| Web dashboard | ❌ | ✅ |
| **Operations** | | |
| Zero runtime dependency | ✅ | ❌ |
| CLI recovery tool | ✅ | ⚠️ Limited |
| Query workflows | ✅ SQL | ✅ Dashboard |

---

## Code Comparison

### Simple Workflow

**Saga Engine:**
```typescript
const tx = new Transaction('checkout-123', storage, {
  idempotencyKey: 'checkout-123',
  lock,
});

await tx.run(async (t) => {
  const charge = await t.step('charge', {
    idempotencyKey: 'checkout-123-charge',
    execute: () => stripe.charge(amount),
    compensate: (ch) => stripe.refund(ch.id),
  });

  await t.step('ship', {
    idempotencyKey: 'checkout-123-ship',
    execute: () => shipping.create(address),
    compensate: (sh) => shipping.cancel(sh.id),
  });

  return charge;
});
```

**DBOS:**
```typescript
@DBOS.workflow()
async function checkout(orderId: string, amount: number, address: Address) {
  const charge = await chargePayment(amount);
  const shipment = await createShipment(address);
  return { charge, shipment };
}

@DBOS.step()
async function chargePayment(amount: number) {
  return stripe.charge(amount);
}

@DBOS.step()
async function createShipment(address: Address) {
  return shipping.create(address);
}

// Note: No automatic compensation if createShipment fails
```

### Handling Failures

**Saga Engine (automatic):**
```typescript
// If step 2 fails, step 1 compensation runs automatically
await tx.run(async (t) => {
  await t.step('step-1', { execute, compensate });  // ← compensate called on step-2 failure
  await t.step('step-2', { execute, compensate });  // ← fails
});
// Result: step-1 compensated, workflow in 'failed' state
```

**DBOS (manual):**
```typescript
@DBOS.workflow()
async function workflow() {
  const result1 = await step1();

  try {
    await step2();  // ← fails
  } catch (error) {
    await compensateStep1(result1);  // ← you must write this
    throw error;
  }
}
```

---

## Decision Guide

### Choose Saga Engine When:

1. **You need compensation/rollback** - Native `compensate()` is your primary use case
2. **Workflows are < 15 minutes** - You fit within the hard limit
3. **Zero infrastructure** - You want to use existing Postgres only
4. **Enforced safety** - You want idempotency required, not optional
5. **Explicit failure handling** - You want `dead_letter` state with CLI recovery

### Choose DBOS When:

1. **Long-running workflows** - You need > 15 minutes
2. **Durable timers** - You need `sleep()` that survives restarts
3. **Scheduling** - You need built-in cron
4. **Managed platform** - You want DBOS Cloud
5. **Decorator syntax** - You prefer the cleaner API

### Use Both When:

Possible, but adds complexity. Generally pick one.

---

## The Honest Summary

**DBOS is a platform** with more features: scheduling, queues, timers, cloud hosting.

**Saga Engine is a library** with one focus: compensation/rollback with crash recovery.

**DBOS replays forward.** When something fails, it retries.

**Saga Engine can roll backward.** When something fails, it compensates.

If compensation is your primary need, Saga Engine does it better. If you need platform features, DBOS does more.

---

## Further Reading

- [DBOS Documentation](https://docs.dbos.dev/)
- [Saga Engine FAILURE_MODES.md](./FAILURE_MODES.md)
- [Saga Pattern - Microservices.io](https://microservices.io/patterns/data/saga.html)
