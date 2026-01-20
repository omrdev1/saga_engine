# Saga Engine vs Try/Catch: When Do You Actually Need a Saga?

This document helps you decide if you need Saga Engine or if try/catch is sufficient.

**Spoiler:** Try/catch is often enough. Don't over-engineer.

---

## TL;DR

| Scenario | Try/Catch | Saga Engine |
|----------|-----------|-------------|
| Single database transaction | ✅ | Overkill |
| Fast operations (< 1 second) | ✅ | Usually overkill |
| No external side effects | ✅ | Overkill |
| External APIs with side effects | ⚠️ Risky | ✅ |
| Process can crash mid-operation | ⚠️ Risky | ✅ |
| Need to undo previous steps | ❌ Can't | ✅ |
| Operations must survive restart | ❌ Can't | ✅ |

---

## The Problem with Try/Catch

### Scenario: E-commerce Checkout

```typescript
// try/catch approach
async function checkout(order: Order) {
  try {
    // Step 1: Charge payment
    const charge = await stripe.charge(order.total);

    // Step 2: Reserve inventory
    const reservation = await inventory.reserve(order.items);

    // Step 3: Create shipment
    const shipment = await shipping.create(order.address);

    return { charge, reservation, shipment };
  } catch (error) {
    // Uh oh...
  }
}
```

### What happens when things fail?

**Scenario 1: Step 3 fails**
```
✓ Step 1: Stripe charged $100
✓ Step 2: Inventory reserved
✗ Step 3: Shipping API down

catch block runs:
  // How do you undo step 1 and 2?
  // You don't have the charge or reservation objects
  // Customer charged, no product
```

**Scenario 2: Process crashes after Step 2**
```
✓ Step 1: Stripe charged $100
✓ Step 2: Inventory reserved
💥 Process crashes before Step 3

No catch block runs (process is dead)
Customer charged, inventory held, no shipment
On restart: No record of what happened
```

**Scenario 3: Process crashes mid-Step-1**
```
➡️ Step 1: stripe.charge() called
   Stripe processes the charge
💥 Process crashes before response received

On restart:
  Step 1 runs again
  Customer charged twice
```

---

## The "Fixed" Try/Catch (Still Broken)

```typescript
async function checkout(order: Order) {
  let charge: Stripe.Charge | null = null;
  let reservation: Reservation | null = null;

  try {
    charge = await stripe.charge(order.total);
    reservation = await inventory.reserve(order.items);
    const shipment = await shipping.create(order.address);
    return { charge, reservation, shipment };
  } catch (error) {
    // "Fixed" compensation
    if (reservation) await inventory.release(reservation.id);
    if (charge) await stripe.refund(charge.id);
    throw error;
  }
}
```

### Still broken because:

1. **Process crash = no catch block**
   ```
   ✓ charge = await stripe.charge()
   💥 Process crashes
   // catch block never runs
   // Customer charged forever
   ```

2. **Compensation can fail**
   ```
   catch {
     await inventory.release()  // ✓ success
     await stripe.refund()      // ✗ API timeout
     // Partial compensation, inconsistent state
   }
   ```

3. **No retry on restart**
   ```
   // After crash and restart
   // No record of previous attempt
   // Must start over or accept data loss
   ```

4. **No idempotency**
   ```
   // Network glitch during stripe.charge()
   // Did it succeed? Unknown.
   // Retry = potential double charge
   ```

---

## What Saga Engine Adds

```typescript
const tx = new Transaction('checkout-123', storage, {
  idempotencyKey: `checkout-${order.id}`,
  lock,
});

await tx.run(async (t) => {
  const charge = await t.step('charge', {
    idempotencyKey: `${order.id}-charge`,
    execute: () => stripe.charge(order.total, {
      idempotency_key: `${order.id}-charge`
    }),
    compensate: (ch) => stripe.refund(ch.id, {
      idempotency_key: `${order.id}-refund`
    }),
  });

  const reservation = await t.step('reserve', {
    idempotencyKey: `${order.id}-reserve`,
    execute: () => inventory.reserve(order.items),
    compensate: (res) => inventory.release(res.id),
  });

  const shipment = await t.step('ship', {
    idempotencyKey: `${order.id}-ship`,
    execute: () => shipping.create(order.address),
    compensate: (sh) => shipping.cancel(sh.id),
  });

  return { charge, reservation, shipment };
});
```

