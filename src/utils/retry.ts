// =============================================================================
// Klaviyo Flow Builder — Retry Logic
// =============================================================================

import { getLogger } from './logger';

export interface RetryOptions {
  /** Maximum number of attempts (including the first) */
  maxAttempts: number;
  /** Base delay between retries in ms */
  baseDelay: number;
  /** Multiply delay by this factor each retry (exponential backoff) */
  backoffFactor: number;
  /** Maximum delay cap in ms */
  maxDelay: number;
  /** Optional: only retry on these error types */
  retryableErrors?: string[];
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  backoffFactor: 2,
  maxDelay: 15000,
};

/**
 * Retry an async operation with exponential backoff.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const log = getLogger();
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await operation();
      if (attempt > 1) {
        log.info(`${label} succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (opts.retryableErrors && opts.retryableErrors.length > 0) {
        const isRetryable = opts.retryableErrors.some(
          (e) => lastError!.message.includes(e) || lastError!.name.includes(e),
        );
        if (!isRetryable) {
          log.error(`${label} failed with non-retryable error: ${lastError.message}`);
          throw lastError;
        }
      }

      if (attempt < opts.maxAttempts) {
        const delay = Math.min(
          opts.baseDelay * Math.pow(opts.backoffFactor, attempt - 1),
          opts.maxDelay,
        );
        log.warn(
          `${label} failed (attempt ${attempt}/${opts.maxAttempts}): ${lastError.message}. ` +
          `Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        log.error(
          `${label} failed after ${opts.maxAttempts} attempts: ${lastError.message}`,
        );
      }
    }
  }

  throw lastError!;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
