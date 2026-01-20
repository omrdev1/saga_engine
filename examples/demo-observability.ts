/**
 * Observability & Monitoring Example
 *
 * This example demonstrates the new v0.2.1 features:
 * - Event hooks for observability
 * - Step timeouts
 * - Integration with monitoring systems
 *
 * Usage:
 *   npm run example:observability
 */

import { Transaction, FileStorage, TransactionEvents } from '../index';

// Simulate a simple metrics collection system
class MetricsCollector {
  private metrics: any[] = [];

  recordStepDuration(stepName: string, durationMs: number) {
    this.metrics.push({
      type: 'step_duration',
      step: stepName,
      duration: durationMs,
      timestamp: new Date().toISOString()
    });
    console.log(`  📊 [Metrics] Step '${stepName}' took ${durationMs}ms`);
  }

  recordStepFailure(stepName: string, error: Error, attempt: number) {
    this.metrics.push({
      type: 'step_failure',
      step: stepName,
      error: error.message,
      attempt,
      timestamp: new Date().toISOString()
    });
    console.log(`  📊 [Metrics] Step '${stepName}' failed (attempt ${attempt}): ${error.message}`);
  }

  recordTransactionDuration(transactionId: string, durationMs: number) {
    this.metrics.push({
      type: 'transaction_duration',
      id: transactionId,
      duration: durationMs,
      timestamp: new Date().toISOString()
    });
    console.log(`  📊 [Metrics] Transaction completed in ${durationMs}ms`);
  }

  getMetrics() {
    return this.metrics;
  }
}

// Simulate a logging system
class Logger {
  info(message: string, context?: any) {
    console.log(`  ℹ️  [Logger] ${message}`, context ? JSON.stringify(context) : '');
  }

  warn(message: string, context?: any) {
    console.warn(`  ⚠️  [Logger] ${message}`, context ? JSON.stringify(context) : '');
  }

  error(message: string, context?: any) {
    console.error(`  ❌ [Logger] ${message}`, context ? JSON.stringify(context) : '');
  }
}

// Simulate an alerting system
class AlertingSystem {
  sendAlert(severity: 'info' | 'warning' | 'critical', message: string) {
    const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`  ${emoji} [Alert: ${severity.toUpperCase()}] ${message}`);
  }
}