### What you get:

| Problem | Saga Engine Solution |
|---------|---------------------|
| Process crash | State persisted to Postgres after each step |
| Compensation on failure | Automatic reverse-order `compensate()` calls |
| Compensation can fail | Retry policies, `dead_letter` state for manual intervention |
| No idempotency | Required keys at Transaction and Step level |
| Restart recovery | Completed steps skipped, resume from last state |
| Double execution | Idempotency keys prevent duplicates |

---

## Decision Flowchart

```
START: Do I need Saga Engine?
         │
         ▼
┌────────────────────────────┐
│ Do you call external APIs   │
│ with side effects?          │
│ (Stripe, Twilio, etc.)      │
└────────────┬───────────────┘
             │
     ┌───────┴───────┐
     │               │
     ▼               ▼
    YES             NO
     │               │
     │               ▼
     │    ┌─────────────────────┐
     │    │ Is everything in a   │
     │    │ single DB transaction?│
     │    └──────────┬──────────┘
     │               │
     │       ┌───────┴───────┐
     │       │               │
     │       ▼               ▼
     │      YES             NO
     │       │               │
     │       ▼               │
     │  Use try/catch +      │
     │  DB transaction       │
     │                       │
     ▼                       ▼
┌────────────────────────────┐
│ Could your process crash    │
│ mid-operation?              │
│ (Always yes in production)  │
└────────────┬───────────────┘
             │
     ┌───────┴───────┐
     │               │
     ▼               ▼
    YES             NO (lol)
     │               │
     │               ▼
     │         Use try/catch
     │         (and good luck)
     │
     ▼
┌────────────────────────────┐
│ Do you need to undo         │
│ previous steps on failure?  │
└────────────┬───────────────┘
             │
     ┌───────┴───────┐
     │               │
     ▼               ▼
    YES             NO
     │               │
     ▼               ▼
Use Saga Engine    Consider simpler
                   solutions first
```

---

## When Try/Catch IS Enough

### 1. Single Database Transaction

