# Saga Engine - FAQ (Frequently Attacked Questions)

This document pre-emptively answers common criticisms and doubts about Saga Engine.
If you're evaluating this library, read this first.

---

## Architecture Challenges

### "Why not just use database transactions?"

**Short answer:** Database transactions don't cross service boundaries.

**Long answer:**

```
Your workflow:
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Stripe    │ → │  Twilio     │ → │  Shippo     │
│  (payment)  │    │  (SMS)      │    │  (shipping) │
└─────────────┘    └─────────────┘    └─────────────┘
      ↑                   ↑                  ↑
      └───────── These are NOT in your database ─────────┘
```

Database transactions (BEGIN/COMMIT) only work within a single database. The moment you call Stripe, send an SMS, or create a shipment, you've left the transaction boundary.

**If step 3 fails, how do you undo steps 1 and 2?**

- Database transactions: Can't. They only see your database.
- Saga Engine: Calls `compensate()` on each completed step.

**When to use database transactions instead:**
- All operations are within a single database
- No external API calls
- No side effects outside the database

---

### "Why not just use the outbox pattern?"

**Short answer:** Different problems.

| Pattern | Solves | Doesn't Solve |
|---------|--------|---------------|
| Outbox | "Message was sent reliably" | "Undo if later step fails" |
| Saga | "Undo if later step fails" | "Message delivery guarantee" |

**Outbox pattern:**
```
1. Write to database (including outbox table)
2. Separate process reads outbox, sends messages
3. Guarantees: Message WILL be sent eventually
```

**Saga pattern:**
```
1. Execute step 1
2. Execute step 2
3. Step 3 fails
4. Compensate step 2
5. Compensate step 1
6. Guarantees: Previous steps WILL be compensated
```

**Use outbox when:** You need guaranteed message delivery to a queue/topic.

**Use Saga Engine when:** You need to undo previous steps if later steps fail.

**Use both when:** You need guaranteed delivery AND compensation.

---

### "Why not just use try/catch?"

**Short answer:** Try/catch doesn't survive process crashes.

```typescript
// try/catch approach
try {
  const charge = await stripe.charge(amount);
  const shipment = await shipping.create(address);  // ← Process crashes here
  const notification = await twilio.send(message);
} catch (error) {
  // This never runs if process crashed
  await stripe.refund(charge.id);  // ← Never executed
}
```

**What happens on crash:**
1. Stripe was charged
2. Shipment was created
3. Process crashed
4. No refund, no cancellation
5. Customer charged, no product shipped (or double-shipped on restart)

**Saga Engine approach:**
```typescript
await tx.run(async (t) => {
  const charge = await t.step('charge', {
    execute: () => stripe.charge(amount),
    compensate: (ch) => stripe.refund(ch.id),  // ← Persisted, will run on restart
  });

  // Process crashes here...
  // On restart: charge is in step_stack, compensate() will be called
});
```

**Use try/catch when:**
- Operations are fast and unlikely to crash mid-execution
- No external side effects
- Failure is acceptable

**Use Saga Engine when:**
- Operations have external side effects (payments, emails, etc.)
- Process crashes are possible (they always are)
- Partial completion is dangerous

---

### "Postgres advisory locks don't scale"

**Short answer:** Correct. We're not trying to scale to millions.

**The math:**

| Concurrent Workflows | Lock Acquisition Time | Collision Probability |
|---------------------|----------------------|----------------------|
| 100 | < 1ms | ~0 |
| 1,000 | < 5ms | ~0 |
| 10,000 | ~10-50ms | ~1e-15 |
| 100,000 | You need Temporal | - |

**Our design point:** < 1,000 concurrent workflows per Postgres instance.

**If you need more:**
1. Shard by tenant/region across multiple databases
2. Use Temporal (designed for massive scale)
3. Accept that you've outgrown a library solution

**Why we chose advisory locks:**
- Zero additional infrastructure (no Redis, no Zookeeper)
- Automatic cleanup on connection drop
- Good enough for 99% of use cases

---

### "15 minutes is arbitrary"

**Short answer:** It's opinionated, not arbitrary.

**The reasoning:**

1. **Bounded failure modes:** If a workflow can run forever, debugging is impossible. "It's been running for 3 days" is not actionable.

