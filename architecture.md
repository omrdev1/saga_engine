# Architecture

## Design Philosophy

**Misuse is mechanically harder than correct use.**

Every safety constraint is enforced in code, not documentation:
- Missing idempotency key → `IdempotencyRequiredError` (not a warning)
- Workflow > 15 minutes → `ExecutionTimeoutError` (not configurable)
- Compensation fails → `dead_letter` state (not auto-retry forever)
- Concurrent retry race → atomic `UPDATE WHERE status` (not hope)

## Core Concept: The Persistent Saga

The system is built around a `Transaction` class that maintains a persistent stack of executed steps. State is serialized to Postgres after every step completion.

Compensation is explicitly "best-effort". If compensation fails, the workflow enters terminal `dead_letter` state requiring manual intervention.

## Components

### 1. Transaction Engine (`engine/Transaction.ts`)

**Responsibility:** Orchestrates the saga workflow with safety constraints.

**Execution Flow:**
1. **Validation** - Verify idempotency key present (throws if missing)
2. **Locking** - Acquire Postgres advisory lock
3. **Deadline Setup** - Set 15-minute wall-clock deadline
4. **Resume Check** - Load previous state, skip completed steps
5. **Step Execution:**
   - Check deadline BEFORE each step (throws `ExecutionTimeoutError` if breached)
   - Execute with timeout and retry policy
   - Persist to storage AFTER success
   - Emit events throughout
6. **Compensation** (on failure):
   - Iterate completed steps in REVERSE order
   - Execute `compensate()` with retry policy
   - If compensation fails → `dead_letter` state
7. **Cleanup** - Release lock (always), update final status

**Key Methods:**
```typescript
class Transaction {
  constructor(id: string, storage: StorageAdapter, options: TransactionOptions);

  async run<T>(workflow: (t: Transaction) => Promise<T>): Promise<T>;

  async step<T>(name: string, definition: StepDefinition<T>): Promise<T>;

  private checkDeadline(): void;  // Throws ExecutionTimeoutError
  private async compensate(error: Error): Promise<void>;
}
```

### 2. Type System (`engine/types/`)

#### Errors (`engine/types/Errors.ts`)

Typed errors for every failure mode:

| Error | Code | When |
|-------|------|------|
| `ExecutionTimeoutError` | `EXECUTION_TIMEOUT` | Wall-clock exceeds 15 minutes |
| `IdempotencyRequiredError` | `IDEMPOTENCY_REQUIRED` | Missing idempotency key |
| `CompensationFailedError` | `COMPENSATION_FAILED` | Compensation threw during rollback |
| `RetryCapExceededError` | `RETRY_CAP_EXCEEDED` | Exceeded 10 retry attempts |
| `DeadLetterError` | `DEAD_LETTER` | Workflow in terminal state |

#### Workflow State (`engine/types/WorkflowState.ts`)

```typescript
type WorkflowStatus = 'pending' | 'completed' | 'failed' | 'dead_letter';

// Hard limits (non-configurable)
const MAX_EXECUTION_MS = 15 * 60 * 1000;  // 15 minutes
const MAX_ERROR_LENGTH = 2048;             // 2KB
const MAX_RETRY_COUNT = 10;                // 10 retries max

// Error truncation to prevent DB bloat
function truncateError(error: Error | string): string;
function createWorkflowError(stepName, error, compensationError?): WorkflowError;
```

### 3. Storage Layer (`engine/Storage.ts`, `engine/PostgresStorage.ts`)

**Interface:**
```typescript
interface StorageAdapter {
  readonly isProductionSafe: boolean;  // false for test adapters

  save(id: string, steps: StepRecord[], input: Record<string, unknown>): Promise<void>;
  load(id: string): Promise<StepRecord[] | null>;
  clear(id: string): Promise<void>;

  getWorkflow(id: string): Promise<WorkflowRecord | null>;
  updateStatus(id: string, status: WorkflowStatus, error?: WorkflowError): Promise<void>;
  atomicRetry(id: string): Promise<number | null>;  // Returns new retry_count or null
  queryWorkflows(query: WorkflowQuery): Promise<WorkflowRecord[]>;
}
```

