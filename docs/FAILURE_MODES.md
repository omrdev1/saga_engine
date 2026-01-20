# Saga Engine - Failure Modes

This document explicitly describes how Saga Engine behaves in various failure scenarios.
Read this before using Saga Engine in production.

---

## What We Guarantee

1. **Step persistence before proceeding** - Completed steps are persisted to Postgres atomically before the next step begins.

2. **Compensation triggered on failure** - If step N fails, steps 1..N-1 have their `compensate()` functions called in reverse order.

3. **Resumption skips completed steps** - If your process crashes and restarts, completed steps are skipped based on persisted state.

4. **15-minute wall-clock limit enforced** - If a workflow exceeds 15 minutes (including downtime), it enters `dead_letter` state.

5. **Idempotency enforced** - Transaction and step idempotency keys are required. Missing keys throw `IdempotencyRequiredError`.

6. **Locking prevents concurrent execution** - Two workers cannot execute the same transaction simultaneously.

---

## What We Do NOT Guarantee

### 1. Compensation Success

**Failure mode:** Your `compensate()` function fails after all retry attempts.

**Result:** Workflow enters `dead_letter` state.

**What happens:**
```
Step 1: execute() ✓
Step 2: execute() ✓
Step 3: execute() ✗ (fails)
Step 2: compensate() ✓
Step 1: compensate() ✗ (fails)
→ Workflow moves to dead_letter
```

**Remediation:**
1. Alert fires for `dead_letter` workflows
2. Human investigates root cause
3. Fix the issue (data corruption, external service, etc.)
4. Run `npx saga-admin retry <txId>`

---

### 2. External Consistency

**Failure mode:** You call Stripe, it succeeds, then your process crashes before persisting.

**Result:** Stripe was charged, but Saga Engine doesn't know about it.

**What happens:**
```
Step 1: stripe.charge() → succeeds (Stripe has the money)
Process crashes before persistence
→ Step 1 will re-execute on restart
→ Stripe may charge again (double charge)
```

**Prevention:**
Always use external idempotency keys:
```typescript
await t.step('charge-payment', {
  idempotencyKey: `order-${orderId}:charge`,
  execute: () => stripe.charge(amount, {
    idempotency_key: `order-${orderId}:charge`  // ← External idempotency
  }),
  compensate: (charge) => stripe.refund(charge.id),
});
```

---

### 3. Exactly-Once Across Process Boundary

**Failure mode:** You expect Saga Engine to guarantee exactly-once delivery to external services.

**Result:** It cannot. This is fundamentally impossible without two-phase commit.

**Reality:**
- Saga Engine provides **at-least-once** semantics within a workflow
- External calls may be executed **1 or more times** on crash recovery
- You MUST use idempotency keys with external APIs

**The rule:** If you call an external service, you are responsible for idempotency.

---

### 4. Long-Running Workflows

**Failure mode:** Your workflow takes more than 15 minutes.

**Result:** `ExecutionTimeoutError` thrown, workflow enters `dead_letter`.

**The limit:**
```
15 minutes wall-clock time
├── Includes execution time
├── Includes downtime (crash + restart)
└── Non-configurable
```

**Why:**
- Long workflows are a different problem (use Temporal)
- Bounded execution makes reasoning about failures tractable
- Prevents zombie workflows consuming resources

**If you need > 15 minutes:** Use Temporal, Inngest, or another long-running workflow system.

---

### 5. Distributed Transactions

**Failure mode:** You expect ACID semantics across multiple services.

**Result:** Saga Engine is a Saga, not XA. It provides eventual consistency, not atomicity.

**What Saga Engine is:**
```
Service A ──┬── Service B ──┬── Service C
            │ (compensate)  │ (compensate)
            └───────────────┴───────────────→ Best-effort rollback
```

**What Saga Engine is NOT:**
```
BEGIN DISTRIBUTED TRANSACTION
  UPDATE service_a
  UPDATE service_b
  UPDATE service_c
COMMIT (atomic)
```

---

### 6. Infinite Retry

**Failure mode:** You expect compensation to retry forever.

**Result:** Compensation retries according to policy, then gives up.

**The limit:**
```typescript
compensationPolicy: {
  retry: { attempts: 3, backoffMs: 1000 },  // Max 3 attempts
}
```

After exhaustion: Workflow enters `dead_letter`.

**Why:** Infinite retry causes:
- Resource exhaustion
- Queue backpressure
- Masked bugs

**The philosophy:** Fail loudly, investigate, fix, retry manually.

---

## Terminal States

| Status | Meaning | Recovery |
|--------|---------|----------|
| `completed` | Workflow succeeded | None needed |
| `failed` | Workflow failed, compensation succeeded | Log/alert, investigate |
| `dead_letter` | Workflow failed, compensation failed | `saga-admin retry` |

**`dead_letter` is TERMINAL:**
- No API methods can resume it
- Requires human intervention via CLI
- Step stack is preserved for debugging

---

## Error Scenarios Matrix

| Scenario | What Happens | Your Action |
|----------|--------------|-------------|
| Step fails, compensation succeeds | Status: `failed` | Check logs |
| Step fails, compensation fails | Status: `dead_letter` | `saga-admin retry` |
| Timeout during execute | Compensation triggered | May need investigation |
| Timeout during compensate | Status: `dead_letter` | `saga-admin retry` |
| Wall-clock exceeded | Status: `dead_letter` | Fix root cause, retry |
| Process crash mid-step | Resume on restart | Ensure external idempotency |
| Process crash mid-compensate | Resume on restart | May need manual cleanup |
| Two workers same txId | One gets lock, other throws | Working as intended |

---

## Monitoring Recommendations

### 1. Alert on `dead_letter`

```sql
SELECT COUNT(*) FROM transactions WHERE status = 'dead_letter';
```

Alert if > 0. These require human attention.

### 2. Alert on old `pending`

```sql
SELECT * FROM transactions
WHERE status = 'pending'
AND updated_at < NOW() - INTERVAL '15 minutes';
```

These are likely stuck or crashed.

### 3. Track retry counts

```sql
SELECT id, retry_count FROM transactions
WHERE retry_count > 3;
```

High retry counts indicate systemic issues.

---

## When NOT to Use Saga Engine

| Scenario | Use Instead |
|----------|-------------|
| Workflows > 15 minutes | Temporal |
| Exactly-once external delivery | Outbox pattern + Debezium |
| Job queues | BullMQ, Inngest |
| Cron scheduling | node-cron, Inngest |
| Enterprise orchestration | Temporal, Conductor |
| ACID across services | Distributed transactions (if you must) |

---

## Summary

Saga Engine is honest about what it can and cannot do:

- **It CAN:** Crash recovery, compensation, resumption, idempotency enforcement
- **It CANNOT:** Guarantee compensation success, external consistency, exactly-once delivery

If a junior engineer misuses this library and causes an incident, you can point to this document and the runtime errors:

| Misuse | Enforcement |
|--------|-------------|
| No idempotency key | `IdempotencyRequiredError` |
| Workflow > 15 min | `ExecutionTimeoutError` |
| Expected undo = guaranteed | API is literally named `compensate` |
| Expected exactly-once external | This document, line 45 |

**The rule:** If you're not sure if Saga Engine handles your case, assume it doesn't.