2. **Resource management:** Long-running workflows hold locks, connections, memory. Bounding execution prevents resource exhaustion.

3. **Clear upgrade path:** If you hit 15 minutes, you need Temporal. This is a feature, not a bug. We're telling you when to upgrade.

4. **Wall-clock, not CPU time:** The 15 minutes includes downtime. If your server crashes and restarts 10 minutes later, you have 5 minutes left. This prevents zombie workflows.

**Why not configurable?**
- Configuration creates support burden ("I set it to 24 hours and now...")
- Forces architectural decisions upfront
- Keeps the library simple

**If you need > 15 minutes:** Use Temporal. Seriously. It's designed for that.

---

## Comparison Challenges

### "Just use Temporal"

**Short answer:** Agreed, if you need Temporal's features.

| Need | Saga Engine | Temporal |
|------|-------------|----------|
| Workflows < 15 min | ✅ | ✅ (overkill) |
| Workflows > 15 min | ❌ | ✅ |
| Zero infrastructure | ✅ | ❌ (needs cluster) |
| Durable sleep/timers | ❌ | ✅ |
| Complex orchestration | ❌ | ✅ |
| Compensation/rollback | ✅ (native) | ⚠️ (manual) |

**Use Temporal when:**
- Workflows run for hours/days/weeks
- You need durable timers
- You have DevOps capacity for the cluster
- You're doing complex orchestration

**Use Saga Engine when:**
- Workflows complete in < 15 minutes
- You want zero infrastructure
- You need native compensation
- Temporal is overkill

**The honest truth:** Temporal is more powerful. Saga Engine is simpler. Pick based on your needs, not hype.

---

### "DBOS does more"

**Short answer:** DBOS is a platform. Saga Engine is a library.

| Aspect | Saga Engine | DBOS |
|--------|-------------|------|
| Type | Library | Platform/Runtime |
| Compensation | Native `compensate()` | Manual |
| Idempotency | Required (enforced) | Optional (decorators) |
| Infrastructure | Your Postgres | DBOS runtime required |
| Time limit | 15 min (hard) | None |
| Failure state | Explicit `dead_letter` | Implicit |

**DBOS advantages:**
- No time limit
- Built-in scheduling
- Durable sleep
- Web dashboard

**Saga Engine advantages:**
- Native compensation (DBOS has none)
- Enforced idempotency (DBOS makes it optional)
- No runtime dependency
- Explicit failure states

**The key difference:** DBOS replays forward. Saga Engine can roll backward.

---

### "It's just try/catch with extra steps"

**Short answer:** Try/catch with persistence, compensation, and crash recovery.

**Those "extra steps" are:**

1. **Persistence** - State survives process crashes
2. **Compensation** - Previous steps are undone on failure
3. **Resumption** - Completed steps are skipped on restart
4. **Idempotency enforcement** - Runtime validation
5. **Timeout protection** - 15-minute hard limit
6. **Locking** - No concurrent execution of same workflow
7. **Observability** - 13 event hooks

**If you don't need these:** Use try/catch. Seriously.

**If you do need these:** That's why Saga Engine exists.

---

## Safety Challenges

### "Compensation isn't guaranteed"

**Short answer:** Correct. We call it `compensate`, not `undo`.

**What we guarantee:**
- `compensate()` WILL be called for completed steps
- `compensate()` WILL be retried according to policy
- State WILL be preserved for debugging

**What we don't guarantee:**
- `compensate()` will succeed
- External systems will cooperate
- The universe will be fair

**When compensation fails:**
1. Workflow enters `dead_letter` state
2. Step stack is preserved
3. Error details recorded
4. Human investigates
5. `saga-admin retry` when fixed

**This is intentional.** Pretending compensation always works creates false confidence. We'd rather fail loudly.

---

### "What if the database goes down?"

**Short answer:** Your workflow fails. That's correct behavior.

**Scenario:**
```
1. Step 1 completes, persisted
2. Step 2 completes, persisted
3. Database goes down
4. Step 3 cannot persist
5. Workflow fails
```

**This is good because:**
- We don't proceed without persistence
- No silent data loss
- Clear failure mode

**What you should do:**
- Use a managed Postgres with high availability
- Monitor database health
- Have alerting on connection failures