**Implementations:**
| Adapter | `isProductionSafe` | Location |
|---------|-------------------|----------|
| `PostgresStorage` | `true` | `engine/PostgresStorage.ts` |
| `MemoryStorage` | `false` | `internal/testing/MemoryStorage.ts` |
| `FileStorage` | `false` | `internal/testing/FileStorage.ts` |

**PostgresStorage Schema:**
```sql
CREATE TABLE transactions (
  id VARCHAR(255) PRIMARY KEY,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  step_stack JSONB NOT NULL DEFAULT '[]',
  input JSONB NOT NULL DEFAULT '{}',
  retry_count INT NOT NULL DEFAULT 0,
  error JSONB,  -- { stepName, error, compensationError?, timestamp }
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

**Atomic Retry:**
```sql
-- Race-safe: only one concurrent caller succeeds
UPDATE transactions
SET status = 'pending', retry_count = retry_count + 1, error = NULL
WHERE id = $1 AND status = 'dead_letter'
RETURNING retry_count;
```

### 4. Locking (`engine/Lock.ts`)

**Interface:**
```typescript
interface LockAdapter {
  acquire(transactionId: string, ttlMs: number): Promise<string | null>;
  release(transactionId: string, token: string): Promise<void>;
}
```

**PostgresLock Implementation:**

Uses SHA-256 → 64-bit BigInt for Postgres advisory locks:

```typescript
private hashToLockKey(transactionId: string): bigint {
  const hash = createHash('sha256').update(transactionId).digest();
  return hash.readBigInt64BE(0);  // First 8 bytes as signed 64-bit
}

async acquire(transactionId: string): Promise<string | null> {
  const lockKey = this.hashToLockKey(transactionId);
  const result = await this.pool.query(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [lockKey.toString()]
  );
  return result.rows[0]?.acquired ? lockKey.toString() : null;
}
```

**Collision Analysis:**
- 64-bit keyspace = 2^64 = ~18 quintillion values
- Birthday paradox for 50k workflows: ~6.8e-11 probability
- Verified by `LockCollision.test.ts`: 0 collisions in 50k UUIDs

### 5. Event System (`engine/Events.ts`)

**Interface:**
```typescript
interface TransactionEvents {
  onTransactionStart?(id: string, input: Record<string, unknown>): void;
  onTransactionComplete?(id: string, result: unknown): void;
  onTransactionFailed?(id: string, error: Error): void;

  onStepStart?(name: string): void;
  onStepComplete?(name: string, result: unknown, durationMs: number): void;
  onStepFailed?(name: string, error: Error, attempt: number): void;
  onStepRetry?(name: string, attempt: number, error: Error): void;
  onStepSkipped?(name: string, cachedResult: unknown): void;
  onStepTimeout?(name: string, timeoutMs: number): void;

  onCompensationStart?(name: string): void;
  onCompensationComplete?(name: string): void;
  onCompensationFailed?(name: string, error: Error): void;