```typescript
// This is fine with try/catch
async function transferFunds(from: string, to: string, amount: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

**Why try/catch works:** Everything is in one database. ROLLBACK undoes everything atomically. Process crash = connection drop = automatic rollback.

### 2. Read-Only Operations

```typescript
// This is fine with try/catch
async function generateReport(userId: string) {
  try {
    const user = await db.getUser(userId);
    const orders = await db.getOrders(userId);
    const analytics = await analytics.compute(orders);
    return formatReport(user, orders, analytics);
  } catch (error) {
    logger.error('Report generation failed', error);
    throw error;
  }
}
```

**Why try/catch works:** No side effects. If it fails, nothing was changed. Just retry.

### 3. Idempotent External Calls

```typescript
// This is fine with try/catch (if API is idempotent)
async function sendNotification(userId: string, message: string) {
  try {
    // Using idempotency key with external API
    await twilio.send(message, {
      idempotency_key: `notify-${userId}-${hash(message)}`
    });
  } catch (error) {
    logger.error('Notification failed', error);
    // Safe to retry - idempotency key prevents duplicates
  }
}
```

**Why try/catch works:** External API handles idempotency. Retry is safe.

### 4. Fast, Atomic Operations

```typescript
// This is fine with try/catch
async function updateUserProfile(userId: string, data: ProfileData) {
  try {
    await db.updateUser(userId, data);
    await cache.invalidate(`user:${userId}`);
  } catch (error) {
    // Cache inconsistency is temporary, will fix on next read
    throw error;
  }
}
```

**Why try/catch works:** Operations are fast. Crash window is tiny. Inconsistency is temporary and self-healing.

---

## When You NEED Saga Engine

### 1. Multi-Step with External Side Effects

```typescript
// This NEEDS Saga Engine
async function processOrder(order: Order) {
  // Step 1: Charge card (EXTERNAL SIDE EFFECT)
  // Step 2: Reserve inventory (MAY NEED UNDO)
  // Step 3: Create shipment (EXTERNAL SIDE EFFECT)
  // Step 4: Send confirmation email (EXTERNAL SIDE EFFECT)

  // If step 3 fails, you MUST refund and release inventory
  // Try/catch can't guarantee this if process crashes
}
```

### 2. Operations That Must Survive Crashes

```typescript
// This NEEDS Saga Engine
async function provisionInfrastructure(request: ProvisionRequest) {
  // Step 1: Create VPC (takes 30 seconds)
  // Step 2: Create EC2 instances (takes 2 minutes)
  // Step 3: Configure load balancer (takes 30 seconds)
  // Step 4: Update DNS (takes 1 minute)

  // If you crash at step 3, you have orphaned VPC and EC2s
  // On restart, you need to know what was completed
  // Try/catch has no memory across restarts
}
```

### 3. Compensation Is Complex

```typescript
// This NEEDS Saga Engine
async function bookTrip(trip: TripRequest) {
  // Step 1: Book flight (MUST compensate: cancel flight)
  // Step 2: Book hotel (MUST compensate: cancel hotel)
  // Step 3: Book car (MUST compensate: cancel car)
  // Step 4: Charge card (MUST compensate: refund)

  // Compensation order matters: refund BEFORE canceling bookings
  // Each compensation might fail and need retries
  // Try/catch can't handle this complexity reliably
}
```

---

## The "In-Between" Solutions

Sometimes you don't need full Saga Engine but try/catch isn't enough:

### 1. Idempotency Keys + Retry

```typescript
// Good enough for many cases
async function processPayment(orderId: string, amount: number) {
  const idempotencyKey = `payment-${orderId}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await stripe.charge(amount, { idempotency_key: idempotencyKey });
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}
```

### 2. Outbox Pattern

```typescript
// For guaranteed message delivery
async function createOrderWithNotification(order: Order) {
  await db.transaction(async (tx) => {
    await tx.insert('orders', order);
    await tx.insert('outbox', {
      type: 'ORDER_CREATED',
      payload: order,
    });
  });
  // Separate process reads outbox and sends notifications
}
```

### 3. Status Machine

```typescript
// For simple state tracking
async function processOrder(orderId: string) {
  await db.updateOrder(orderId, { status: 'CHARGING' });

  try {
    await stripe.charge(amount);
    await db.updateOrder(orderId, { status: 'CHARGED' });
  } catch (error) {
    await db.updateOrder(orderId, { status: 'CHARGE_FAILED' });
    throw error;
  }

  // Recovery: query for orders stuck in 'CHARGING' status
}
```

---

## Summary

| Complexity | Solution |
|------------|----------|
| Single DB, no external calls | try/catch + DB transaction |
| External calls, all idempotent | try/catch + idempotency keys |
| Need guaranteed delivery | Outbox pattern |
| Need to undo on failure | **Saga Engine** |
| Need crash recovery | **Saga Engine** |
| Multi-step with side effects | **Saga Engine** |

**The rule:** Start with try/catch. Add Saga Engine when you get burned by a partial failure in production.

---

## Real-World Decision Examples

| Scenario | Recommendation | Why |
|----------|----------------|-----|
| User signup + welcome email | Try/catch | Email failure is acceptable, can retry manually |
| E-commerce checkout | Saga Engine | Payment + inventory + shipping must be consistent |
| File upload + thumbnail | Try/catch | Can regenerate thumbnail, no side effects |
| Booking flight + hotel + car | Saga Engine | Must cancel all if any fails |
| Update user profile | Try/catch | Single operation, no side effects |
| Provision cloud resources | Saga Engine | Must clean up partial resources on failure |
| Send batch notifications | Outbox pattern | Need guaranteed delivery, not compensation |
| Transfer between banks | Saga Engine | Must handle partial failures with compensation |

---

## Further Reading

- [Saga Engine README](../README.md)
- [FAILURE_MODES.md](./FAILURE_MODES.md)
- [vs-temporal.md](./vs-temporal.md)