async function runWithObservability() {
  const storage = new FileStorage();
  const metrics = new MetricsCollector();
  const logger = new Logger();
  const alerting = new AlertingSystem();

  // Configure event hooks for observability
  const events: TransactionEvents = {
    onTransactionStart: (transactionId) => {
      logger.info('Transaction started', { transactionId });
    },

    onTransactionComplete: (transactionId, durationMs) => {
      logger.info('Transaction completed successfully', { transactionId, durationMs });
      metrics.recordTransactionDuration(transactionId, durationMs);
    },

    onTransactionFailed: (transactionId, error) => {
      logger.error('Transaction failed', { transactionId, error: error.message });
      alerting.sendAlert('critical', `Transaction ${transactionId} failed: ${error.message}`);
    },

    onStepStart: (stepName, transactionId) => {
      logger.info(`Step started: ${stepName}`, { transactionId });
    },

    onStepComplete: (stepName, result, durationMs) => {
      logger.info(`Step completed: ${stepName}`, { durationMs });
      metrics.recordStepDuration(stepName, durationMs);
    },

    onStepFailed: (stepName, error, attempt) => {
      logger.warn(`Step failed: ${stepName}`, { error: error.message, attempt });
      metrics.recordStepFailure(stepName, error, attempt);

      if (attempt >= 3) {
        alerting.sendAlert('warning', `Step ${stepName} exhausted all retries`);
      }
    },

    onStepRetry: (stepName, attempt, maxAttempts) => {
      logger.warn(`Retrying step: ${stepName}`, { attempt, maxAttempts });
    },

    onStepTimeout: (stepName, timeoutMs) => {
      logger.error(`Step timeout: ${stepName}`, { timeoutMs });
      alerting.sendAlert('critical', `Step ${stepName} timed out after ${timeoutMs}ms`);
    },

    onCompensationStart: (stepName, transactionId) => {
      logger.info(`Compensation started: ${stepName}`, { transactionId });
    },

    onCompensationComplete: (stepName, durationMs) => {
      logger.info(`Compensation completed: ${stepName}`, { durationMs });
    },

    onCompensationFailed: (stepName, error) => {
      logger.error(`Compensation failed: ${stepName}`, { error: error.message });
      alerting.sendAlert('critical', `Failed to compensate ${stepName}: ${error.message}`);
    }
  };

  console.log('\n🔍 Example 1: Successful workflow with observability\n');
  console.log('─'.repeat(60));

  const tx1 = new Transaction('observable-workflow-1', storage, {
    events,
    cleanupOnSuccess: true
  });

  await tx1.run(async (t) => {
    await t.step('fetch-user-data', {
      do: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { userId: '123', name: 'Alice' };
      },
      undo: async () => {},
      timeout: 500
    });

    await t.step('process-payment', {
      do: async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return { paymentId: 'pay_456', amount: 99.99 };
      },
      undo: async (result) => {
        console.log(`  🔄 Refunding payment: ${result.paymentId}`);
      },
      timeout: 1000
    });

    await t.step('send-confirmation', {
      do: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { emailId: 'email_789' };
      },
      undo: async () => {}
    });
  });

  console.log('\n✅ Workflow completed successfully!\n');

  // Display collected metrics
  console.log('📊 Collected Metrics:');
  metrics.getMetrics().forEach(m => console.log(`  - ${m.type}: ${JSON.stringify(m)}`));

  console.log('\n' + '─'.repeat(60));
  console.log('\n🔍 Example 2: Workflow with timeout\n');
  console.log('─'.repeat(60));

  const metrics2 = new MetricsCollector();
  const events2: TransactionEvents = {
    ...events,
    onStepComplete: (stepName, result, durationMs) => {
      metrics2.recordStepDuration(stepName, durationMs);
    },
    onStepFailed: (stepName, error, attempt) => {
      metrics2.recordStepFailure(stepName, error, attempt);
    }
  };

  const tx2 = new Transaction('observable-workflow-2', storage, {
    events: events2,
    cleanupOnSuccess: true
  });

  try {
    await tx2.run(async (t) => {
      await t.step('quick-step', {
        do: async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 'success';
        },
        undo: async () => {}
      });

      await t.step('slow-step', {
        do: async () => {
          // This will timeout
          await new Promise(resolve => setTimeout(resolve, 500));
          return 'should-not-reach';
        },
        undo: async () => {
          console.log(`  🔄 Compensating slow-step`);
        },
        timeout: 100 // 100ms timeout
      });
    });
  } catch (error) {
    console.log(`\n⚠️  Workflow failed as expected (timeout triggered)\n`);
  }

  console.log('📊 Metrics for failed workflow:');
  metrics2.getMetrics().forEach(m => console.log(`  - ${m.type}: ${JSON.stringify(m)}`));

  console.log('\n' + '─'.repeat(60));
  console.log('\n🔍 Example 3: Workflow with retries\n');
  console.log('─'.repeat(60));

  const metrics3 = new MetricsCollector();
  const logger3 = new Logger();

  const tx3 = new Transaction('observable-workflow-3', storage, {
    events: {
      onStepRetry: (stepName, attempt, maxAttempts) => {
        logger3.warn(`Retry ${attempt}/${maxAttempts} for step: ${stepName}`);
      },
      onStepComplete: (stepName, result, durationMs) => {
        logger3.info(`Step succeeded: ${stepName}`, { durationMs });
        metrics3.recordStepDuration(stepName, durationMs);
      },
      onStepFailed: (stepName, error, attempt) => {
        metrics3.recordStepFailure(stepName, error, attempt);
      }
    },
    cleanupOnSuccess: true
  });

  let attempts = 0;

  await tx3.run(async (t) => {
    await t.step('flaky-api-call', {
      do: async () => {
        attempts++;
        console.log(`  🔄 Attempt ${attempts} to call API...`);

        if (attempts < 3) {
          throw new Error('API temporarily unavailable');
        }

        return { data: 'success', attempt: attempts };
      },
      undo: async () => {},
      retry: {
        attempts: 3,
        backoffMs: 100
      }
    });
  });

  console.log('\n✅ Flaky API call succeeded after retries!\n');
  console.log('📊 Retry metrics:');
  metrics3.getMetrics().forEach(m => console.log(`  - ${m.type}: ${JSON.stringify(m)}`));

  console.log('\n' + '═'.repeat(60));
  console.log('\n✨ Observability Demo Complete!\n');
  console.log('Key Features Demonstrated:');
  console.log('  ✅ Event hooks for logging');
  console.log('  ✅ Metrics collection');
  console.log('  ✅ Alerting integration');
  console.log('  ✅ Step timeouts');
  console.log('  ✅ Retry monitoring');
  console.log('  ✅ Compensation tracking\n');
}

// Run the example
runWithObservability().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
