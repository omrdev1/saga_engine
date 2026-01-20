#!/usr/bin/env node
/**
 * Saga Engine - Admin CLI
 *
 * Operations tool for managing workflows, especially dead_letter recovery.
 *
 * Usage:
 *   npx saga-admin <command> [options]
 *
 * Commands:
 *   retry <txId>     Retry a dead_letter workflow (atomic, race-safe)
 *   status <txId>    Show workflow status and details
 *   list [status]    List workflows by status
 *   stats            Show workflow statistics
 *
 * Options:
 *   --force          Override retry cap (10 attempts)
 *   --table <name>   Custom table name (default: transactions)
 *
 * Environment:
 *   DATABASE_URL     PostgreSQL connection string (required)
 *
 * @example
 *   # Retry a dead_letter workflow
 *   DATABASE_URL=postgres://... npx saga-admin retry order-123
 *
 *   # Force retry after hitting cap
 *   DATABASE_URL=postgres://... npx saga-admin retry --force order-123
 *
 *   # List all dead_letter workflows
 *   DATABASE_URL=postgres://... npx saga-admin list dead_letter
 */

import { Pool } from 'pg';
import { PostgresStorage } from '../engine/PostgresStorage';
import { MAX_RETRY_COUNT } from '../engine/types/WorkflowState';
import { RetryCapExceededError } from '../engine/types/Errors';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logError(message: string) {
  console.error(`${colors.red}Error: ${message}${colors.reset}`);
}