  onDeadLetter?(id: string, error: WorkflowError): void;
}
```

**Safety:** Event handler errors are caught and logged, never breaking transaction flow.

### 6. CLI Administration (`bin/saga-admin.ts`)

**Commands:**
```bash
saga-admin retry <id>         # Atomic retry (race-safe)
saga-admin retry --force <id> # Override 10-retry cap
saga-admin list <status>      # Query by status
saga-admin stats              # Status counts
```

**Retry Logic:**
1. Call `storage.atomicRetry(id)`
2. If returns `null` → workflow not in `dead_letter` or doesn't exist
3. If returns count > 10 and not `--force` → reject with `RetryCapExceededError`
4. Otherwise → success, workflow is now `pending`

### 7. Testing Infrastructure (`internal/testing/`)

| Utility | Purpose |
|---------|---------|
| `MemoryStorage` | In-memory storage for fast unit tests |
| `FileStorage` | File-based storage for integration tests |
| `MockLock` | Simulated distributed lock |
| `createEventSpy()` | Track and assert event emissions |

**Export Path:** `saga-engine/testing` (NOT main export)

## Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Transaction.run()                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Validate idempotencyKey ──────► IdempotencyRequiredError    │
│                                                                  │
│  2. Acquire lock ─────────────────► Wait or fail                │
│                                                                  │
│  3. Set deadline = now + 15min                                  │
│                                                                  │
│  4. Load previous state ──────────► Skip completed steps        │
│                                                                  │
│  5. For each step:                                              │
│     ┌──────────────────────────────────────────────────────┐    │
│     │  a. Check deadline ─────────► ExecutionTimeoutError  │    │
│     │  b. Execute with timeout/retry                       │    │
│     │  c. Persist to storage                               │    │
│     │  d. Emit events                                      │    │
│     └──────────────────────────────────────────────────────┘    │
│                                                                  │
│  6. On failure:                                                 │
│     ┌──────────────────────────────────────────────────────┐    │
│     │  For each completed step (REVERSE):                  │    │
│     │    a. Execute compensate() with retry                │    │
│     │    b. If fails → dead_letter + throw                 │    │
│     └──────────────────────────────────────────────────────┘    │
│                                                                  │
│  7. Release lock (always)                                       │
│                                                                  │
│  8. Update final status                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## State Machine

```
                    ┌───────────┐
                    │  pending  │
                    └─────┬─────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
     ┌──────────┐  ┌──────────┐  ┌─────────────┐
     │ completed│  │  failed  │  │ dead_letter │
     └──────────┘  └──────────┘  └─────────────┘
                                        │
                                        │ CLI retry
                                        ▼
                                 ┌───────────┐
                                 │  pending  │
                                 └───────────┘
```

| Transition | Condition |
|------------|-----------|
| pending → completed | All steps succeeded |
| pending → failed | Step failed + all compensations succeeded |
| pending → dead_letter | Compensation failed OR 15-min timeout |
| dead_letter → pending | CLI `saga-admin retry` (atomic) |

## File Structure

```
saga-engine/
├── engine/
│   ├── types/
│   │   ├── Errors.ts           # Typed error classes
│   │   └── WorkflowState.ts    # Status enum, constants, truncation
│   ├── Transaction.ts          # Core saga executor
│   ├── Storage.ts              # StorageAdapter interface
│   ├── PostgresStorage.ts      # Production storage
│   ├── Lock.ts                 # LockAdapter + PostgresLock
│   └── Events.ts               # Event hooks interface
│
├── internal/testing/
│   ├── MemoryStorage.ts        # Test-only storage
│   ├── FileStorage.ts          # Test-only file storage
│   ├── MockLock.ts             # Test-only lock
│   ├── EventSpy.ts             # Event assertion helper
│   └── index.ts                # Re-exports
│
├── bin/
│   └── saga-admin.ts           # CLI administration tool
│
├── test/
│   ├── LockCollision.test.ts   # 50k collision test
│   ├── PartialCompensation.test.ts
│   ├── WallClock.test.ts       # 15-min timeout test
│   ├── AtomicRetry.test.ts     # Race condition test
│   └── DataHygiene.test.ts     # Error truncation test
│
├── docs/
│   └── FAILURE_MODES.md        # Explicit failure documentation
│
├── index.ts                    # Public API (no test utilities)
├── testing.ts                  # Test utilities export
├── schema.sql                  # Database schema
└── package.json
```

## Security Considerations

1. **SQL Injection** - Table names validated against `^[a-zA-Z_][a-zA-Z0-9_]*$`
2. **Error Data** - Truncated to 2KB to prevent DB bloat attacks
3. **Lock Starvation** - Advisory locks have TTL, always released in finally block
4. **Race Conditions** - Atomic `UPDATE WHERE status` prevents concurrent retry issues
5. **Idempotency** - Required at runtime, not optional
