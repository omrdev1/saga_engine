# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-01-20

### Launch

Initial public release of `saga-engine`.

**Core Features:**
- Postgres-backed durability with ACID guarantees
- SHA-256 advisory locking for concurrent execution prevention
- 15-minute wall-clock execution limit (non-configurable)
- Required idempotency keys at Transaction AND Step level
- Best-effort compensation with configurable retry policies
- Terminal `dead_letter` state for failed compensations

**Error Types:**
- `ExecutionTimeoutError` - Workflow exceeded 15-minute limit
- `IdempotencyRequiredError` - Missing idempotency key
- `CompensationFailedError` - Compensation threw during rollback
- `RetryCapExceededError` - Exceeded 10-retry limit
- `DeadLetterError` - Workflow in terminal state

**API:**
- `Transaction` - Core workflow executor with `tx.run(async (t) => { ... })` pattern
- `PostgresStorage` - Production storage adapter
- `PostgresLock` - Distributed locking via Postgres advisory locks
- `TransactionEvents` - 13 observability hooks for monitoring integration

**CLI Tooling (`saga-admin`):**
- `saga-admin retry <id>` - Atomic retry of dead_letter workflows
- `saga-admin retry --force <id>` - Override 10-retry cap
- `saga-admin list <status>` - Query workflows by status
- `saga-admin stats` - Workflow statistics

**Testing Utilities** (via `saga-engine/testing`):
- `MemoryStorage` - In-memory storage for unit tests
- `MockLock` - Simulated locking for isolated tests
- `createEventSpy()` - Event tracking helper

**Documentation:**
- Comprehensive README with usage examples
- [FAILURE_MODES.md](docs/FAILURE_MODES.md) - Explicit failure semantics
- Comparison docs for Temporal, DBOS, and try/catch alternatives

[1.0.0]: https://github.com/Grafikui/saga-engine/releases/tag/v1.0.0