function logSuccess(message: string) {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

function logWarning(message: string) {
  console.log(`${colors.yellow}⚠ ${message}${colors.reset}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  // Check DATABASE_URL
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logError('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  // Parse options
  const forceFlag = args.includes('--force') || args.includes('-f');
  const tableIndex = args.indexOf('--table');
  const tableName = tableIndex !== -1 ? args[tableIndex + 1] : 'transactions';

  // Remove flags from args
  const cleanArgs = args.filter(
    (a, i) =>
      a !== '--force' &&
      a !== '-f' &&
      a !== '--table' &&
      (tableIndex === -1 || i !== tableIndex + 1)
  );

  const command = cleanArgs[0];
  const commandArgs = cleanArgs.slice(1);

  // Initialize storage
  const pool = new Pool({ connectionString });
  const storage = new PostgresStorage(pool, tableName);

  try {
    switch (command) {
      case 'retry':
        await cmdRetry(storage, commandArgs[0], forceFlag);
        break;
      case 'status':
        await cmdStatus(storage, commandArgs[0]);
        break;
      case 'list':
        await cmdList(storage, commandArgs[0] as any);
        break;
      case 'stats':
        await cmdStats(storage);
        break;
      default:
        logError(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Retry a dead_letter workflow atomically.
 *
 * Uses atomic UPDATE ... WHERE status = 'dead_letter' to prevent race conditions.
 * Two concurrent CLI retries will result in only one increment.
 */
async function cmdRetry(storage: PostgresStorage, txId: string, force: boolean) {
  if (!txId) {
    logError('Transaction ID required');
    console.log('Usage: saga-admin retry <txId> [--force]');
    process.exit(1);
  }

  // First check current state
  const workflow = await storage.getWorkflow(txId);

  if (!workflow) {
    logError(`Transaction '${txId}' not found`);
    process.exit(1);
  }

  if (workflow.status !== 'dead_letter') {
    logError(`Transaction '${txId}' is not in dead_letter state (current: ${workflow.status})`);
    process.exit(1);
  }

  // Check retry cap
  if (workflow.retryCount >= MAX_RETRY_COUNT && !force) {
    logError(
      `Transaction '${txId}' has been retried ${workflow.retryCount} times (max: ${MAX_RETRY_COUNT}). ` +
        `Use --force to override.`
    );
    process.exit(1);
  }

  // Atomic retry
  const newCount = await storage.atomicRetry(txId);

  if (newCount === null) {
    logWarning(
      `Transaction '${txId}' was already retried by another process (race condition handled).`
    );
    process.exit(0);
  }

  logSuccess(`Transaction '${txId}' reset to pending (retry count: ${newCount})`);
  log(`\nNext steps:`, colors.gray);
  log(`  1. Fix the root cause of the failure`, colors.gray);
  log(`  2. Re-run your workflow processor`, colors.gray);
  log(`  3. The workflow will resume from its last checkpoint`, colors.gray);
}

/**
 * Show workflow status and details
 */
async function cmdStatus(storage: PostgresStorage, txId: string) {
  if (!txId) {
    logError('Transaction ID required');
    console.log('Usage: saga-admin status <txId>');
    process.exit(1);
  }

  const workflow = await storage.getWorkflow(txId);

  if (!workflow) {
    logError(`Transaction '${txId}' not found`);
    process.exit(1);
  }

  // Status color
  const statusColors: Record<string, string> = {
    pending: colors.yellow,
    completed: colors.green,
    failed: colors.red,
    dead_letter: colors.red + colors.bold,
  };

  console.log();
  log(`Transaction: ${workflow.id}`, colors.bold);
  log(`Status: ${workflow.status}`, statusColors[workflow.status] || colors.reset);
  log(`Retry Count: ${workflow.retryCount}`);
  log(`Created: ${workflow.createdAt.toISOString()}`);
  log(`Updated: ${workflow.updatedAt.toISOString()}`);

  if (workflow.error) {
    console.log();
    log(`Error:`, colors.red);
    log(`  Step: ${workflow.error.stepName}`, colors.gray);
    log(`  Message: ${workflow.error.error}`, colors.gray);
    if (workflow.error.compensationError) {
      log(`  Compensation Error: ${workflow.error.compensationError}`, colors.gray);
    }
    log(`  Timestamp: ${workflow.error.timestamp}`, colors.gray);
  }

  if (workflow.stepStack.length > 0) {
    console.log();
    log(`Completed Steps:`, colors.blue);
    workflow.stepStack.forEach((step, i) => {
      log(`  ${i + 1}. ${step.name} ${colors.green}✓${colors.reset}`, colors.gray);
    });
  }

  if (workflow.input && Object.keys(workflow.input).length > 0) {
    console.log();
    log(`Input:`, colors.blue);
    log(`  ${JSON.stringify(workflow.input, null, 2).split('\n').join('\n  ')}`, colors.gray);
  }

  console.log();
}

/**
 * List workflows by status
 */
async function cmdList(
  storage: PostgresStorage,
  status?: 'pending' | 'completed' | 'failed' | 'dead_letter'
) {
  const filter = status ? { status, limit: 100 } : { limit: 100 };
  const result = await storage.query(filter);

  if (result.workflows.length === 0) {
    log(`No workflows found${status ? ` with status '${status}'` : ''}`);
    return;
  }

  console.log();
  log(`Workflows (${result.total} total, showing ${result.workflows.length}):`, colors.bold);
  console.log();

  // Table header
  console.log(
    `${'ID'.padEnd(30)} ${'Status'.padEnd(12)} ${'Retry'.padEnd(6)} ${'Updated'.padEnd(24)}`
  );
  console.log('-'.repeat(80));

  // Status colors
  const statusColors: Record<string, string> = {
    pending: colors.yellow,
    completed: colors.green,
    failed: colors.red,
    dead_letter: colors.red,
  };

  for (const wf of result.workflows) {
    const id = wf.id.length > 28 ? wf.id.slice(0, 28) + '..' : wf.id.padEnd(30);
    const stat = `${statusColors[wf.status]}${wf.status.padEnd(12)}${colors.reset}`;
    const retry = wf.retryCount.toString().padEnd(6);
    const updated = wf.updatedAt.toISOString().slice(0, 19).padEnd(24);

    console.log(`${id} ${stat} ${retry} ${updated}`);
  }

  console.log();
}

/**
 * Show workflow statistics
 */
async function cmdStats(storage: PostgresStorage) {
  const [pending, completed, failed, deadLetter] = await Promise.all([
    storage.countByStatus('pending'),
    storage.countByStatus('completed'),
    storage.countByStatus('failed'),
    storage.countByStatus('dead_letter'),
  ]);

  const total = pending + completed + failed + deadLetter;

  console.log();
  log(`Workflow Statistics`, colors.bold);
  console.log();
  log(`  Total:       ${total}`);
  log(`  Pending:     ${pending}`, colors.yellow);
  log(`  Completed:   ${completed}`, colors.green);
  log(`  Failed:      ${failed}`, colors.red);
  log(`  Dead Letter: ${deadLetter}`, deadLetter > 0 ? colors.red + colors.bold : colors.gray);
  console.log();

  if (deadLetter > 0) {
    logWarning(`${deadLetter} workflow(s) require manual intervention.`);
    log(`  Run: saga-admin list dead_letter`, colors.gray);
    console.log();
  }
}

function printHelp() {
  console.log(`
${colors.bold}Saga Engine Admin CLI${colors.reset}

Usage:
  saga-admin <command> [options]

Commands:
  ${colors.blue}retry${colors.reset} <txId>     Retry a dead_letter workflow (atomic, race-safe)
  ${colors.blue}status${colors.reset} <txId>    Show workflow status and details
  ${colors.blue}list${colors.reset} [status]    List workflows by status
  ${colors.blue}stats${colors.reset}            Show workflow statistics

Options:
  --force, -f      Override retry cap (${MAX_RETRY_COUNT} attempts)
  --table <name>   Custom table name (default: transactions)
  --help, -h       Show this help

Environment:
  DATABASE_URL     PostgreSQL connection string (required)

Examples:
  # Retry a dead_letter workflow
  DATABASE_URL=postgres://... saga-admin retry order-123

  # Force retry after hitting cap
  DATABASE_URL=postgres://... saga-admin retry --force order-123

  # List all dead_letter workflows
  DATABASE_URL=postgres://... saga-admin list dead_letter

  # Show statistics
  DATABASE_URL=postgres://... saga-admin stats
`);
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
