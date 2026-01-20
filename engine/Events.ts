/**
 * Event hooks for observability and monitoring of transaction execution.
 *
 * These hooks allow you to integrate with logging systems (Winston, Pino),
 * metrics platforms (Prometheus, Datadog), and alerting tools.
 *
 * @example
 * ```typescript
 * const tx = new Transaction('workflow-123', storage, {
 *   events: {
 *     onStepComplete: (step, result, duration) => {
 *       logger.info('Step completed', { step, duration });
 *       metrics.recordStepDuration(step, duration);
 *     },
 *     onStepFailed: (step, error, attempt) => {
 *       alerting.sendAlert(`Step ${step} failed: ${error.message}`);
 *     }
 *   }
 * });
 * ```
 */
export interface TransactionEvents {
  /**
   * Called when a transaction starts execution
   * @param transactionId - Unique transaction identifier
   */
  onTransactionStart?: (transactionId: string) => void;

  /**
   * Called when a transaction completes successfully
   * @param transactionId - Unique transaction identifier
   * @param durationMs - Total execution time in milliseconds
   */
  onTransactionComplete?: (transactionId: string, durationMs: number) => void;

  /**
   * Called when a transaction fails and begins rollback
   * @param transactionId - Unique transaction identifier
   * @param error - The error that caused the failure
   */
  onTransactionFailed?: (transactionId: string, error: Error) => void;

  /**
   * Called when a step begins execution
   * @param stepName - Name of the step
   * @param transactionId - Unique transaction identifier
   */
  onStepStart?: (stepName: string, transactionId: string) => void;

  /**
   * Called when a step completes successfully
   * @param stepName - Name of the step
   * @param result - The result returned by the step
   * @param durationMs - Step execution time in milliseconds
   */
  onStepComplete?: (stepName: string, result: any, durationMs: number) => void;

  /**
   * Called when a step fails
   * @param stepName - Name of the step
   * @param error - The error that caused the failure
   * @param attempt - Current attempt number (for retries)
   */
  onStepFailed?: (stepName: string, error: Error, attempt: number) => void;

  /**
   * Called when a step is being retried
   * @param stepName - Name of the step
   * @param attempt - Current attempt number
   * @param maxAttempts - Maximum retry attempts configured
   */
  onStepRetry?: (stepName: string, attempt: number, maxAttempts: number) => void;

  /**
   * Called when a step is skipped (already completed)
   * @param stepName - Name of the step
   * @param cachedResult - The cached result from previous execution
   */
  onStepSkipped?: (stepName: string, cachedResult: any) => void;

  /**
   * Called when compensation (undo) starts for a step
   * @param stepName - Name of the step being compensated
   * @param transactionId - Unique transaction identifier
   */
  onCompensationStart?: (stepName: string, transactionId: string) => void;

  /**
   * Called when compensation (undo) completes for a step
   * @param stepName - Name of the step that was compensated
   * @param durationMs - Compensation execution time in milliseconds
   */
  onCompensationComplete?: (stepName: string, durationMs: number) => void;

  /**
   * Called when compensation (undo) fails for a step
   * @param stepName - Name of the step
   * @param error - The error that occurred during compensation
   */
  onCompensationFailed?: (stepName: string, error: Error) => void;

  /**
   * Called when a step times out
   * @param stepName - Name of the step
   * @param timeoutMs - Timeout duration in milliseconds
   */
  onStepTimeout?: (stepName: string, timeoutMs: number) => void;

  /**
   * Called when a workflow enters dead_letter state
   * @param transactionId - Unique transaction identifier
   * @param error - Error context with step name and error details
   */
  onDeadLetter?: (transactionId: string, error: any) => void;
}

/**
 * Helper to safely call event hooks without throwing errors
 * @internal
 */
export function emitEvent<K extends keyof TransactionEvents>(
  events: TransactionEvents | undefined,
  eventName: K,
  ...args: Parameters<NonNullable<TransactionEvents[K]>>
): void {
  try {
    const handler = events?.[eventName];
    if (handler) {
      // @ts-ignore - TypeScript has trouble with this pattern
      handler(...args);
    }
  } catch (error) {
    // Silently catch event handler errors to prevent disrupting transaction flow
    console.error(`[TransactionAI] Event handler '${eventName}' threw an error:`, error);
  }
}
