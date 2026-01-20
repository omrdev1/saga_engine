-- Saga Engine Schema
-- Run this in your Postgres database

CREATE TABLE IF NOT EXISTS transactions (
  -- Primary key: Transaction ID
  id VARCHAR(255) PRIMARY KEY,

  -- Workflow status: 'pending', 'completed', 'failed', 'dead_letter'
  -- TERMINAL states: completed, failed, dead_letter
  -- dead_letter has NO API recovery - use saga-admin CLI only
  status VARCHAR(50) NOT NULL DEFAULT 'pending',

  -- The "Checkpoint": Array of completed step names & results
  -- Format: [{ name: string, idempotencyKey: string, result: any, status: 'completed' }]
  step_stack JSONB NOT NULL DEFAULT '[]',

  -- Immutable original input (for replay/debugging)
  -- Stored on first save, never modified
  input JSONB NOT NULL DEFAULT '{}',

  -- Safety cap for dead_letter retries (max: 10)
  -- Incremented by saga-admin retry command
  retry_count INT NOT NULL DEFAULT 0,

  -- Error context if status is 'failed' or 'dead_letter'
  -- Format: { stepName: string, error: string, compensationError?: string, timestamp: string }
  -- Error messages are truncated to 2KB for data hygiene
  error JSONB,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Performance Indexes
-- Fast lookups by status (for monitoring/alerting)
CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions(status);

-- Fast lookups by update time (for stale detection)
CREATE INDEX IF NOT EXISTS idx_transactions_updated_at
  ON transactions(updated_at);

-- GIN index for querying specific error types or failed steps
-- Enables queries like: WHERE error->>'stepName' = 'charge-payment'
CREATE INDEX IF NOT EXISTS idx_transactions_error
  ON transactions USING GIN (error);

-- Composite index for status + updated_at (common query pattern)
CREATE INDEX IF NOT EXISTS idx_transactions_status_updated
  ON transactions(status, updated_at DESC);