**What we don't do:**
- Buffer writes (loses durability guarantee)
- Retry indefinitely (causes backpressure)
- Pretend it didn't happen

---

### "Advisory locks can be stolen"

**Short answer:** No, they can't. But they can be released on disconnect.

**How Postgres advisory locks work:**
```sql
-- Session 1
SELECT pg_try_advisory_lock(123);  -- Returns true, lock acquired

-- Session 2
SELECT pg_try_advisory_lock(123);  -- Returns false, lock held by session 1

-- Session 1 disconnects (crash, network, etc.)
-- Lock is automatically released

-- Session 2 (or anyone)
SELECT pg_try_advisory_lock(123);  -- Returns true, lock available
```

**The "theft" scenario:**
1. Worker 1 acquires lock
2. Worker 1's connection drops (but process continues briefly)
3. Worker 2 acquires lock
4. Both workers execute same workflow

**Our mitigation:**
- Lock token verification
- Short lock TTL with renewal
- Idempotency keys prevent duplicate side effects

**The reality:** This is extremely rare. If it happens:
- Idempotency keys prevent double-charging
- One worker will fail on persistence (duplicate key)
- Alert, investigate, move on

---

## Philosophy Challenges

### "Why so opinionated?"

**Short answer:** Opinions prevent foot-guns.

**Every opinion is a prevented bug:**

| Opinion | Prevented Bug |
|---------|---------------|
| Idempotency required | Forgot the key, double-charged customer |
| 15-minute limit | Workflow ran for 3 days, no one noticed |
| Postgres only | Used Redis, lost data on restart |
| `compensate` not `undo` | Expected guaranteed rollback, got best-effort |
| `dead_letter` terminal | Expected auto-recovery, data corrupted |

**The alternative:**
```typescript
// "Flexible" library
const tx = new Transaction('id', storage, {
  idempotencyKey: undefined,      // Optional, easy to forget
  timeout: Infinity,              // No limit, can run forever
  autoRetryDeadLetter: true,      // Mask failures
  storage: new RedisStorage(),    // Lose data on crash
});
```

**Flexibility is not always a feature.** Sometimes it's a support burden.

---

### "No dashboard is a dealbreaker"

**Short answer:** Query Postgres directly.

```sql
-- Dashboard equivalent queries

-- Workflow status overview
SELECT status, COUNT(*) FROM transactions GROUP BY status;

-- Dead letters requiring attention
SELECT id, error, created_at FROM transactions
WHERE status = 'dead_letter' ORDER BY created_at DESC;

-- Stuck workflows
SELECT * FROM transactions
WHERE status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes';

-- Recent failures
SELECT id, error->>'stepName', error->>'error' FROM transactions
WHERE status IN ('failed', 'dead_letter')
ORDER BY updated_at DESC LIMIT 20;
```

**Why no dashboard:**
1. Dashboards are maintenance burden
2. Everyone wants different visualizations
3. Your existing monitoring tools can query Postgres
4. Grafana/Datadog/etc. do this better than we would

**If you need a dashboard:** Build one with your existing tools, or wait for community contribution.

---

### "Why not just use [insert technology]?"

**Decision tree:**

```
Do you need workflows > 15 minutes?
├── Yes → Use Temporal
└── No ↓

Do you need job queues?
├── Yes → Use BullMQ
└── No ↓

Do you need scheduling/cron?
├── Yes → Use node-cron or Inngest
└── No ↓

Do you need distributed transactions (XA)?
├── Yes → Reconsider your architecture
└── No ↓

Do you need multi-step operations with rollback?
├── Yes → Use Saga Engine
└── No → Use try/catch
```

**We're not trying to replace everything.** We solve one specific problem well.

---

## Summary

**Saga Engine is for:**
- Multi-step workflows with side effects
- Operations that need compensation on failure
- Workflows that complete in < 15 minutes
- Teams that want zero infrastructure

**Saga Engine is NOT for:**
- Long-running workflows (use Temporal)
- Job queues (use BullMQ)
- Scheduling (use node-cron)
- Exactly-once external delivery (use outbox pattern)

**If you're still unsure:** Use try/catch first. When you get burned by a partial failure in production, come back.
